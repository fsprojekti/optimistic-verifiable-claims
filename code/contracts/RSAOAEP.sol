// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/** RFC 8017 RSAES-OAEP: RSA-2048/e=65537, SHA-256 and MGF1-SHA256.
 * The encryption opening (K, random seed) is disclosed only during a dispute.
 * Public re-encryption verifies delivery without exposing the Provider private key.
 */
library RSAOAEP {
    bytes internal constant SPKI_PREFIX = hex"30820122300d06092a864886f70d01010105000382010f003082010a0282010100";

    function validPublicKey(bytes memory publicKey) internal pure returns (bool) {
        if (publicKey.length != 294) return false;
        bytes memory prefix = SPKI_PREFIX;
        for (uint256 i; i < prefix.length; ++i) if (publicKey[i] != prefix[i]) return false;
        if (uint8(publicKey[33]) < 128 || (uint8(publicKey[288]) & 1) == 0) return false;
        return publicKey[289] == 0x02 && publicKey[290] == 0x03
            && publicKey[291] == 0x01 && publicKey[292] == 0x00 && publicKey[293] == 0x01;
    }

    function encode(bytes32 key, bytes32 seed, bytes32 labelHash) internal pure returns (bytes memory em) {
        // DB = lHash(32) || PS(158 zero bytes) || 0x01 || K(32).
        bytes memory db = new bytes(223);
        for (uint256 i; i < 32; ++i) db[i] = labelHash[i];
        db[190] = 0x01;
        for (uint256 i; i < 32; ++i) db[191 + i] = key[i];
        // MGF1 uses a four-byte big-endian counter, starting at zero.
        for (uint256 blockIndex; blockIndex < 7; ++blockIndex) {
            bytes32 mask = sha256(abi.encodePacked(seed, uint32(blockIndex)));
            for (uint256 j; j < 32 && blockIndex * 32 + j < 223; ++j) {
                uint256 index = blockIndex * 32 + j;
                db[index] = db[index] ^ mask[j];
            }
        }
        bytes32 seedMask = sha256(abi.encodePacked(db, uint32(0)));
        em = new bytes(256); // Leading zero ensures EM < any 2048-bit modulus.
        for (uint256 i; i < 32; ++i) em[1 + i] = seed[i] ^ seedMask[i];
        for (uint256 i; i < 223; ++i) em[33 + i] = db[i];
    }

    function encrypt(bytes32 key, bytes32 seed, bytes32 labelHash, bytes memory publicKey)
        internal view returns (bytes memory ciphertext)
    {
        require(validPublicKey(publicKey), "Unsupported RSA public key");
        bytes memory modulus = new bytes(256);
        for (uint256 i; i < 256; ++i) modulus[i] = publicKey[33 + i];
        bytes memory input = abi.encodePacked(uint256(256), uint256(3), uint256(256),
            encode(key, seed, labelHash), hex"010001", modulus);
        ciphertext = new bytes(256);
        bool success;
        assembly {
            success := staticcall(gas(), 5, add(input, 32), mload(input), add(ciphertext, 32), 256)
            success := and(success, eq(returndatasize(), 256))
        }
        require(success, "RSA precompile failed");
    }
}
