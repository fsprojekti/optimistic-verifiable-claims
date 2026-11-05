const crypto = require("crypto");

const INITIAL_COUNTER = 1;

/** RFC 8439 ChaCha20 with a 256-bit key, 96-bit nonce, and counter 1. */
function chacha20(data, key, nonce) {
    if (key.length !== 32) throw new Error("ChaCha20 key must be 32 bytes");
    if (nonce.length !== 12) throw new Error("ChaCha20 nonce must be 12 bytes");

    const iv = Buffer.alloc(16);
    iv.writeUInt32LE(INITIAL_COUNTER, 0);
    Buffer.from(nonce).copy(iv, 4);
    const cipher = crypto.createCipheriv("chacha20", Buffer.from(key), iv);
    return Buffer.concat([cipher.update(Buffer.from(data)), cipher.final()]);
}

module.exports = { chacha20 };

