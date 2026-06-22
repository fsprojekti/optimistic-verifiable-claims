// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";

/**
 * OVC-Identity (segmented)
 *
 * Binding fields set by commitClaim + depositChunk:
 *   commitment      = H̃(C)  — rolling keccak over encrypted C chunks deposited on-chain
 *   auxHash         = H̃(G)  — rolling keccak over decrypted G chunks (derived from C XOR K)
 *   providerKeyHash = H(K)   — hash of XOR key; K is secret until Consumer reveals it
 *
 * Normal path (no dispute):
 *   Consumer deposits C chunks → Provider reads chunks from chain, decrypts G = C XOR K.
 *   Provider calls acceptClaim once all chunks are on-chain.
 *
 * Dispute path:
 *   1. Provider calls disputeClaim.
 *   2. Consumer calls revealKey — K verified against H(K); stored in sessionKeys.
 *   3. Consumer calls startAdjudication.
 *   4. Anyone calls processChunk repeatedly — reads stored C chunk, decrypts to G chunk,
 *      updates H̃(G) accumulator. No re-upload needed; chunks already on-chain from binding.
 *   5. Anyone calls finalizeAdjudication — VALID iff H̃(G) matches auxHash.
 *      C binding is guaranteed by depositRollingHash == commitment (checked at disputeClaim).
 */
contract OVCIdentitySegmented is OVCBaseSegmented {

    mapping(uint256 => bytes32) public sessionKeys;

    constructor(uint256 _disputeWindowBlocks) OVCBaseSegmented(_disputeWindowBlocks) {}

    // Consumer reveals K, verified against committed H(K).
    // Must be called before startAdjudication.
    function revealKey(uint256 claimId, bytes32 key) external onlyClaimant(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");

        if (keccak256(abi.encodePacked(key)) != claim.providerKeyHash) {
            claim.outcome = Outcome.Inconsistent;
            claim.state = State.Resolved;
            emit ClaimRevealed(claimId, Outcome.Inconsistent);
            return;
        }
        sessionKeys[claimId] = key;
    }

    // Override: key must be revealed before adjudication can start.
    function startAdjudication(uint256 claimId) external override onlyClaimant(claimId) {
        require(sessionKeys[claimId] != bytes32(0), "Must reveal key first");
        _startAdjudication(claimId);
    }

    // Read stored C chunk from binding, decrypt with K, accumulate H̃(G).
    function _processChunk(
        uint256 claimId,
        Claim storage /* claim */,
        AdjudicationSession storage session,
        bytes storage chunk
    ) internal override {
        bytes32 k = sessionKeys[claimId];
        uint256 offset = session.bytesProcessed;
        bytes memory decryptedChunk = new bytes(chunk.length);
        for (uint256 i = 0; i < chunk.length; i++) {
            decryptedChunk[i] = chunk[i] ^ k[(offset + i) % 32];
        }
        session.rollingKeccak = keccak256(
            abi.encodePacked(session.rollingKeccak, decryptedChunk)
        );
    }

    // C binding is already guaranteed (depositRollingHash == commitment was checked at
    // disputeClaim). Only verify that decrypted G matches the committed H̃(G).
    function _finalizePredicate(
        uint256 /* claimId */,
        Claim storage claim,
        AdjudicationSession storage session
    ) internal view override returns (bool) {
        return session.rollingKeccak == claim.auxHash;
    }
}
