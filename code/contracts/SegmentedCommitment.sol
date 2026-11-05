// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Canonical segmented-commitment profile for bounded EVM transactions.
 *
 * This is an implementation of the abstract OVC commitment Com(X), not part of
 * the abstract protocol itself. Fixed-width fields make every encoded step
 * unambiguous. Domain separation prevents a ciphertext root from being reused
 * as a plaintext root.
 */
library SegmentedCommitment {
    bytes32 internal constant PLAINTEXT_DOMAIN = keccak256("OVC_PLAINTEXT_V1");
    bytes32 internal constant CIPHERTEXT_DOMAIN = keccak256("OVC_CIPHERTEXT_V1");

    function count(uint256 totalBytes, uint256 chunkSize)
        internal
        pure
        returns (uint256)
    {
        require(totalBytes != 0, "Empty artifact");
        require(chunkSize != 0, "Zero chunk size");
        return ((totalBytes - 1) / chunkSize) + 1;
    }

    function seed(
        bytes32 domain,
        uint256 totalBytes,
        uint256 chunkSize,
        uint256 chunkCount
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(domain, totalBytes, chunkSize, chunkCount));
    }

    function appendCalldata(
        bytes32 accumulator,
        uint256 chunkIndex,
        bytes calldata chunk
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(accumulator, chunkIndex, chunk.length, chunk));
    }

    function appendMemory(
        bytes32 accumulator,
        uint256 chunkIndex,
        bytes memory chunk
    ) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked(accumulator, chunkIndex, chunk.length, chunk));
    }

    function expectedLength(
        uint256 totalBytes,
        uint256 chunkSize,
        uint256 chunkCount,
        uint256 chunkIndex
    ) internal pure returns (uint256) {
        require(chunkIndex < chunkCount, "Too many chunks");
        if (chunkIndex + 1 < chunkCount) return chunkSize;
        return totalBytes - (chunkSize * (chunkCount - 1));
    }
}
