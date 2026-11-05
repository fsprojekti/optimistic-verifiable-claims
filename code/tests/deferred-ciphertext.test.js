const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chacha20 } = require("./lib/chacha20");
const { createAccessKeyPair, encryptAccessKey, accessLinkCommitment } = require("./lib/access-envelope");
const accessKeys = createAccessKeyPair();
const {
  PLAINTEXT_DOMAIN,
  CIPHERTEXT_DOMAIN,
  commitmentSeed,
  appendChunk,
  segmentedCommitment,
} = require("./lib/segmented-commitment");

const WINDOW = 100;
const MAX_CHUNK_BYTES = 8;
const CHUNK_BYTES = 4;
const NONCE = "0x000102030405060708090a0b";

function chunksOf(buffer, chunkSize = CHUNK_BYTES) {
  const chunks = [];
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    chunks.push(buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length)));
  }
  return chunks;
}

describe("Deferred ciphertext and canonical segmented commitments", function () {
  let consumer, provider, other, demand;

  beforeEach(async function () {
    [consumer, provider, other] = await ethers.getSigners();
    demand = await (await ethers.getContractFactory("Demand")).deploy(MAX_CHUNK_BYTES);
    await demand.waitForDeployment();
  });

  function fixture() {
    const plaintext = Buffer.from("G1 X1 E1\n");
    const key = Buffer.from("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f", "hex");
    const nonce = Buffer.from(NONCE.slice(2), "hex");
    const ciphertext = chacha20(plaintext, key, nonce);
    const envelope = encryptAccessKey(key, accessKeys.publicKey, provider.address, 1);
    return {
      envelope,
      link: accessLinkCommitment(key, accessKeys.publicKey, envelope),
      plaintext,
      ciphertext,
      key,
      hG: segmentedCommitment(plaintext, CHUNK_BYTES, PLAINTEXT_DOMAIN),
      hC: segmentedCommitment(ciphertext, CHUNK_BYTES, CIPHERTEXT_DOMAIN),
      hK: ethers.keccak256(key),
    };
  }

  async function post(data = fixture(), committedHC = data.hC) {
    await demand.connect(consumer).postDemand(
      data.hG,
      committedHC,
      100000n,
      NONCE,
      data.ciphertext.length,
      CHUNK_BYTES
    );
    return await demand.demandCount();
  }

  async function publish(demandId, data = fixture()) {
    await demand.connect(consumer).prepareBinding(demandId, provider.address);
    for (const chunk of chunksOf(data.ciphertext)) {
      await demand.connect(consumer).depositCiphertextChunk(demandId, chunk);
    }
    await demand.connect(consumer).sealCiphertext(demandId);
  }

  it("matches the public Solidity reference functions exactly", async function () {
    const data = fixture();
    let accumulator = commitmentSeed(CIPHERTEXT_DOMAIN, data.ciphertext.length, CHUNK_BYTES);
    expect(await demand.ciphertextCommitmentSeed(data.ciphertext.length, CHUNK_BYTES))
      .to.equal(accumulator);

    for (const [index, chunk] of chunksOf(data.ciphertext).entries()) {
      accumulator = appendChunk(accumulator, index, chunk);
      expect(await demand.hashNextChunk(
        index === 0
          ? commitmentSeed(CIPHERTEXT_DOMAIN, data.ciphertext.length, CHUNK_BYTES)
          : chunksOf(data.ciphertext).slice(0, index).reduce(
              (acc, prior, priorIndex) => appendChunk(acc, priorIndex, prior),
              commitmentSeed(CIPHERTEXT_DOMAIN, data.ciphertext.length, CHUNK_BYTES)
            ),
        index,
        chunk
      )).to.equal(accumulator);
    }
    expect(accumulator).to.equal(data.hC);
  });

  it("keeps bidding commitment-only and enables upload only after selection", async function () {
    const data = fixture();
    const demandId = await post(data);

    expect((await demand.demands(demandId)).state).to.equal(1n); // Bidding
    expect(await demand.uploadedCiphertextChunkCount(demandId)).to.equal(0);
    await expect(
      demand.connect(consumer).depositCiphertextChunk(demandId, chunksOf(data.ciphertext)[0])
    ).to.be.revertedWith("Ciphertext not pending");

    await demand.connect(consumer).prepareBinding(demandId, provider.address);
    expect((await demand.demands(demandId)).state).to.equal(2n); // CiphertextPending
    expect(await demand.selectedProvider(demandId)).to.equal(provider.address);
  });

  it("enforces exact chunk dimensions and completeness", async function () {
    const data = fixture();
    const demandId = await post(data);
    await demand.connect(consumer).prepareBinding(demandId, provider.address);

    await expect(
      demand.connect(consumer).depositCiphertextChunk(demandId, data.ciphertext.subarray(0, 3))
    ).to.be.revertedWith("Incorrect chunk length");
    await demand.connect(consumer).depositCiphertextChunk(demandId, data.ciphertext.subarray(0, 4));
    await expect(demand.connect(consumer).sealCiphertext(demandId))
      .to.be.revertedWith("Chunks incomplete");

    for (const chunk of chunksOf(data.ciphertext).slice(1)) {
      await demand.connect(consumer).depositCiphertextChunk(demandId, chunk);
    }
    await demand.connect(consumer).sealCiphertext(demandId);
    expect(await demand.isSealed(demandId)).to.equal(true);
    expect(await demand.computedCiphertextCommitment(demandId)).to.equal(data.hC);
    await expect(
      demand.connect(consumer).depositCiphertextChunk(demandId, "0x00")
    ).to.be.revertedWith("Ciphertext not pending");
  });

  it("refuses ciphertext that does not match the bidding commitment", async function () {
    const data = fixture();
    const wrongHC = ethers.keccak256(ethers.toUtf8Bytes("different ciphertext"));
    const demandId = await post(data, wrongHC);
    await demand.connect(consumer).prepareBinding(demandId, provider.address);
    for (const chunk of chunksOf(data.ciphertext)) {
      await demand.connect(consumer).depositCiphertextChunk(demandId, chunk);
    }
    await expect(demand.connect(consumer).sealCiphertext(demandId))
      .to.be.revertedWith("Ciphertext commitment mismatch");
  });

  it("binds only the selected Provider and prevents duplicate binding", async function () {
    const data = fixture();
    const demandId = await post(data);
    await publish(demandId, data);

    const access = await (await ethers.getContractFactory("OVCAccess")).deploy(WINDOW);
    const identity = await (await ethers.getContractFactory("OVCIdentitySegmented"))
      .deploy(WINDOW, await demand.getAddress());
    const conformance = await (await ethers.getContractFactory("OVCConformanceSegmented"))
      .deploy(WINDOW);
    const feature = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(WINDOW);
    await Promise.all([access, identity, conformance, feature].map(contract => contract.waitForDeployment()));
    const binding = await (await ethers.getContractFactory("BindingPhase")).deploy(
      await access.getAddress(),
      await identity.getAddress(),
      await conformance.getAddress(),
      await feature.getAddress(),
      await demand.getAddress()
    );
    await binding.waitForDeployment();
    for (const contract of [access, identity, conformance, feature]) {
      await contract.setCoordinator(await binding.getAddress());
    }

    await binding.connect(provider).registerAccessPublicKey(accessKeys.publicKey);

    await expect(binding.connect(consumer).bindProvider(
      demandId, other.address, data.hK, data.envelope, data.link, [0, 0, 0]
    )).to.be.revertedWith("Provider not selected");

    await binding.connect(consumer).bindProvider(
      demandId, provider.address, data.hK, data.envelope, data.link, [0, 0, 0]
    );
    expect(await binding.demandToBinding(demandId)).to.equal(1);
    await expect(binding.connect(consumer).bindProvider(
      demandId, provider.address, data.hK, data.envelope, data.link, [0, 0, 0]
    )).to.be.revertedWith("Demand already bound");

    const [, identityClaimId] = await binding.getClaimIds(1);
    await identity.connect(provider).disputeClaim(identityClaimId);
    await identity.connect(consumer).revealKey(identityClaimId, data.key);
    await identity.connect(consumer).startAdjudication(identityClaimId);
    for (let index = 0; index < chunksOf(data.ciphertext).length; index++) {
      await identity.processChunk(identityClaimId);
    }
    await identity.finalizeAdjudication(identityClaimId);
    expect((await identity.claims(identityClaimId)).outcome).to.equal(2n); // Valid
  });
});
