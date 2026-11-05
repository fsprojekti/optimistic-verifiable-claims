// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./ChaCha20.sol";

/** Test-only surface for validating the internal ChaCha20 library. */
contract ChaCha20Harness {
    function applyKeystream(bytes calldata input, bytes32 key, bytes12 nonce, uint256 offset)
        external
        pure
        returns (bytes memory)
    {
        return ChaCha20.applyKeystream(input, key, nonce, offset);
    }
}

