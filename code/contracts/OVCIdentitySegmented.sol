// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";
import "./Demand.sol";
import "./ChaCha20.sol";
import "./SegmentedCommitment.sol";

/**
 * OVC-Identity (segmented, Demand-sourced ciphertext)
 *
 * Binding fields set at binding by the coordinator:
 *   commitment      = H~(C)  â€” rolling keccak of the ciphertext (taken from the Demand)
 *   auxHash         = H~(G)  â€” rolling keccak of the ChaCha20-decrypted plaintext
 *   providerKeyHash = H(K)   â€” hash of the 256-bit key; K stays secret until revealed
 *
 * The ciphertext C is NOT stored here. It is published to the Demand store after
 * Provider selection; this instance is created at binding with a reference to that demand
 * (setDemand) and reads C cross-contract during adjudication. C integrity is
 * guaranteed by demand.hC == commitment, checked before accept/dispute.
 *
 * Dispute path:
 *   1. Provider disputeClaim.
 *   2. Consumer revealKey â€” K verified against H(K).
 *   3. Consumer startAdjudication.
 *   4. Anyone processChunk â€” reads each C chunk from the Demand, decrypts to a G
 *      chunk, accumulates H~(G).
 *   5. Anyone finalizeAdjudication â€” VALID iff accumulated H~(G) == auxHash.
 */
contract OVCIdentitySegmented is OVCBaseSegmented {

    Demand public immutable demand;
    mapping(uint256 => uint256) public demandOf;     // claimId => demandId
    mapping(uint256 => bytes32) public sessionKeys;
    mapping(uint256 => bool) public keyRevealed;

    constructor(uint256 _disputeWindowBlocks, address _demand)
        OVCBaseSegmented(_disputeWindowBlocks)
    {
        demand = Demand(_demand);
    }

    /**
     * @notice Coordinator links this claim to its bidding-phase demand at binding.
     *         Mirrors the demand's chunk count into depositedChunkCount so the base
     *         adjudication bookkeeping (finalize check) applies unchanged.
     */
    function setDemand(uint256 claimId, uint256 demandId) external onlyCoordinator {
        require(demandOf[claimId] == 0, "Demand already set");
        require(demand.isSealed(demandId), "Demand not sealed");
        demandOf[claimId] = demandId;
        depositedChunkCount[claimId] = demand.ciphertextChunkCount(demandId);
    }

    // C availability + integrity: a verified demand whose canonical computed
    // commitment matches the value committed before bidding.
    function _ciphertextReady(uint256 claimId) internal view returns (bool) {
        uint256 dId = demandOf[claimId];
        return dId != 0
            && demand.isSealed(dId)
            && demand.ciphertextCommitment(dId) == claims[claimId].commitment
            && demand.computedCiphertextCommitment(dId) == claims[claimId].commitment;
    }

    function acceptClaim(uint256 claimId) external override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(_ciphertextReady(claimId), "Ciphertext not ready");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function acceptClaimFor(uint256 claimId, address provider) external override onlyCoordinator {
        require(claims[claimId].provider == provider, "Wrong provider");
        require(claims[claimId].state == State.Committed, "Not committed");
        require(_ciphertextReady(claimId), "Ciphertext not ready");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function disputeClaim(uint256 claimId) external payable override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(_ciphertextReady(claimId), "Ciphertext not ready");
        _escrowReimbursement(claimId);
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // Consumer reveals K, verified against committed H(K). Must precede adjudication.
    function revealKey(uint256 claimId, bytes32 key) external onlyClaimant(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");
        if (keccak256(abi.encodePacked(key)) != claim.providerKeyHash) {
            claim.outcome = Outcome.Inconsistent;
            claim.state = State.Resolved;
            _settleReimbursement(claimId, false);
            emit ClaimRevealed(claimId, Outcome.Inconsistent);
            return;
        }
        sessionKeys[claimId] = key;
        keyRevealed[claimId] = true;
    }

    function startAdjudication(uint256 claimId) external override onlyClaimant(claimId) {
        require(keyRevealed[claimId], "Must reveal key first");
        _startAdjudication(claimId);
    }

    // Read the next ciphertext chunk, decrypt it, and extend canonical Com(G).
    function processChunk(uint256 claimId) external override {
        require(claims[claimId].state == State.Adjudicating, "Not adjudicating");
        AdjudicationSession storage session = sessions[claimId];
        uint256 dId = demandOf[claimId];
        uint256 idx = session.nextChunkIndex;
        require(idx < demand.ciphertextChunkCount(dId), "All chunks processed");

        bytes memory chunk = demand.getCiphertextChunk(dId, idx);
        bytes memory decrypted = ChaCha20.applyKeystream(
            chunk,
            sessionKeys[claimId],
            demand.encryptionNonce(dId),
            session.bytesProcessed
        );
        if (idx == 0) {
            uint256 totalBytes = demand.ciphertextByteCount(dId);
            uint256 chunkSize = demand.artifactChunkSize(dId);
            session.rollingKeccak = SegmentedCommitment.seed(
                SegmentedCommitment.PLAINTEXT_DOMAIN,
                totalBytes,
                chunkSize,
                demand.ciphertextChunkCount(dId)
            );
        }
        session.rollingKeccak = SegmentedCommitment.appendMemory(
            session.rollingKeccak, idx, decrypted
        );
        session.bytesProcessed += chunk.length;
        session.nextChunkIndex++;
    }

    // Unused: ciphertext chunks are sourced from the Demand via the overridden
    // processChunk above. Present only to satisfy the abstract base hook.
    function _processChunk(
        uint256, Claim storage, AdjudicationSession storage, bytes storage
    ) internal pure override {}

    function _finalizePredicate(
        uint256 /* claimId */,
        Claim storage claim,
        AdjudicationSession storage session
    ) internal view override returns (bool) {
        return session.rollingKeccak == claim.auxHash;
    }
}
