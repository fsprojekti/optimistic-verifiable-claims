// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;
import "./RSAOAEP.sol";

contract RSAOAEPHarness {
    function encode(bytes32 key, bytes32 seed, bytes32 labelHash) external pure returns (bytes memory) {
        return RSAOAEP.encode(key, seed, labelHash);
    }
    function encrypt(bytes32 key, bytes32 seed, bytes32 labelHash, bytes calldata publicKey)
        external view returns (bytes memory)
    {
        return RSAOAEP.encrypt(key, seed, labelHash, publicKey);
    }
    function validPublicKey(bytes calldata publicKey) external pure returns (bool) {
        return RSAOAEP.validPublicKey(publicKey);
    }
}
