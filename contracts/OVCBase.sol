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

    function revealWitness(uint256 claimId, bytes calldata witness) external onlyClaimant(claimId) {
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

    // Total filament extrusion under absolute extrusion mode (M82): the FINAL
    // cumulative E-value in the witness, decimal-scaled by 1000 (E6.0 -> 6000).
    // Later E-values overwrite earlier ones, so the last one is the cumulative total.
    function _extractLastE(bytes calldata data) internal pure returns (uint256) {
        uint256 lastValue = 0;
        uint256 i = 0;
        while (i < data.length) {
            if (data[i] == "E") {
                uint256 j = i + 1;
                uint256 intPart = 0;
                uint256 fracPart = 0;
                uint256 fracScale = 1;
                bool hasDigits = false;
                bool inFraction = false;
                while (j < data.length) {
                    bytes1 ch = data[j];
                    if (ch >= "0" && ch <= "9") {
                        hasDigits = true;
                        if (inFraction) {
                            if (fracScale < 1000) {
                                fracPart = fracPart * 10 + uint256(uint8(ch) - 48);
                                fracScale *= 10;
                            }
                        } else {
                            intPart = intPart * 10 + uint256(uint8(ch) - 48);
                        }
                        j++;
                        continue;
                    }
                    if (ch == "." && !inFraction) {
                        inFraction = true;
                        j++;
                        continue;
                    }
                    break;
                }
                if (hasDigits) {
                    uint256 scaled = intPart * 1000;
                    if (fracScale > 1) {
                        uint256 scaleFactor = 1000 / fracScale;
                        scaled += fracPart * scaleFactor;
                    }
                    lastValue = scaled;
                }
                i = j;
                continue;
            }
            i++;
        }
        return lastValue;
    }
}


