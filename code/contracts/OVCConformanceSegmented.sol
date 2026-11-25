// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";

/**
 * OVC-Conformance (segmented) — machine-profile conformance (Stage 08).
 *
 * Claim: "G is a program for machine profile M, prints within the declared material window,
 * and deposits no material above the declared height H". Commitment = H~(G), the rolling
 * keccak of the plaintext chunks, as before.
 *
 * Two public records state the claim before bidding:
 *   - a machine profile M (travel envelope and command list), registered once by anyone
 *     under the hash of its contents and shared by every Demand that targets the machine;
 *   - a declaration D = (M, H, nozzle window, bed window), made by the Consumer for the
 *     plaintext commitment hG. A declaration cannot be changed, so a Provider who reads it
 *     before bidding knows exactly which predicate a dispute will evaluate.
 * Binding is unchanged: BindingPhase commits the claim on hG, and adjudication looks up the
 * Consumer's declaration for that hG.
 *
 * The predicate accepts iff, reading G line by line,
 *   (1) every line parses under the line grammar,
 *   (2) every command is in M's command list,
 *   (3) every motion endpoint and every arc lies in M's travel envelope,
 *   (4) every extruding move starts and ends at Z <= H,
 *   (5) no nozzle/bed setpoint exceeds D's maximum and the highest reaches D's minimum,
 *   (6) at least one move extrudes.
 * tests/lib/conformance-reference.js states the grammar and the machine model and is the
 * oracle this contract is tested against; the two are kept step-for-step identical.
 *
 * G is not deposited at binding. If the Provider disputes, the Consumer deposits G during the
 * dispute window; adjudication starts only when H~(deposited G) equals the commitment.
 * A trailing partial line is carried to the next chunk, so the verdict does not depend on
 * where the chunk boundaries fall.
 */
contract OVCConformanceSegmented is OVCBaseSegmented {

    int256 private constant SCALE = 1e5;

    uint8 private constant KIND_WORDS = 1;     // command with letter/number words
    uint8 private constant KIND_FREE_TEXT = 2; // command whose arguments are free text

    // Word bits: bit (letter - 'A').
    uint256 private constant B_E = 1 << 4;
    uint256 private constant B_F = 1 << 5;
    uint256 private constant B_I = 1 << 8;
    uint256 private constant B_J = 1 << 9;
    uint256 private constant B_P = 1 << 15;
    uint256 private constant B_R = 1 << 17;
    uint256 private constant B_S = 1 << 18;
    uint256 private constant B_X = 1 << 23;
    uint256 private constant B_Y = 1 << 24;
    uint256 private constant B_Z = 1 << 25;
    uint256 private constant MOTION_WORDS = B_X | B_Y | B_Z | B_E | B_F;
    uint256 private constant ARC_WORDS = MOTION_WORDS | B_I | B_J | B_P;
    uint256 private constant HOME_WORDS = B_X | B_Y | B_Z;

    struct Machine {
        int64 xMin; int64 xMax; int64 yMin; int64 yMax;
        int64 zMin; int64 zMax;
        bool registered;
    }

    struct Declaration {
        bytes32 machine;
        int64 hMax;
        int64 nozzleMin; int64 nozzleMax;
        int64 bedMin; int64 bedMax;
        uint64 declaredAt;
    }

    // Per-claim machine state carried between chunks.
    struct ConfState {
        bool initialized;
        bool violated;
        bool extruded;
        bool posRel;
        bool eRel;
        uint8 known;          // bit 0 X, 1 Y, 2 Z
        int64 x; int64 y; int64 z;
        int64 eDatum;
        int64 peakNozzle;
        int64 peakBed;
        bytes tail;           // trailing partial line carried to the next chunk
    }

    // Working copy for one chunk, kept in memory to avoid stack depth limits.
    struct Ctx {
        bytes32 machine;
        int256 xMin; int256 xMax; int256 yMin; int256 yMax; int256 zMin; int256 zMax;
        int256 hMax;
        bool violated; bool extruded; bool posRel; bool eRel;
        uint256 known;
        int256 x; int256 y; int256 z;
        int256 eDatum; int256 peakNozzle; int256 peakBed;
        // current line
        uint256 seen;         // word letters present
        uint256 valued;       // word letters that carry a number
        int256[26] val;
    }

    mapping(bytes32 => Machine) public machines;
    mapping(bytes32 => mapping(uint256 => uint8)) public commandKind;
    mapping(address => mapping(bytes32 => Declaration)) public declarations;
    mapping(uint256 => ConfState) public confState;

    event MachineRegistered(bytes32 indexed machineId);
    event ConformanceDeclared(address indexed consumer, bytes32 indexed hG, bytes32 indexed machineId);

    constructor(uint256 _disputeWindowBlocks) OVCBaseSegmented(_disputeWindowBlocks) {}

    // ── Claim statement ──────────────────────────────────────────────────────

    /// Command key: letter << 24 | code << 4 | (sub-code + 1, or 0 without one).
    function commandKey(uint8 letter, uint256 code, uint256 subPlusOne) public pure returns (uint256) {
        return (uint256(letter) << 24) | (code << 4) | subPlusOne;
    }

    /**
     * Register a machine profile. envelope = [xMin, xMax, yMin, yMax, zMin, zMax], scaled 1e5.
     * Idempotent: the id is the hash of the contents.
     */
    function registerMachine(
        int64[6] calldata envelope,
        uint256[] calldata keys,
        uint8[] calldata kinds
    ) external returns (bytes32 machineId) {
        require(keys.length == kinds.length, "Length mismatch");
        require(envelope[0] <= envelope[1] && envelope[2] <= envelope[3] && envelope[4] <= envelope[5], "Empty envelope");
        machineId = keccak256(abi.encode(envelope, keys, kinds));
        Machine storage m = machines[machineId];
        if (m.registered) return machineId;
        for (uint256 k = 0; k < keys.length; k++) {
            require(kinds[k] == KIND_WORDS || kinds[k] == KIND_FREE_TEXT, "Bad kind");
            commandKind[machineId][keys[k]] = kinds[k];
        }
        m.xMin = envelope[0]; m.xMax = envelope[1];
        m.yMin = envelope[2]; m.yMax = envelope[3];
        m.zMin = envelope[4]; m.zMax = envelope[5];
        m.registered = true;
        emit MachineRegistered(machineId);
    }

    /**
     * Declare the conformance claim for plaintext commitment hG. temps = [nozzleMin, nozzleMax,
     * bedMin, bedMax]; hMax and temps scaled 1e5. Made once, before bidding; never changed.
     */
    function declare(bytes32 hG, bytes32 machineId, int64 hMax, int64[4] calldata temps) external {
        require(machines[machineId].registered, "Unknown machine");
        Declaration storage d = declarations[msg.sender][hG];
        require(d.machine == bytes32(0), "Already declared");
        d.machine = machineId;
        d.hMax = hMax;
        d.nozzleMin = temps[0]; d.nozzleMax = temps[1];
        d.bedMin = temps[2]; d.bedMax = temps[3];
        d.declaredAt = uint64(block.number);
        emit ConformanceDeclared(msg.sender, hG, machineId);
    }

    // ── Claim lifecycle ──────────────────────────────────────────────────────

    // No deposit required at binding — G is revealed only if disputed.
    function acceptClaim(uint256 claimId) external override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function acceptClaimFor(uint256 claimId, address provider) external override onlyCoordinator {
        require(claims[claimId].provider == provider, "Wrong provider");
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function disputeClaim(uint256 claimId) external payable override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        _escrowReimbursement(claimId);
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // G must be fully deposited (H~(G) == commitment) and the claim declared before
    // adjudication starts. An undeclared claim cannot start and resolves as Withheld.
    function startAdjudication(uint256 claimId) external override onlyClaimant(claimId) {
        require(isDepositComplete(claimId), "Deposit not complete");
        Claim storage c = claims[claimId];
        require(declarations[c.claimant][c.commitment].machine != bytes32(0), "Not declared");
        _startAdjudication(claimId);
    }

    // ── Predicate ────────────────────────────────────────────────────────────

    function _processChunk(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage session,
        bytes storage chunk
    ) internal override {
        ConfState storage st = confState[claimId];
        if (st.violated) return;

        Ctx memory c = _load(st, declarations[claim.claimant][claim.commitment]);

        bytes memory tail = st.tail;
        uint256 tlen = tail.length;
        uint256 clen = chunk.length;
        bytes memory buf = new bytes(tlen + clen);
        for (uint256 k = 0; k < tlen; k++) buf[k] = tail[k];
        for (uint256 k = 0; k < clen; k++) buf[tlen + k] = chunk[k];

        bool isLastChunk = session.nextChunkIndex + 1 == depositedChunkCount[claimId];
        uint256 len = buf.length;
        uint256 lineStart = 0;
        for (uint256 i = 0; i < len; i++) {
            if (_at(buf, i) == 0x0a) {
                _line(buf, lineStart, i, c);
                lineStart = i + 1;
                if (c.violated) break;
            }
        }

        if (c.violated) {
            st.violated = true;
            if (st.tail.length != 0) delete st.tail;
            return;
        }
        if (isLastChunk) {
            if (lineStart < len) _line(buf, lineStart, len, c);
            if (st.tail.length != 0) delete st.tail;
        } else {
            uint256 rem = len - lineStart;
            bytes memory carry = new bytes(rem);
            for (uint256 k = 0; k < rem; k++) carry[k] = buf[lineStart + k];
            st.tail = carry;
        }
        _store(st, c);
    }

    function _finalizePredicate(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage /* session */
    ) internal view override returns (bool) {
        ConfState storage st = confState[claimId];
        Declaration storage d = declarations[claim.claimant][claim.commitment];
        if (st.violated || !st.extruded) return false;
        if (st.peakNozzle < d.nozzleMin || st.peakNozzle > d.nozzleMax) return false;
        if (st.peakBed < d.bedMin || st.peakBed > d.bedMax) return false;
        return true;
    }

    // ── State transfer ───────────────────────────────────────────────────────

    function _load(ConfState storage st, Declaration storage d) private view returns (Ctx memory c) {
        Machine storage m = machines[d.machine];
        c.machine = d.machine;
        c.xMin = m.xMin; c.xMax = m.xMax; c.yMin = m.yMin; c.yMax = m.yMax;
        c.zMin = m.zMin; c.zMax = m.zMax;
        c.hMax = d.hMax;
        if (st.initialized) {
            c.extruded = st.extruded; c.posRel = st.posRel; c.eRel = st.eRel;
            c.known = st.known;
            c.x = st.x; c.y = st.y; c.z = st.z;
            c.eDatum = st.eDatum; c.peakNozzle = st.peakNozzle; c.peakBed = st.peakBed;
        }
    }

    function _store(ConfState storage st, Ctx memory c) private {
        st.initialized = true;
        st.extruded = c.extruded; st.posRel = c.posRel; st.eRel = c.eRel;
        st.known = uint8(c.known);
        st.x = int64(c.x); st.y = int64(c.y); st.z = int64(c.z);
        st.eDatum = int64(c.eDatum); st.peakNozzle = int64(c.peakNozzle); st.peakBed = int64(c.peakBed);
    }

    // ── Line grammar ─────────────────────────────────────────────────────────

    function _at(bytes memory b, uint256 i) private pure returns (uint256 r) {
        assembly { r := byte(0, mload(add(add(b, 32), i))) }
    }

    function _isWs(uint256 b) private pure returns (bool) {
        return b == 0x20 || b == 0x09 || b == 0x0d;
    }

    function _isDigit(uint256 b) private pure returns (bool) {
        return b >= 0x30 && b <= 0x39;
    }

    function _isUpper(uint256 b) private pure returns (bool) {
        return b >= 0x41 && b <= 0x5a;
    }

    /// number := ['+'|'-'] ( digit{1,9} ['.' digit*] | '.' digit+ ), scaled 1e5, truncated.
    function _number(bytes memory buf, uint256 i, uint256 end)
        private pure returns (bool ok, int256 v, uint256 next)
    {
        bool neg = false;
        uint256 b = _at(buf, i);
        if (b == 0x2d || b == 0x2b) { neg = b == 0x2d; i++; }
        uint256 intPart = 0; uint256 intDigits = 0;
        uint256 frac = 0; uint256 fracDigits = 0;
        bool any = false;
        while (i < end && _isDigit(_at(buf, i))) {
            if (++intDigits > 9) return (false, 0, i);
            intPart = intPart * 10 + (_at(buf, i) - 0x30);
            i++; any = true;
        }
        if (i < end && _at(buf, i) == 0x2e) {
            i++;
            while (i < end && _isDigit(_at(buf, i))) {
                if (fracDigits < 5) { frac = frac * 10 + (_at(buf, i) - 0x30); fracDigits++; }
                i++; any = true;
            }
        }
        if (!any) return (false, 0, i);
        while (fracDigits < 5) { frac *= 10; fracDigits++; }
        v = int256(intPart * uint256(SCALE) + frac);
        return (true, neg ? -v : v, i);
    }

    function _line(bytes memory buf, uint256 start, uint256 end, Ctx memory c) private view {
        for (uint256 k = start; k < end; k++) {
            if (_at(buf, k) == 0x3b) { end = k; break; }   // ';'
        }
        uint256 i = start;
        while (i < end && _isWs(_at(buf, i))) i++;
        if (i >= end) return;

        (bool ok, uint256 key, uint256 next) = _command(buf, i, end);
        if (!ok) { c.violated = true; return; }
        uint8 kind = commandKind[c.machine][key];
        if (kind == 0) { c.violated = true; return; }
        if (kind == KIND_FREE_TEXT) {
            if (!_freeText(buf, next, end)) c.violated = true;
            return;
        }
        if (!_words(buf, next, end, c)) { c.violated = true; return; }
        _apply(key >> 24, (key >> 4) & 0xfffff, key & 0xf, c);
    }

    /// command := ('G' | 'M' | 'T') digit{1,4} [ '.' digit ]; returns its key.
    function _command(bytes memory buf, uint256 i, uint256 end)
        private pure returns (bool, uint256, uint256)
    {
        uint256 letter = _at(buf, i);
        if (letter != 0x47 && letter != 0x4d && letter != 0x54) return (false, 0, i);
        i++;
        uint256 code = 0; uint256 digits = 0;
        while (i < end && _isDigit(_at(buf, i))) {
            if (++digits > 4) return (false, 0, i);
            code = code * 10 + (_at(buf, i) - 0x30); i++;
        }
        if (digits == 0) return (false, 0, i);
        uint256 subPlusOne = 0;
        if (i < end && _at(buf, i) == 0x2e) {
            i++;
            if (!(i < end && _isDigit(_at(buf, i)))) return (false, 0, i);
            subPlusOne = _at(buf, i) - 0x30 + 1; i++;
            if (i < end && _isDigit(_at(buf, i))) return (false, 0, i);
        }
        return (true, (letter << 24) | (code << 4) | subPlusOne, i);
    }

    function _freeText(bytes memory buf, uint256 i, uint256 end) private pure returns (bool) {
        for (; i < end; i++) {
            uint256 b = _at(buf, i);
            if ((b < 0x20 && b != 0x09 && b != 0x0d) || b > 0x7e) return false;
        }
        return true;
    }

    /// ( ws* word )* ws*, word := 'A'..'Z' [ number ], each letter at most once.
    function _words(bytes memory buf, uint256 i, uint256 end, Ctx memory c) private pure returns (bool) {
        if (i < end && !_isWs(_at(buf, i)) && !_isUpper(_at(buf, i))) return false;
        c.seen = 0; c.valued = 0;
        while (true) {
            while (i < end && _isWs(_at(buf, i))) i++;
            if (i >= end) return true;
            uint256 w = _at(buf, i);
            if (!_isUpper(w)) return false;
            uint256 bit = 1 << (w - 0x41);
            if (c.seen & bit != 0) return false;
            c.seen |= bit;
            i++;
            if (i < end) {
                uint256 b = _at(buf, i);
                if (_isDigit(b) || b == 0x2d || b == 0x2b || b == 0x2e) {
                    (bool ok, int256 v, uint256 next) = _number(buf, i, end);
                    if (!ok) return false;
                    c.val[w - 0x41] = v; c.valued |= bit; i = next;
                }
            }
        }
        return true;
    }

    function _apply(uint256 letter, uint256 code, uint256 subPlusOne, Ctx memory c) private pure {
        if (letter == 0x47) { // 'G'
            if (subPlusOne != 0) return;
            if (code <= 3) { _motion(code, c); return; }
            if (code == 90) { c.posRel = false; c.eRel = false; return; }
            if (code == 91) { c.posRel = true; c.eRel = true; return; }
            if (code == 92) {
                if (c.seen & ~B_E != 0) { c.violated = true; return; }
                if (c.seen & B_E != 0) {
                    if (c.valued & B_E == 0) { c.violated = true; return; }
                    c.eDatum = c.val[4];
                }
                return;
            }
            if (code == 28) {
                if (c.seen & ~HOME_WORDS != 0) { c.violated = true; return; }
                if (c.seen == 0) c.known = 0;
                else c.known &= ~(((c.seen >> 23) & 1) | (((c.seen >> 24) & 1) << 1) | (((c.seen >> 25) & 1) << 2));
                return;
            }
            return;
        }
        if (letter == 0x4d && subPlusOne == 0) { // 'M'
            if (code == 82) { c.eRel = false; return; }
            if (code == 83) { c.eRel = true; return; }
            bool nozzle = code == 104 || code == 109;
            bool bed = code == 140 || code == 190;
            if (!(nozzle || bed)) return;
            for (uint256 t = 0; t < 2; t++) {
                uint256 bit = t == 0 ? B_S : B_R;
                if (c.seen & bit == 0) continue;
                if (c.valued & bit == 0) { c.violated = true; return; }
                int256 v = c.val[t == 0 ? 18 : 17];
                if (nozzle) { if (v > c.peakNozzle) c.peakNozzle = v; }
                else if (v > c.peakBed) c.peakBed = v;
            }
        }
    }

    // ── Machine model ────────────────────────────────────────────────────────

    function _motion(uint256 code, Ctx memory c) private pure {
        bool arc = code >= 2;
        if (c.seen & ~(arc ? ARC_WORDS : MOTION_WORDS) != 0) { c.violated = true; return; }
        if (c.seen & ~c.valued != 0) { c.violated = true; return; }

        int256 startZ = c.z;
        bool startZKnown = c.known & 4 != 0;
        int256 sx = c.x; int256 sy = c.y;
        bool startXYKnown = c.known & 3 == 3;

        int256[3] memory pos = [c.x, c.y, c.z];
        int256[3] memory lo = [c.xMin, c.yMin, c.zMin];
        int256[3] memory hi = [c.xMax, c.yMax, c.zMax];
        for (uint256 a = 0; a < 3; a++) {
            uint256 idx = 23 + a;                        // X, Y, Z
            if (c.seen & (1 << idx) == 0) continue;
            int256 t = c.val[idx];
            if (c.posRel) {
                if (c.known & (1 << a) == 0) { c.violated = true; return; }
                t = pos[a] + t;
            }
            if (t < lo[a] || t > hi[a]) { c.violated = true; return; }
            pos[a] = t;
            c.known |= 1 << a;
        }

        if (arc) {
            if (c.seen & (B_I | B_J) == 0) { c.violated = true; return; }
            if (!startXYKnown) { c.violated = true; return; }
            if (!_arcInside(code, sx, sy, pos[0], pos[1], c)) { c.violated = true; return; }
        }

        bool extruding = false;
        if (c.seen & B_E != 0) {
            int256 e = c.val[4];
            int256 delta = c.eRel ? e : e - c.eDatum;
            if (!c.eRel) c.eDatum = e;
            extruding = delta > 0;
        }
        if (extruding) {
            if (!startZKnown || c.known & 4 == 0) { c.violated = true; return; }
            if (startZ > c.hMax || pos[2] > c.hMax) { c.violated = true; return; }
            c.extruded = true;
        }
        c.x = pos[0]; c.y = pos[1]; c.z = pos[2];
    }

    /// Exact arc-in-envelope test: an axis extreme of the circle is checked iff the arc sweeps it.
    function _arcInside(uint256 code, int256 sx, int256 sy, int256 ex, int256 ey, Ctx memory c)
        private pure returns (bool)
    {
        int256 I = c.seen & B_I != 0 ? c.val[8] : int256(0);
        int256 J = c.seen & B_J != 0 ? c.val[9] : int256(0);
        int256 cx = sx + I;
        int256 cy = sy + J;
        int256 r2 = I * I + J * J;
        int256[2] memory u = [-I, -J];
        int256[2] memory v = [ex - cx, ey - cy];
        if (code == 2) (u, v) = (v, u);              // G2 from u to v is G3 from v to u
        bool full = c.seen & B_P != 0 && c.val[15] != 0;

        int256[2][4] memory dirs = [[int256(1), int256(0)], [int256(-1), int256(0)],
                                    [int256(0), int256(1)], [int256(0), int256(-1)]];
        int256[4] memory room = [c.xMax - cx, cx - c.xMin, c.yMax - cy, cy - c.yMin];
        for (uint256 k = 0; k < 4; k++) {
            if (!(full || _ccwSweeps(u, v, dirs[k]))) continue;
            if (room[k] < 0 || room[k] * room[k] < r2) return false;
        }
        return true;
    }

    function _cross(int256[2] memory a, int256[2] memory b) private pure returns (int256) {
        return a[0] * b[1] - a[1] * b[0];
    }

    /// Does the counter-clockwise sweep from u to v pass direction d? Mirrors ccwSweeps().
    function _ccwSweeps(int256[2] memory u, int256[2] memory v, int256[2] memory d)
        private pure returns (bool)
    {
        int256 uv = _cross(u, v);
        if (uv > 0) return _cross(u, d) >= 0 && _cross(d, v) >= 0;
        if (uv < 0) return !(_cross(v, d) > 0 && _cross(d, u) > 0);
        if (u[0] * v[0] + u[1] * v[1] > 0) return true;
        return _cross(u, d) >= 0;
    }
}
