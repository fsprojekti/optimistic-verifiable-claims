"use strict";

// RFC 8017 OAEP encoding with an explicit opening seed; standard-library RSA.
// Decryption uses Node/OpenSSL's independent OAEP implementation.
// Fresh asymmetric keys/random OAEP padding are unrelated to public fixture keys.
const crypto = require("node:crypto");
const { keccak256, solidityPackedKeccak256, solidityPacked, toUtf8Bytes, getBytes } = require("ethers");

function createAccessKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });
  return { publicKey: publicKey.export({ type: "spki", format: "der" }), privateKey };
}

function labelFor(provider, demandId) {
  return Buffer.from(getBytes(solidityPacked(["bytes32","address","uint256"],
    [keccak256(toUtf8Bytes("OVC_ACCESS_RSA_OAEP_SHA256_V1")),provider,demandId])));
}

function oaepEncode(key, seed, label) {
  if (key.length !== 32 || seed.length !== 32) throw new Error("OAEP key and seed must be 32 bytes");
  const db = Buffer.alloc(223);
  crypto.createHash("sha256").update(label).digest().copy(db);
  db[190] = 1; Buffer.from(key).copy(db, 191);
  for (let block = 0; block < 7; ++block) {
    const counter = Buffer.alloc(4); counter.writeUInt32BE(block);
    const mask = crypto.createHash("sha256").update(seed).update(counter).digest();
    for (let i = 0; i < 32 && block*32+i < db.length; ++i) db[block*32+i] ^= mask[i];
  }
  const seedMask = crypto.createHash("sha256").update(db).update(Buffer.alloc(4)).digest();
  const maskedSeed = Buffer.from(seed); for(let i=0;i<32;++i) maskedSeed[i] ^= seedMask[i];
  return Buffer.concat([Buffer.alloc(1),maskedSeed,db]);
}

function encryptAccessKey(key, publicKey, provider, demandId, seed = crypto.randomBytes(32)) {
  if (Buffer.from(key).length !== 32) throw new Error("Access key must be 32 bytes");
  return crypto.publicEncrypt({ key: crypto.createPublicKey({ key: publicKey, type: "spki", format: "der" }),
    padding: crypto.constants.RSA_NO_PADDING }, oaepEncode(key,seed,labelFor(provider,demandId)));
}

function decryptAccessKey(envelope, privateKey, provider, demandId, expectedKeyHash) {
  const key = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
    oaepHash: "sha256", oaepLabel: labelFor(provider, demandId) }, envelope);
  if (key.length !== 32 || keccak256(key) !== expectedKeyHash) throw new Error("Access key commitment mismatch");
  return key;
}

function accessLinkCommitment(key, publicKey, envelope) {
  return solidityPackedKeccak256(["bytes32", "bytes32", "bytes32"],
    [key, keccak256(publicKey), keccak256(envelope)]);
}

module.exports = { createAccessKeyPair, encryptAccessKey, decryptAccessKey, accessLinkCommitment, labelFor, oaepEncode };
