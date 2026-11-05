// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ChaCha20
 * @notice RFC 8439 ChaCha20 with a 256-bit key, 96-bit nonce, and initial
 *         block counter 1.
 * @dev Applying the keystream encrypts plaintext and applying it again
 *      decrypts ciphertext. The absolute byte offset keeps separately
 *      submitted chunks on one continuous stream, including unaligned chunks.
 */
library ChaCha20 {
    uint256 internal constant BLOCK_SIZE = 64;
    uint256 internal constant INITIAL_COUNTER = 1;
    uint256 internal constant MAX_STREAM_BYTES = uint256(type(uint32).max) * BLOCK_SIZE;

    error StreamTooLong();

    function applyKeystream(
        bytes memory input,
        bytes32 key,
        bytes12 nonce,
        uint256 absoluteOffset
    ) internal pure returns (bytes memory output) {
        if (input.length > MAX_STREAM_BYTES || absoluteOffset > MAX_STREAM_BYTES - input.length) {
            revert StreamTooLong();
        }

        output = new bytes(input.length);
        uint256 inputIndex;
        uint256 streamOffset = absoluteOffset;

        while (inputIndex < input.length) {
            uint256 blockIndex = streamOffset / BLOCK_SIZE;
            uint32 counter = uint32(INITIAL_COUNTER + blockIndex);
            uint32[16] memory blockWords = _block(key, counter, nonce);
            uint256 withinBlock = streamOffset % BLOCK_SIZE;
            uint256 available = BLOCK_SIZE - withinBlock;
            uint256 remaining = input.length - inputIndex;
            uint256 take = remaining < available ? remaining : available;

            _xorSegment(input, output, blockWords, inputIndex, withinBlock, take);

            inputIndex += take;
            streamOffset += take;
        }
    }

    function _xorSegment(
        bytes memory input,
        bytes memory output,
        uint32[16] memory blockWords,
        uint256 inputIndex,
        uint256 withinBlock,
        uint256 take
    ) private pure {
        for (uint256 j = 0; j < take; ++j) {
            uint256 keystreamIndex = withinBlock + j;
            uint32 word = blockWords[keystreamIndex / 4];
            uint8 keystreamByte = uint8(word >> (8 * (keystreamIndex % 4)));
            output[inputIndex + j] = bytes1(uint8(input[inputIndex + j]) ^ keystreamByte);
        }
    }

    function _block(bytes32 key, uint32 counter, bytes12 nonce)
        private
        pure
        returns (uint32[16] memory working)
    {
        uint32[16] memory initial;
        initial[0] = 0x61707865;
        initial[1] = 0x3320646e;
        initial[2] = 0x79622d32;
        initial[3] = 0x6b206574;

        for (uint256 i = 0; i < 8; ++i) {
            initial[4 + i] = _littleEndianKeyWord(key, i * 4);
        }
        initial[12] = counter;
        initial[13] = _littleEndianNonceWord(nonce, 0);
        initial[14] = _littleEndianNonceWord(nonce, 4);
        initial[15] = _littleEndianNonceWord(nonce, 8);
        // Memory-array assignment aliases rather than clones. Preserve the
        // original state for RFC 8439's final feed-forward addition.
        for (uint256 i = 0; i < 16; ++i) working[i] = initial[i];

        for (uint256 i = 0; i < 10; ++i) {
            _quarterRound(working, 0, 4, 8, 12);
            _quarterRound(working, 1, 5, 9, 13);
            _quarterRound(working, 2, 6, 10, 14);
            _quarterRound(working, 3, 7, 11, 15);
            _quarterRound(working, 0, 5, 10, 15);
            _quarterRound(working, 1, 6, 11, 12);
            _quarterRound(working, 2, 7, 8, 13);
            _quarterRound(working, 3, 4, 9, 14);
        }

        unchecked {
            for (uint256 i = 0; i < 16; ++i) working[i] += initial[i];
        }
    }

    function _quarterRound(
        uint32[16] memory x,
        uint256 a,
        uint256 b,
        uint256 c,
        uint256 d
    ) private pure {
        unchecked {
            x[a] += x[b]; x[d] ^= x[a]; x[d] = _rotateLeft(x[d], 16);
            x[c] += x[d]; x[b] ^= x[c]; x[b] = _rotateLeft(x[b], 12);
            x[a] += x[b]; x[d] ^= x[a]; x[d] = _rotateLeft(x[d], 8);
            x[c] += x[d]; x[b] ^= x[c]; x[b] = _rotateLeft(x[b], 7);
        }
    }

    function _rotateLeft(uint32 value, uint32 distance) private pure returns (uint32) {
        return (value << distance) | (value >> (32 - distance));
    }

    function _littleEndianKeyWord(bytes32 value, uint256 offset) private pure returns (uint32) {
        return uint32(uint8(value[offset]))
            | (uint32(uint8(value[offset + 1])) << 8)
            | (uint32(uint8(value[offset + 2])) << 16)
            | (uint32(uint8(value[offset + 3])) << 24);
    }

    function _littleEndianNonceWord(bytes12 value, uint256 offset) private pure returns (uint32) {
        return uint32(uint8(value[offset]))
            | (uint32(uint8(value[offset + 1])) << 8)
            | (uint32(uint8(value[offset + 2])) << 16)
            | (uint32(uint8(value[offset + 3])) << 24);
    }
}

