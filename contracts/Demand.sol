// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Demand — the bidding-phase object.
 *
 * A Demand is the Consumer's on-chain commitment to a specific manufacturing
 * artifact, posted so Providers can bid. It is provider-independent and is NOT
 * an OVC instance: it carries no dispute mechanism of its own. The four OVC
 * instances are instantiated later, at binding, and adjudicate against the
 * values committed here.
 *
 * A Demand records:
 *   hG      = H~(G)     rolling keccak commitment to the plaintext artifact G
 *   fClaim  = f_claim   the publicly asserted feature value (e.g. filament mm x1e5)
 *   C       = ciphertext G XOR K, uploaded on-chain in chunks so delivery is
 *             adjudicable; its rolling keccak hC is the OVC-Identity commitment.
 *
 * Segmentation: C is uploaded across many bounded transactions
 * (depositCiphertextChunk), each appended to an on-chain rolling hash. This is
 * the O(N) cost of posting a demand; monolithic upload (single tx) is infeasible
 * beyond the per-tx Block Horizon, so large artifacts are chunked.
 *
 * OVC-Identity reads these chunks cross-contract during adjudication
 * (getCiphertextChunk); it never needs its own copy.
 */
contract Demand {

    struct DemandRecord {
        address consumer;
        bytes32 hG;          // H~(G) — artifact commitment (Conformance/Feature/Identity aux)
        uint256 fClaim;      // declared feature value (Feature claimValue)
        bytes32 hC;          // H~(C) — rolling hash of uploaded ciphertext (Identity commitment)
        uint256 chunkCount;  // number of ciphertext chunks uploaded
        bool    finalized;   // once finalized, no further chunks accepted
    }

    uint256 public demandCount;
    mapping(uint256 => DemandRecord) public demands;
    // demandId => chunkIndex => ciphertext chunk
    mapping(uint256 => mapping(uint256 => bytes)) private ciphertext;

    event DemandPosted(uint256 indexed demandId, address indexed consumer, bytes32 hG, uint256 fClaim);
    event CiphertextChunkAdded(uint256 indexed demandId, uint256 indexed chunkIndex);
    event DemandSealed(uint256 indexed demandId, bytes32 hC, uint256 chunkCount);

    /**
     * @notice Post a demand: commit the artifact hash and declared feature value.
     *         Provider-independent; the ciphertext is uploaded separately.
     */
    function postDemand(bytes32 hG, uint256 fClaim) external returns (uint256 demandId) {
        require(hG != bytes32(0), "hG required");
        demandId = ++demandCount;
        demands[demandId] = DemandRecord({
            consumer:   msg.sender,
            hG:         hG,
            fClaim:     fClaim,
            hC:         bytes32(0),
            chunkCount: 0,
            finalized:  false
        });
        emit DemandPosted(demandId, msg.sender, hG, fClaim);
    }

    /**
     * @notice Append one ciphertext chunk, extending the on-chain rolling hash.
     *         Only the posting Consumer, only before sealing.
     */
    function depositCiphertextChunk(uint256 demandId, bytes calldata chunk) external {
        DemandRecord storage d = demands[demandId];
        require(d.consumer == msg.sender, "Only consumer");
        require(!d.finalized, "Sealed");
        uint256 idx = d.chunkCount;
        ciphertext[demandId][idx] = chunk;
        d.hC = keccak256(abi.encodePacked(d.hC, chunk));
        d.chunkCount = idx + 1;
        emit CiphertextChunkAdded(demandId, idx);
    }

    /**
     * @notice Seal the demand once the full ciphertext is uploaded. After sealing,
     *         hC is final and the demand can be bound to a Provider.
     */
    function seal(uint256 demandId) external {
        DemandRecord storage d = demands[demandId];
        require(d.consumer == msg.sender, "Only consumer");
        require(!d.finalized, "Already sealed");
        require(d.chunkCount > 0, "No ciphertext");
        d.finalized = true;
        emit DemandSealed(demandId, d.hC, d.chunkCount);
    }

    // ── Views consumed by OVC-Identity during cross-contract adjudication ──

    function getCiphertextChunk(uint256 demandId, uint256 index) external view returns (bytes memory) {
        return ciphertext[demandId][index];
    }

    function ciphertextChunkCount(uint256 demandId) external view returns (uint256) {
        return demands[demandId].chunkCount;
    }

    function ciphertextRollingHash(uint256 demandId) external view returns (bytes32) {
        return demands[demandId].hC;
    }

    function artifactHash(uint256 demandId) external view returns (bytes32) {
        return demands[demandId].hG;
    }

    function featureClaim(uint256 demandId) external view returns (uint256) {
        return demands[demandId].fClaim;
    }

    function isSealed(uint256 demandId) external view returns (bool) {
        return demands[demandId].finalized;
    }
}
