// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";

/**
 * OVC-Feature (segmented)
 *
 * Commitment = H̃(G) — rolling keccak of plaintext G chunks.
 * claimValue  = f_claim, the net filament consumption of the committed artifact in
 *               millimetres, fixed-point scaled by 1e5 (5 decimals, matching the
 *               precision slicers emit). Signed internally; the claim is a uint256
 *               because a physically meaningful total is non-negative.
 *
 * f(G) = Σ ΔE over all G0/G1 motion commands, evaluated against a stateful
 * G-code machine model:
 *
 *   - M82 / M83 select absolute / relative extrusion and may switch mid-file.
 *     Marlin powers up absolute, so that is the initial state.
 *   - G92 E<v> re-datums the extruder axis without extruding. Stock slicer
 *     profiles emit thousands of these, which is why "final E" is not the total.
 *   - E fields are signed; retractions subtract and their re-prime adds back, so
 *     the net sum is the physically consumed filament.
 *   - E fields on non-motion commands are ignored. This matters: `M907 E538`
 *     (extruder motor current) appears in stock Prusa end-G-code and a
 *     context-free byte scan would read it as an extrusion value.
 *
 * Chunk-boundary soundness: the claimant chooses the chunking, so a parser that
 * treated each chunk independently could be gamed by splitting a command across a
 * boundary. Any trailing partial line is therefore buffered in `tail` and
 * prepended to the next chunk, making f(G) invariant under chunking.
 */
contract OVCFeatureSegmented is OVCBaseSegmented {

    uint256 private constant SCALE = 1e5;

    struct FeatureState {
        bool    initialized;
        bool    absolute;   // M82 active
        int256  datum;      // last absolute E position, scaled
        int256  total;      // accumulated net extrusion, scaled
        bytes   tail;       // trailing partial line carried to the next chunk
    }

    mapping(uint256 => FeatureState) public featureState;

    constructor(uint256 _disputeWindowBlocks) OVCBaseSegmented(_disputeWindowBlocks) {}

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

    function disputeClaim(uint256 claimId) external override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // G must be fully deposited (H̃(G) == commitment) before adjudication starts.
    function startAdjudication(uint256 claimId) external override onlyClaimant(claimId) {
        require(isDepositComplete(claimId), "Deposit not complete");
        _startAdjudication(claimId);
    }

    // ── Predicate ────────────────────────────────────────────────────────────

    function _processChunk(
        uint256 claimId,
        Claim storage /* claim */,
        AdjudicationSession storage session,
        bytes storage chunk
    ) internal override {
        FeatureState storage st = featureState[claimId];
        if (!st.initialized) {
            st.initialized = true;
            st.absolute = true; // Marlin default
        }

        // Copy carried tail + chunk into memory once. Parsing from memory avoids a
        // per-byte SLOAD and dominates the cost profile of this predicate.
        bytes memory tail = st.tail;
        uint256 tlen = tail.length;
        uint256 clen = chunk.length;
        bytes memory buf = new bytes(tlen + clen);
        for (uint256 k = 0; k < tlen; k++) buf[k] = tail[k];
        for (uint256 k = 0; k < clen; k++) buf[tlen + k] = chunk[k];

        bool isLastChunk = session.nextChunkIndex + 1 == depositedChunkCount[claimId];

        uint256 len = buf.length;
        uint256 lineStart = 0;
        int256 datum = st.datum;
        int256 total = st.total;
        bool absolute = st.absolute;

        for (uint256 i = 0; i < len; i++) {
            if (buf[i] == 0x0a) { // '\n'
                (absolute, datum, total) = _processLine(buf, lineStart, i, absolute, datum, total);
                lineStart = i + 1;
            }
        }

        if (isLastChunk) {
            // No further chunks can complete a partial line — evaluate what remains.
            if (lineStart < len) {
                (absolute, datum, total) = _processLine(buf, lineStart, len, absolute, datum, total);
            }
            if (st.tail.length != 0) delete st.tail;
        } else {
            uint256 rem = len - lineStart;
            bytes memory carry = new bytes(rem);
            for (uint256 k = 0; k < rem; k++) carry[k] = buf[lineStart + k];
            st.tail = carry;
        }

        st.absolute = absolute;
        st.datum = datum;
        st.total = total;
    }

    function _finalizePredicate(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage /* session */
    ) internal view override returns (bool) {
        int256 total = featureState[claimId].total;
        if (total < 0) return false; // physically impossible; never matches a claim
        return uint256(total) == claim.claimValue;
    }

    // Evaluate one line [start, end) and return the updated machine state.
    function _processLine(
        bytes memory buf,
        uint256 start,
        uint256 end,
        bool absolute,
        int256 datum,
        int256 total
    ) private pure returns (bool, int256, int256) {
        // Truncate at a comment marker.
        for (uint256 i = start; i < end; i++) {
            if (buf[i] == 0x3b) { end = i; break; } // ';'
        }
        // Skip leading whitespace.
        while (start < end && (buf[start] == 0x20 || buf[start] == 0x09 || buf[start] == 0x0d)) start++;
        if (start >= end) return (absolute, datum, total);

        bytes1 letter = buf[start];
        if (letter != 0x47 && letter != 0x4d) return (absolute, datum, total); // not 'G' or 'M'

        uint256 j = start + 1;
        uint256 code = 0;
        bool hasCode = false;
        while (j < end && buf[j] >= 0x30 && buf[j] <= 0x39) {
            code = code * 10 + uint256(uint8(buf[j]) - 48);
            hasCode = true;
            j++;
        }
        if (!hasCode) return (absolute, datum, total);

        if (letter == 0x4d) { // 'M'
            if (code == 82) return (true, datum, total);
            if (code == 83) return (false, datum, total);
            return (absolute, datum, total); // M907 E538 and friends are not extrusion
        }

        // letter == 'G'
        if (code != 0 && code != 1 && code != 92) return (absolute, datum, total);

        (int256 value, bool found) = _findEField(buf, j, end);
        if (!found) return (absolute, datum, total);

        if (code == 92) {
            // Re-datum only; G92 never extrudes. In relative mode it has no effect
            // on the accumulated total either.
            return (absolute, value, total);
        }

        if (absolute) {
            total += value - datum;
            datum = value;
        } else {
            total += value;
        }
        return (absolute, datum, total);
    }

    // Find a word-initial `E` parameter in [pos, end) and parse it as a signed
    // fixed-point value scaled by SCALE. Word-initial means preceded by whitespace,
    // so the 'E' inside a token such as `E1.5` is a parameter but a stray letter in
    // the middle of a word is not.
    function _findEField(
        bytes memory buf,
        uint256 pos,
        uint256 end
    ) private pure returns (int256 value, bool found) {
        for (uint256 i = pos; i < end; i++) {
            if (buf[i] != 0x45) continue; // 'E'
            if (i > 0) {
                bytes1 prev = buf[i - 1];
                if (prev != 0x20 && prev != 0x09) continue; // not word-initial
            }

            uint256 j = i + 1;
            bool negative = false;
            if (j < end && (buf[j] == 0x2d || buf[j] == 0x2b)) { // '-' / '+'
                negative = (buf[j] == 0x2d);
                j++;
            }

            uint256 intPart = 0;
            uint256 fracPart = 0;
            uint256 fracDigits = 0;
            bool inFraction = false;
            bool hasDigits = false;

            while (j < end) {
                bytes1 ch = buf[j];
                if (ch >= 0x30 && ch <= 0x39) {
                    hasDigits = true;
                    if (inFraction) {
                        // Slicers emit up to 5 decimals; ignore any beyond SCALE.
                        if (fracDigits < 5) {
                            fracPart = fracPart * 10 + uint256(uint8(ch) - 48);
                            fracDigits++;
                        }
                    } else {
                        intPart = intPart * 10 + uint256(uint8(ch) - 48);
                    }
                    j++;
                } else if (ch == 0x2e && !inFraction) { // '.' — note PrusaSlicer emits `E.91934`
                    inFraction = true;
                    j++;
                } else {
                    break;
                }
            }
            if (!hasDigits) continue;

            uint256 scaled = intPart * SCALE;
            while (fracDigits < 5) { fracPart *= 10; fracDigits++; }
            scaled += fracPart;

            value = negative ? -int256(scaled) : int256(scaled);
            return (value, true);
        }
        return (0, false);
    }
}
