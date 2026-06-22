// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";

/**
 * OVC-Conformance (segmented)
 *
 * Commitment = H̃(G) — rolling keccak of plaintext G chunks.
 *
 * G is NOT deposited at binding (it would expose the plaintext before dispute).
 * The Provider gets G via OVC-Identity (C XOR K). If the Provider disputes,
 * the Consumer deposits G chunks during the dispute window, then starts
 * adjudication. The rolling hash of deposited G is verified against the
 * commitment H̃(G) via isDepositComplete before adjudication can begin.
 */
contract OVCConformanceSegmented is OVCBaseSegmented {

    mapping(uint256 => bool) public syntaxStatus;

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

    function _processChunk(
        uint256 claimId,
        Claim storage /* claim */,
        AdjudicationSession storage /* session */,
        bytes storage chunk
    ) internal override {
        if (syntaxStatus[claimId]) return;
        uint256 len = chunk.length;
        for (uint256 i = 0; i + 1 < len; i++) {
            if (chunk[i] == 0x47) {
                bytes1 next = chunk[i + 1];
                if (next == 0x30 || next == 0x31) {
                    syntaxStatus[claimId] = true;
                    return;
                }
            }
        }
    }

    function _finalizePredicate(
        uint256 claimId,
        Claim storage /* claim */,
        AdjudicationSession storage /* session */
    ) internal view override returns (bool) {
        return syntaxStatus[claimId];
    }
}
