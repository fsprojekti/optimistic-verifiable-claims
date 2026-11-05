const { ethers } = require("hardhat");

const PLAINTEXT_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("OVC_PLAINTEXT_V1"));
const CIPHERTEXT_DOMAIN = ethers.keccak256(ethers.toUtf8Bytes("OVC_CIPHERTEXT_V1"));

function chunkCount(totalBytes, chunkSize) {
  if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0) {
    throw new Error("totalBytes must be a positive safe integer");
  }
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
    throw new Error("chunkSize must be a positive safe integer");
  }
  return Math.ceil(totalBytes / chunkSize);
}

function commitmentSeed(domain, totalBytes, chunkSize) {
  const count = chunkCount(totalBytes, chunkSize);
  return ethers.solidityPackedKeccak256(
    ["bytes32", "uint256", "uint256", "uint256"],
    [domain, totalBytes, chunkSize, count]
  );
}

function appendChunk(accumulator, index, chunk) {
  const bytes = ethers.getBytes(chunk);
  return ethers.solidityPackedKeccak256(
    ["bytes32", "uint256", "uint256", "bytes"],
    [accumulator, index, bytes.length, bytes]
  );
}

function segmentedCommitment(buffer, chunkSize, domain) {
  const bytes = Buffer.from(ethers.getBytes(buffer));
  let accumulator = commitmentSeed(domain, bytes.length, chunkSize);
  for (let index = 0, offset = 0; offset < bytes.length; index++, offset += chunkSize) {
    accumulator = appendChunk(
      accumulator,
      index,
      bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length))
    );
  }
  return accumulator;
}

module.exports = {
  PLAINTEXT_DOMAIN,
  CIPHERTEXT_DOMAIN,
  chunkCount,
  commitmentSeed,
  appendChunk,
  segmentedCommitment,
};
