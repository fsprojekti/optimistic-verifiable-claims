const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");
const { chacha20 } = require("./lib/chacha20");
const { PLAINTEXT_DOMAIN, CIPHERTEXT_DOMAIN, segmentedCommitment } = require("./lib/segmented-commitment");
const { createAccessKeyPair, encryptAccessKey, decryptAccessKey, accessLinkCommitment } = require("./lib/access-envelope");

const WINDOW = 20, CHUNK = 32;
const gasRows = [];
async function recorded(label, pending) {
  const receipt = await (await pending).wait();
  gasRows.push({ operation: label, gas_used: receipt.gasUsed.toString(), status: receipt.status, transaction_hash: receipt.hash });
  return receipt;
}

describe("Stage 04 Access: private handover and bound dispute", function () {
  let consumer, provider, outsider, demand, access, identity, conformance, feature, binding;
  let providerKeys, outsiderKeys, data;
  before(function () {
    providerKeys = createAccessKeyPair(); outsiderKeys = createAccessKeyPair();
  });
  beforeEach(async function () {
    [consumer, provider, outsider] = await ethers.getSigners();
    demand = await (await ethers.getContractFactory("Demand")).deploy(CHUNK);
    access = await (await ethers.getContractFactory("OVCAccess")).deploy(WINDOW);
    identity = await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(WINDOW, await demand.getAddress());
    conformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(WINDOW);
    feature = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(WINDOW);
    binding = await (await ethers.getContractFactory("BindingPhase")).deploy(
      await access.getAddress(), await identity.getAddress(), await conformance.getAddress(),
      await feature.getAddress(), await demand.getAddress());
    for (const verifier of [access, identity, conformance, feature]) await verifier.setCoordinator(await binding.getAddress());
    const key = Buffer.alloc(32, 7), nonce = Buffer.alloc(12, 3), plain = Buffer.from("G1 X1 E1\n");
    const cipher = chacha20(plain, key, nonce), hK = ethers.keccak256(key);
    await demand.postDemand(segmentedCommitment(plain, CHUNK, PLAINTEXT_DOMAIN),
      segmentedCommitment(cipher, CHUNK, CIPHERTEXT_DOMAIN), 100000, nonce, plain.length, CHUNK);
    await demand.prepareBinding(1, provider.address);
    await demand.depositCiphertextChunk(1, cipher); await demand.sealCiphertext(1);
    const seed = crypto.randomBytes(32);
    const envelope = encryptAccessKey(key, providerKeys.publicKey, provider.address, 1, seed);
    data = { key, nonce, plain, cipher, hK, envelope, seed,
      link: accessLinkCommitment(key, providerKeys.publicKey, envelope) };
  });
  async function bind(link = data.link, envelope = data.envelope) {
    await recorded("registerAccessPublicKey", binding.connect(provider).registerAccessPublicKey(providerKeys.publicKey));
    await recorded("bindProvider", binding.connect(consumer).bindProvider(1, provider.address, data.hK, envelope, link, [0, 0, 0]));
    return await binding.getClaimIds(1);
  }

  it("resolves an honest binding-created Access claim as Valid (zero-linkage regression)", async function () {
    const [accessId, identityId] = await bind();
    const claim = await access.claims(accessId);
    expect(claim.commitment).to.equal(data.hK);
    expect(claim.providerKeyHash).to.equal(ethers.keccak256(providerKeys.publicKey));
    expect(claim.auxHash).to.equal(data.link);
    expect(claim.claimValue).to.equal(BigInt(ethers.keccak256(data.envelope)));
    expect((await identity.claims(identityId)).providerKeyHash).to.equal(data.hK);
    await recorded("disputeClaim", access.connect(provider).disputeClaim(accessId));
    await recorded("revealWitness", access.connect(consumer).revealWitness(accessId, ethers.concat([data.key,data.seed])));
    expect((await access.claims(accessId)).outcome).to.equal(2n);
  });
  it("delivers a recoverable encrypted key only to the selected Provider on the accepted path", async function () {
    const ids = await bind();
    const envelope = Buffer.from(ethers.getBytes((await binding.bindings(1)).encryptedKey));
    expect(envelope.length).to.equal(256);
    expect(envelope.includes(data.key)).to.equal(false);
    const recovered = decryptAccessKey(envelope, providerKeys.privateKey, provider.address, 1, data.hK);
    expect(recovered.equals(data.key)).to.equal(true);
    expect(chacha20(data.cipher, recovered, data.nonce).equals(data.plain)).to.equal(true);
    expect(() => decryptAccessKey(envelope, outsiderKeys.privateKey, provider.address, 1, data.hK)).to.throw();
    await binding.connect(provider).accept(1);
    for (const [verifier, id] of [[access,ids[0]],[identity,ids[1]],[conformance,ids[2]],[feature,ids[3]]]) {
      expect((await verifier.claims(id)).outcome).to.equal(1n);
    }
  });
  it("rejects envelope replay across Provider or Demand context and corrupted ciphertext", async function () {
    const [accessId] = await bind();
    expect(() => decryptAccessKey(data.envelope, providerKeys.privateKey, outsider.address, 1, data.hK)).to.throw();
    expect(() => decryptAccessKey(data.envelope, providerKeys.privateKey, provider.address, 2, data.hK)).to.throw();
    const corrupt = Buffer.from(data.envelope); corrupt[17] ^= 1;
    expect(() => decryptAccessKey(corrupt, providerKeys.privateKey, provider.address, 1, data.hK)).to.throw();
    expect(() => decryptAccessKey(data.envelope, providerKeys.privateKey, provider.address, 1, ethers.ZeroHash)).to.throw();
    expect((await access.claims(accessId)).state).to.equal(1n);
  });
  it("returns Inconsistent for a key different from the shared key commitment", async function () {
    const [id] = await bind(); await access.connect(provider).disputeClaim(id);
    await access.connect(consumer).revealWitness(id, ethers.concat([Buffer.alloc(32,8),data.seed]));
    expect((await access.claims(id)).outcome).to.equal(3n);
  });
  it("returns Incorrect for a correct key linked to the wrong Provider key", async function () {
    const wrongLink = accessLinkCommitment(data.key, outsiderKeys.publicKey, data.envelope);
    const [id] = await bind(wrongLink); await access.connect(provider).disputeClaim(id);
    await access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]));
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("returns Incorrect when the access commitment refers to another encrypted envelope", async function () {
    const otherEnvelope = encryptAccessKey(data.key, providerKeys.publicKey, provider.address, 1);
    const [id] = await bind(accessLinkCommitment(data.key, providerKeys.publicKey, otherEnvelope));
    await access.connect(provider).disputeClaim(id); await access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]));
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("rejects a self-consistent linkage whose RSA envelope encrypts the wrong key", async function () {
    const wrongKey = Buffer.alloc(32, 8);
    const envelope = encryptAccessKey(wrongKey, providerKeys.publicKey, provider.address, 1, data.seed);
    const [id] = await bind(accessLinkCommitment(data.key, providerKeys.publicKey, envelope), envelope);
    expect(() => decryptAccessKey(envelope, providerKeys.privateKey, provider.address, 1, data.hK)).to.throw("Access key commitment mismatch");
    await access.connect(provider).disputeClaim(id); await access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]));
    // Public re-encryption catches the wrong encapsulated key despite valid hashes.
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("allows explicit refusal without publishing the key", async function () {
    const [id] = await bind(); await access.connect(provider).disputeClaim(id);
    await access.connect(consumer).refuseWitness(id);
    expect((await access.claims(id)).outcome).to.equal(5n);
  });
  it("rejects wrong OAEP randomness even when the revealed key is correct", async function () {
    const [id] = await bind(); await access.connect(provider).disputeClaim(id);
    const wrongSeed = Buffer.from(data.seed); wrongSeed[0] ^= 1;
    await access.connect(consumer).revealWitness(id,ethers.concat([data.key,wrongSeed]));
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("rejects a self-consistent envelope encrypted for another Demand context", async function () {
    const envelope=encryptAccessKey(data.key,providerKeys.publicKey,provider.address,2,data.seed);
    const [id]=await bind(accessLinkCommitment(data.key,providerKeys.publicKey,envelope),envelope);
    await access.connect(provider).disputeClaim(id);
    await access.connect(consumer).revealWitness(id,ethers.concat([data.key,data.seed]));
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("rejects corrupted ciphertext despite a self-consistent key/link commitment", async function () {
    const envelope=Buffer.from(data.envelope);envelope[17]^=1;
    const [id]=await bind(accessLinkCommitment(data.key,providerKeys.publicKey,envelope),envelope);
    await access.connect(provider).disputeClaim(id);
    await access.connect(consumer).revealWitness(id,ethers.concat([data.key,data.seed]));
    expect((await access.claims(id)).outcome).to.equal(4n);
  });
  it("requires a complete opening and restricts envelope configuration to the coordinator", async function () {
    const [id]=await bind();await access.connect(provider).disputeClaim(id);
    await expect(access.connect(consumer).revealWitness(id,data.key)).to.be.revertedWith("Access witness must be 64 bytes");
    await expect(access.connect(consumer).configureEnvelope(id,providerKeys.publicKey,ethers.ZeroHash)).to.be.revertedWith("Only coordinator");
  });
  it("resolves Withheld after timeout and refuses late key revelation", async function () {
    const [id] = await bind(); await access.connect(provider).disputeClaim(id);
    await network.provider.send("hardhat_mine", ["0x15"]);
    await expect(access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]))).to.be.revertedWith("Dispute window expired");
    await access.connect(outsider).resolveWithheld(id);
    expect((await access.claims(id)).outcome).to.equal(5n);
  });
  it("enforces claimant/provider roles and terminal state immutability", async function () {
    const [id] = await bind();
    await expect(access.connect(outsider).disputeClaim(id)).to.be.revertedWith("Only provider");
    await access.connect(provider).disputeClaim(id);
    await expect(access.connect(outsider).revealWitness(id, ethers.concat([data.key,data.seed]))).to.be.revertedWith("Only claimant");
    await access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]));
    await expect(access.connect(provider).disputeClaim(id)).to.be.revertedWith("Not committed");
    await expect(access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]))).to.be.revertedWith("Not disputed");
  });
  it("requires a selected Provider's registered key, nonempty envelope and linkage", async function () {
    await binding.connect(outsider).registerAccessPublicKey(outsiderKeys.publicKey);
    await expect(binding.bindProvider(1, provider.address, data.hK, data.envelope, data.link, [0,0,0]))
      .to.be.revertedWith("Provider access key not registered");
    await binding.connect(provider).registerAccessPublicKey(providerKeys.publicKey);
    await expect(binding.bindProvider(1, provider.address, data.hK, "0x", data.link, [0,0,0]))
      .to.be.revertedWith("RSA envelope must be 256 bytes");
    await expect(binding.bindProvider(1, provider.address, data.hK, data.envelope, ethers.ZeroHash, [0,0,0]))
      .to.be.revertedWith("Access linkage required");
    await expect(binding.bindProvider(1, provider.address, ethers.ZeroHash, data.envelope, data.link, [0,0,0]))
      .to.be.revertedWith("Key commitment required");
  });
  it("pins the Provider key at binding despite subsequent key rotation", async function () {
    const [id] = await bind();
    await binding.connect(provider).registerAccessPublicKey(outsiderKeys.publicKey);
    expect((await access.claims(id)).providerKeyHash).to.equal(ethers.keccak256(providerKeys.publicKey));
    await access.connect(provider).disputeClaim(id); await access.connect(consumer).revealWitness(id, ethers.concat([data.key,data.seed]));
    expect((await access.claims(id)).outcome).to.equal(2n);
  });
  it("uses the same handed-over key for a complete Identity dispute", async function () {
    const [,id] = await bind();
    const key = decryptAccessKey(data.envelope, providerKeys.privateKey, provider.address, 1, data.hK);
    await identity.connect(provider).disputeClaim(id); await identity.connect(consumer).revealKey(id, key);
    await identity.connect(consumer).startAdjudication(id); await identity.processChunk(id);
    await identity.finalizeAdjudication(id);
    expect((await identity.claims(id)).outcome).to.equal(2n);
  });
  after(function () {
    const result = { profile: "Stage 04 Access: RSA-OAEP-SHA256 private handover and on-chain public re-encryption", network: "hardhat-local", chain_id: 31337,
      observed_at_utc: new Date().toISOString(), node_version: process.version, openssl_version: process.versions.openssl,
      hardhat_version: require("hardhat/package.json").version,
      tests: this.test.parent.tests.map(t => ({ title: t.title, state: t.state })),
      measured_transactions: gasRows, limitations: ["Local RSA-OAEP validation is not a formal security proof or external cryptographic audit.",
        "No public-testnet Access result is claimed; historical D5 Identity receipts use prior bytecode.",
        "The fixed artifact key is a public test fixture; generated RSA private keys are never recorded."] };
    const dir = path.resolve(__dirname, "../../results/validation"); fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"access-validation.json"), JSON.stringify(result,null,2)+"\n");
  });
});
