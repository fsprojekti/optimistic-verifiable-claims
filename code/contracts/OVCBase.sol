// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract OVCBase {
    enum State {
        None,
        Committed,
        Accepted,
        Disputed,
        Resolved
    }

    enum Outcome {
        None,
        Accepted,
        Valid,
        Inconsistent,
        Incorrect,
        Withheld
    }

    struct Claim {
        address claimant;
        address provider;
        bytes32 commitment;
        bytes32 auxHash;
        uint256 claimValue;
        bytes32 providerKeyHash;
        State state;
        Outcome outcome;
    }

    // Fixed-point scale for E-coordinates: 5 decimals, matching the precision
    // slicers emit. At 3 decimals, truncation accumulates across ~10^5 motion
    // commands into an error of order 1% of the total.
    uint256 internal constant E_SCALE = 1e5;

    uint256 public claimCount;
    uint256 public immutable disputeWindowBlocks;
    address public coordinator;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => uint256) public disputeDeadline;

    event ClaimCommitted(uint256 indexed claimId, address indexed claimant, address indexed provider);
    event ClaimAccepted(uint256 indexed claimId);
    event ClaimDisputed(uint256 indexed claimId);
    event ClaimRevealed(uint256 indexed claimId, Outcome outcome);
    event ClaimWithheld(uint256 indexed claimId);

    constructor(uint256 _disputeWindowBlocks) {
        require(_disputeWindowBlocks > 0, "Window must be > 0");
        disputeWindowBlocks = _disputeWindowBlocks;
    }

    modifier onlyCoordinator() {
        require(msg.sender == coordinator && coordinator != address(0), "Only coordinator");
        _;
    }

    // Called once after deployment to register the BindingPhase coordinator.
    function setCoordinator(address _coordinator) external {
        require(coordinator == address(0), "Already set");
        require(_coordinator != address(0), "Zero address");
        coordinator = _coordinator;
    }

    modifier onlyClaimant(uint256 claimId) {
        require(claims[claimId].claimant == msg.sender, "Only claimant");
        _;
    }

    modifier onlyProvider(uint256 claimId) {
        require(claims[claimId].provider == msg.sender, "Only provider");
        _;
    }

    function _commitClaim(
        address claimant,
        address provider,
        bytes32 commitment,
        bytes32 auxHash,
        uint256 claimValue,
        bytes32 providerKeyHash
    ) internal returns (uint256 claimId) {
        require(provider != address(0), "Provider required");
        claimId = ++claimCount;
        claims[claimId] = Claim({
            claimant: claimant,
            provider: provider,
            commitment: commitment,
            auxHash: auxHash,
            claimValue: claimValue,
            providerKeyHash: providerKeyHash,
            state: State.Committed,
            outcome: Outcome.None
        });
        emit ClaimCommitted(claimId, claimant, provider);
    }

    function commitClaim(
        address provider,
        bytes32 commitment,
        bytes32 auxHash,
        uint256 claimValue,
        bytes32 providerKeyHash
    ) external returns (uint256 claimId) {
        return _commitClaim(msg.sender, provider, commitment, auxHash, claimValue, providerKeyHash);
    }

    // Called by BindingPhase to commit on behalf of a consumer atomically with
    // all other OVC instances. Ensures claimant is the actual consumer, not the coordinator.
    function commitClaimFor(
        address claimant,
        address provider,
        bytes32 commitment,
        bytes32 auxHash,
        uint256 claimValue,
        bytes32 providerKeyHash
    ) external onlyCoordinator returns (uint256 claimId) {
        return _commitClaim(claimant, provider, commitment, auxHash, claimValue, providerKeyHash);
    }

    // Called by BindingPhase to accept on behalf of a provider atomically.
    function acceptClaimFor(uint256 claimId, address provider) external onlyCoordinator {
        require(claims[claimId].provider == provider, "Wrong provider");
        Claim storage claim = claims[claimId];
        require(claim.state == State.Committed, "Not committed");
        claim.state = State.Accepted;
        claim.outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function acceptClaim(uint256 claimId) external onlyProvider(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Committed, "Not committed");
        claim.state = State.Accepted;
        claim.outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function disputeClaim(uint256 claimId) external onlyProvider(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Committed, "Not committed");
        claim.state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    function revealWitness(uint256 claimId, bytes calldata witness) public virtual onlyClaimant(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");

        bytes32 witnessHash = keccak256(witness);
        if (witnessHash != claim.commitment) {
            claim.outcome = Outcome.Inconsistent;
            claim.state = State.Resolved;
            emit ClaimRevealed(claimId, claim.outcome);
            return;
        }

        bool predicateOk = _verifyPredicate(claimId, claim, witness);
        claim.outcome = predicateOk ? Outcome.Valid : Outcome.Incorrect;
        claim.state = State.Resolved;
        emit ClaimRevealed(claimId, claim.outcome);
    }

    function refuseWitness(uint256 claimId) external onlyClaimant(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        claim.state = State.Resolved;
        claim.outcome = Outcome.Withheld;
        emit ClaimWithheld(claimId);
    }

    /// @notice Anyone may call this once the dispute window has expired without a witness.
    function resolveWithheld(uint256 claimId) external {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        require(block.number > disputeDeadline[claimId], "Dispute window still open");
        claim.state = State.Resolved;
        claim.outcome = Outcome.Withheld;
        emit ClaimWithheld(claimId);
    }

    function _verifyPredicate(uint256 claimId, Claim storage claim, bytes calldata witness) internal view virtual returns (bool);

    function _isGcode(bytes calldata data) internal pure returns (bool) {
        if (data.length < 2) {
            return false;
        }
        for (uint256 i = 0; i + 1 < data.length; i++) {
            if (data[i] == "G") {
                bytes1 next = data[i + 1];
                if (next == "0" || next == "1") {
                    return true;
                }
            }
        }
        return false;
    }

    // Net filament consumption f(G) = Î£ Î”E over G0-G3 motion commands, evaluated
    // against a stateful G-code machine model, scaled by E_SCALE.
    //
    //   - M82 / M83 select absolute / relative extrusion, switchable mid-file.
    //     Marlin powers up absolute, so that is the initial state.
    //   - G92 E<v> re-datums the extruder axis without extruding. Stock slicer
    //     profiles emit thousands of these, which is why the final E-value is
    //     NOT the cumulative total on real G-code.
    //   - E fields are signed: a retraction subtracts and its re-prime adds back,
    //     so the net sum is the filament actually consumed.
    //   - E fields on non-motion commands are ignored. `M907 E538` (extruder motor
    //     current) appears in stock Prusa end-G-code and a context-free byte scan
    //     would read it as an extrusion value.
    //
    // OVCFeatureSegmented implements the same model chunk-wise; both agree on any
    // witness. Kept in sync deliberately â€” divergence would let the two designs
    // return different verdicts on identical input.
    // Extruder machine state, threaded through the scan. Held in a struct so the
    // per-line evaluator stays within the EVM's 16-slot stack depth.
    struct EMachine {
        bool   absolute; // M82 active
        int256 datum;    // last absolute E position, scaled
        int256 total;    // accumulated net extrusion, scaled
    }

    function _netExtrusion(bytes calldata data) internal pure returns (int256) {
        EMachine memory m = EMachine({ absolute: true, datum: 0, total: 0 });
        uint256 len = data.length;
        uint256 lineStart = 0;

        for (uint256 i = 0; i <= len; i++) {
            if (i == len || data[i] == 0x0a) { // '\n' or end of witness
                _feedLine(data, lineStart, i, m);
                lineStart = i + 1;
            }
        }
        return m.total;
    }

    // Evaluate one line [start, end), updating the machine state in place.
    function _feedLine(
        bytes calldata data,
        uint256 start,
        uint256 end,
        EMachine memory m
    ) private pure {
        for (uint256 i = start; i < end; i++) {
            if (data[i] == 0x3b) { end = i; break; } // ';' comment
        }
        while (start < end && (data[start] == 0x20 || data[start] == 0x09 || data[start] == 0x0d)) start++;
        if (start >= end) return;

        bytes1 letter = data[start];
        if (letter != 0x47 && letter != 0x4d) return; // 'G' / 'M'

        uint256 j = start + 1;
        uint256 code = 0;
        bool hasCode = false;
        while (j < end && data[j] >= 0x30 && data[j] <= 0x39) {
            code = code * 10 + uint256(uint8(data[j]) - 48);
            hasCode = true;
            j++;
        }
        if (!hasCode) return;

        if (letter == 0x4d) { // 'M'
            if (code == 82) m.absolute = true;
            else if (code == 83) m.absolute = false;
            return; // M907 E538 and friends are not extrusion
        }

        // G0/G1 linear and G2/G3 arc moves all extrude; slicer arc fitting emits G2/G3 with E.
        if (code > 3 && code != 92) return;

        (int256 value, bool found) = _findEField(data, j, end);
        if (!found) return;

        if (code == 92) {
            m.datum = value; // re-datum only; never extrudes
        } else if (m.absolute) {
            m.total += value - m.datum;
            m.datum = value;
        } else {
            m.total += value;
        }
    }

    // Word-initial `E` parameter in [pos, end), parsed as signed fixed-point
    // scaled by E_SCALE. Handles leading-dot literals (`E.91934`) as slicers emit.
    function _findEField(
        bytes calldata data,
        uint256 pos,
        uint256 end
    ) private pure returns (int256 value, bool found) {
        for (uint256 i = pos; i < end; i++) {
            if (data[i] != 0x45) continue; // 'E'
            if (i > 0) {
                bytes1 prev = data[i - 1];
                if (prev != 0x20 && prev != 0x09) continue; // not word-initial
            }

            uint256 j = i + 1;
            bool negative = false;
            if (j < end && (data[j] == 0x2d || data[j] == 0x2b)) {
                negative = (data[j] == 0x2d);
                j++;
            }

            uint256 intPart = 0;
            uint256 fracPart = 0;
            uint256 fracDigits = 0;
            bool inFraction = false;
            bool hasDigits = false;

            while (j < end) {
                bytes1 ch = data[j];
                if (ch >= 0x30 && ch <= 0x39) {
                    hasDigits = true;
                    if (inFraction) {
                        if (fracDigits < 5) {
                            fracPart = fracPart * 10 + uint256(uint8(ch) - 48);
                            fracDigits++;
                        }
                    } else {
                        intPart = intPart * 10 + uint256(uint8(ch) - 48);
                    }
                    j++;
                } else if (ch == 0x2e && !inFraction) {
                    inFraction = true;
                    j++;
                } else {
                    break;
                }
            }
            if (!hasDigits) continue;

            uint256 scaled = intPart * E_SCALE;
            while (fracDigits < 5) { fracPart *= 10; fracDigits++; }
            scaled += fracPart;

            value = negative ? -int256(scaled) : int256(scaled);
            return (value, true);
        }
        return (0, false);
    }
}



