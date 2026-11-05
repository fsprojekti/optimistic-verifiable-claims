// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SegmentedCommitment.sol";

/**
 * Bidding commitment and deferred ciphertext publication for one demand.
 *
 * Abstractly, the Consumer commits to Com(G) and Com(C) during bidding and
 * publishes C only after selecting a Provider. This contract realizes Com with
 * the canonical segmented EVM profile in SegmentedCommitment.
 */
contract Demand {
    enum State { None, Bidding, CiphertextPending, CiphertextVerified }

    struct DemandRecord {
        address consumer;
        address selectedProvider;
        bytes32 hG;
        bytes32 hC;
        bytes32 ciphertextAccumulator;
        uint256 fClaim;
        bytes12 nonce;
        uint256 totalCiphertextBytes;
        uint256 chunkSize;
        uint256 expectedChunkCount;
        uint256 uploadedChunkCount;
        uint256 uploadedBytes;
        State state;
    }

    uint256 public immutable maxChunkSize;
    uint256 public demandCount;
    mapping(uint256 => DemandRecord) public demands;
    mapping(uint256 => mapping(uint256 => bytes)) private ciphertext;

    event DemandPosted(
        uint256 indexed demandId,
        address indexed consumer,
        bytes32 hG,
        bytes32 hC,
        uint256 totalCiphertextBytes,
        uint256 chunkSize,
        uint256 chunkCount,
        uint256 fClaim,
        bytes12 nonce
    );
    event BindingPrepared(
        uint256 indexed demandId,
        address indexed consumer,
        address indexed provider
    );
    event CiphertextChunkAdded(
        uint256 indexed demandId,
        uint256 indexed chunkIndex,
        uint256 chunkBytes
    );
    event CiphertextVerified(uint256 indexed demandId, bytes32 hC, uint256 chunkCount);

    constructor(uint256 _maxChunkSize) {
        require(_maxChunkSize != 0, "Zero maximum chunk size");
        maxChunkSize = _maxChunkSize;
    }

    /**
     * Commit the plaintext and ciphertext before bidding. C is not published by
     * this call; its exact dimensions and commitment cannot be changed later.
     */
    function postDemand(
        bytes32 hG,
        bytes32 hC,
        uint256 fClaim,
        bytes12 nonce,
        uint256 totalCiphertextBytes,
        uint256 chunkSize
    ) external returns (uint256 demandId) {
        require(hG != bytes32(0), "hG required");
        require(hC != bytes32(0), "hC required");
        require(chunkSize <= maxChunkSize, "Chunk exceeds maximum");

        uint256 chunkCount = SegmentedCommitment.count(totalCiphertextBytes, chunkSize);
        demandId = ++demandCount;
        demands[demandId] = DemandRecord({
            consumer: msg.sender,
            selectedProvider: address(0),
            hG: hG,
            hC: hC,
            ciphertextAccumulator: bytes32(0),
            fClaim: fClaim,
            nonce: nonce,
            totalCiphertextBytes: totalCiphertextBytes,
            chunkSize: chunkSize,
            expectedChunkCount: chunkCount,
            uploadedChunkCount: 0,
            uploadedBytes: 0,
            state: State.Bidding
        });

        emit DemandPosted(
            demandId,
            msg.sender,
            hG,
            hC,
            totalCiphertextBytes,
            chunkSize,
            chunkCount,
            fClaim,
            nonce
        );
    }

    /**
     * Move from bidding into binding preparation. This selects the Provider but
     * creates no OVC claims and imposes no Provider obligation.
     */
    function prepareBinding(uint256 demandId, address provider) external {
        DemandRecord storage d = demands[demandId];
        require(d.consumer == msg.sender, "Only consumer");
        require(d.state == State.Bidding, "Not bidding");
        require(provider != address(0), "Provider required");

        d.selectedProvider = provider;
        d.ciphertextAccumulator = SegmentedCommitment.seed(
            SegmentedCommitment.CIPHERTEXT_DOMAIN,
            d.totalCiphertextBytes,
            d.chunkSize,
            d.expectedChunkCount
        );
        d.state = State.CiphertextPending;
        emit BindingPrepared(demandId, msg.sender, provider);
    }

    function depositCiphertextChunk(uint256 demandId, bytes calldata chunk) external {
        DemandRecord storage d = demands[demandId];
        require(d.consumer == msg.sender, "Only consumer");
        require(d.state == State.CiphertextPending, "Ciphertext not pending");

        uint256 index = d.uploadedChunkCount;
        uint256 requiredLength = SegmentedCommitment.expectedLength(
            d.totalCiphertextBytes,
            d.chunkSize,
            d.expectedChunkCount,
            index
        );
        require(chunk.length == requiredLength, "Incorrect chunk length");

        ciphertext[demandId][index] = chunk;
        d.ciphertextAccumulator = SegmentedCommitment.appendCalldata(
            d.ciphertextAccumulator,
            index,
            chunk
        );
        d.uploadedChunkCount = index + 1;
        d.uploadedBytes += chunk.length;
        emit CiphertextChunkAdded(demandId, index, chunk.length);
    }

    function sealCiphertext(uint256 demandId) external {
        DemandRecord storage d = demands[demandId];
        require(d.consumer == msg.sender, "Only consumer");
        require(d.state == State.CiphertextPending, "Ciphertext not pending");
        require(d.uploadedChunkCount == d.expectedChunkCount, "Chunks incomplete");
        require(d.uploadedBytes == d.totalCiphertextBytes, "Bytes incomplete");
        require(d.ciphertextAccumulator == d.hC, "Ciphertext commitment mismatch");

        d.state = State.CiphertextVerified;
        emit CiphertextVerified(demandId, d.hC, d.uploadedChunkCount);
    }

    // Public reference functions for exact off-chain reproduction of the EVM profile.
    function plaintextCommitmentSeed(
        uint256 totalBytes,
        uint256 chunkSize
    ) external pure returns (bytes32) {
        uint256 chunkCount = SegmentedCommitment.count(totalBytes, chunkSize);
        return SegmentedCommitment.seed(
            SegmentedCommitment.PLAINTEXT_DOMAIN, totalBytes, chunkSize, chunkCount
        );
    }

    function ciphertextCommitmentSeed(
        uint256 totalBytes,
        uint256 chunkSize
    ) external pure returns (bytes32) {
        uint256 chunkCount = SegmentedCommitment.count(totalBytes, chunkSize);
        return SegmentedCommitment.seed(
            SegmentedCommitment.CIPHERTEXT_DOMAIN, totalBytes, chunkSize, chunkCount
        );
    }

    function hashNextChunk(
        bytes32 accumulator,
        uint256 chunkIndex,
        bytes calldata chunk
    ) external pure returns (bytes32) {
        return SegmentedCommitment.appendCalldata(accumulator, chunkIndex, chunk);
    }

    function getCiphertextChunk(uint256 demandId, uint256 index)
        external
        view
        returns (bytes memory)
    {
        return ciphertext[demandId][index];
    }

    function ciphertextChunkCount(uint256 demandId) external view returns (uint256) {
        return demands[demandId].expectedChunkCount;
    }

    function uploadedCiphertextChunkCount(uint256 demandId) external view returns (uint256) {
        return demands[demandId].uploadedChunkCount;
    }

    function ciphertextByteCount(uint256 demandId) external view returns (uint256) {
        return demands[demandId].totalCiphertextBytes;
    }

    function ciphertextCommitment(uint256 demandId) external view returns (bytes32) {
        return demands[demandId].hC;
    }

    function computedCiphertextCommitment(uint256 demandId) external view returns (bytes32) {
        return demands[demandId].ciphertextAccumulator;
    }

    function artifactHash(uint256 demandId) external view returns (bytes32) {
        return demands[demandId].hG;
    }

    function featureClaim(uint256 demandId) external view returns (uint256) {
        return demands[demandId].fClaim;
    }

    function encryptionNonce(uint256 demandId) external view returns (bytes12) {
        return demands[demandId].nonce;
    }

    function selectedProvider(uint256 demandId) external view returns (address) {
        return demands[demandId].selectedProvider;
    }

    function demandConsumer(uint256 demandId) external view returns (address) {
        return demands[demandId].consumer;
    }

    function artifactChunkSize(uint256 demandId) external view returns (uint256) {
        return demands[demandId].chunkSize;
    }

    function isSealed(uint256 demandId) external view returns (bool) {
        return demands[demandId].state == State.CiphertextVerified;
    }
}
