const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chacha20 } = require("./lib/chacha20");

describe("RFC 8439 ChaCha20", function () {
    const key = "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f";
    const nonce = "0x000000000000004a00000000";
    const plaintext = Buffer.from(
        "4c616469657320616e642047656e746c656d656e206f662074686520636c617373" +
        "206f66202739393a204966204920636f756c64206f6666657220796f75206f6e" +
        "6c79206f6e652074697020666f7220746865206675747572652c2073756e736372" +
        "65656e20776f756c642062652069742e",
        "hex"
    );
    const ciphertext = Buffer.from(
        "6e2e359a2568f98041ba0728dd0d6981e97e7aec1d4360c20a27afccfd9fae0b" +
        "f91b65c5524733ab8f593dabcd62b3571639d624e65152ab8f530c359f0861d" +
        "807ca0dbf500d6a6156a38e088a22b65e52bc514d16ccf806818ce91ab779373" +
        "65af90bbf74a35be6b40b8eedf2785e42874d",
        "hex"
    );

    let harness;

    beforeEach(async function () {
        harness = await (await ethers.getContractFactory("ChaCha20Harness")).deploy();
        await harness.waitForDeployment();
    });

    it("matches the RFC 8439 encryption vector byte-for-byte", async function () {
        expect(chacha20(plaintext, Buffer.from(ethers.getBytes(key)), Buffer.from(ethers.getBytes(nonce))))
            .to.deep.equal(ciphertext);
        const actual = await harness.applyKeystream(plaintext, key, nonce, 0);
        expect(actual).to.equal(ethers.hexlify(ciphertext));
    });

    it("matches the RFC 8439 block-function vector", async function () {
        const blockNonce = "0x000000090000004a00000000";
        const expected =
            "0x10f1e7e4d13b5915500fdd1fa32071c4c7d1f4c733c068030422aa9ac3d46c4e" +
            "d2826446079faa0914c2d705d98b02a2b5129cd1de164eb9cbd083e8a2503c4e";
        const actual = await harness.applyKeystream(Buffer.alloc(64), key, blockNonce, 0);
        expect(actual).to.equal(expected);
    });

    it("decrypts the RFC 8439 vector", async function () {
        const actual = await harness.applyKeystream(ciphertext, key, nonce, 0);
        expect(actual).to.equal(ethers.hexlify(plaintext));
    });

    it("preserves one stream across unaligned transaction chunks", async function () {
        const chunkSizes = [1, 62, 2, 7, 31, 11];
        const parts = [];
        let offset = 0;
        for (const size of chunkSizes) {
            if (offset >= ciphertext.length) break;
            const end = Math.min(offset + size, ciphertext.length);
            const part = ciphertext.subarray(offset, end);
            const decrypted = await harness.applyKeystream(part, key, nonce, offset);
            parts.push(Buffer.from(ethers.getBytes(decrypted)));
            offset = end;
        }
        if (offset < ciphertext.length) {
            const decrypted = await harness.applyKeystream(
                ciphertext.subarray(offset), key, nonce, offset
            );
            parts.push(Buffer.from(ethers.getBytes(decrypted)));
        }
        expect(Buffer.concat(parts)).to.deep.equal(plaintext);
    });
});

