const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chacha20 } = require("./lib/chacha20");
const { netExtrusion } = require("./lib/gcode-reference");
const { PLAINTEXT_DOMAIN, CIPHERTEXT_DOMAIN, segmentedCommitment } = require("./lib/segmented-commitment");
const { createAccessKeyPair, encryptAccessKey, decryptAccessKey, accessLinkCommitment } = require("./lib/access-envelope");

const stage = path.resolve(__dirname, "../..");
const corpus = path.join(stage, "data/corpus/generated/gcode");
const inputs = [
  ["cura",264386,"f1a51107fda5819a776de26b6068be1e577111bb2e84eb27341592842d582c33"],
  ["orca",280935,"d9c608650aa0a780a6a6d283107329ce9a47ee7f08b985ad4ee81ad6f53e879b"],
  ["prusa",316712,"3961ee85ee32938b17151ddd37e2ed800b89801b185b5ace76f48ff3b18e8761"],
];
const rows = [], txs = [];
const suite = inputs.every(([s]) => fs.existsSync(path.join(corpus,s,"rackstack_hinge.gcode"))) ? describe : describe.skip;

suite("Stage 04 Access over the three frozen complete corpus artifacts", function () {
  this.timeout(120000);
  let consumer, provider, demand, access, binding, keys;
  async function record(slicer, operation, pending) {
    const receipt = await (await pending).wait();
    txs.push({ slicer, operation, gas_used: receipt.gasUsed.toString(), transaction_hash: receipt.hash, status: receipt.status });
    return receipt.gasUsed;
  }
  before(async function () {
    [consumer,provider] = await ethers.getSigners(); keys = createAccessKeyPair();
    demand = await (await ethers.getContractFactory("Demand")).deploy(3072);
    access = await (await ethers.getContractFactory("OVCAccess")).deploy(100000);
    const identity = await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(100000,await demand.getAddress());
    const conformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(100000);
    const feature = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(100000);
    binding = await (await ethers.getContractFactory("BindingPhase")).deploy(await access.getAddress(),await identity.getAddress(),
      await conformance.getAddress(),await feature.getAddress(),await demand.getAddress());
    for(const c of [access,identity,conformance,feature]) await c.setCoordinator(await binding.getAddress());
    await record("setup","registerAccessPublicKey",binding.connect(provider).registerAccessPublicKey(keys.publicKey));
  });
  for (const [slicer,bytes,hash] of inputs) it(`validates private handover and an Access dispute for ${slicer} (${bytes} bytes)`,async function () {
    const plain = fs.readFileSync(path.join(corpus,slicer,"rackstack_hinge.gcode"));
    expect(plain.length).to.equal(bytes); expect(crypto.createHash("sha256").update(plain).digest("hex")).to.equal(hash);
    const key = crypto.randomBytes(32), nonce = crypto.randomBytes(12), cipher = chacha20(plain,key,nonce), hK = ethers.keccak256(key);
    await record(slicer,"postDemand",demand.postDemand(segmentedCommitment(plain,3072,PLAINTEXT_DOMAIN),
      segmentedCommitment(cipher,3072,CIPHERTEXT_DOMAIN),netExtrusion(plain.toString("utf8")),nonce,bytes,3072));
    const id = await demand.demandCount(); await record(slicer,"prepareBinding",demand.prepareBinding(id,provider.address));
    for(let offset=0;offset<cipher.length;offset+=3072) await record(slicer,"depositCiphertextChunk",
      demand.depositCiphertextChunk(id,cipher.subarray(offset,Math.min(offset+3072,cipher.length))));
    await record(slicer,"sealCiphertext",demand.sealCiphertext(id));
    const seed = crypto.randomBytes(32);
    const envelope = encryptAccessKey(key,keys.publicKey,provider.address,id,seed);
    await record(slicer,"bindProvider",binding.bindProvider(id,provider.address,hK,envelope,
      accessLinkCommitment(key,keys.publicKey,envelope),[0,0,0]));
    const handedOver = decryptAccessKey(Buffer.from(ethers.getBytes((await binding.bindings(id)).encryptedKey)),keys.privateKey,provider.address,id,hK);
    expect(handedOver.equals(key)).to.equal(true);
    expect(crypto.createHash("sha256").update(chacha20(cipher,handedOver,nonce)).digest("hex")).to.equal(hash);
    const [claimId] = await binding.getClaimIds(id);
    const disputeGas = await record(slicer,"disputeClaim",access.connect(provider).disputeClaim(claimId));
    const revealGas = await record(slicer,"revealWitness",access.connect(consumer).revealWitness(claimId,ethers.concat([key,seed])));
    expect((await access.claims(claimId)).outcome).to.equal(2n);
    rows.push({slicer,bytes,sha256:hash,network:"hardhat-local",chunk_bytes:3072,access_outcome:"Valid",
      envelope_bytes:envelope.length,private_handover_verified:true,dispute_gas:disputeGas.toString(),reveal_gas:revealGas.toString(),
      total_access_dispute_gas:(disputeGas+revealGas).toString()});
  });
  after(async function () {
    const bytecodes = {};
    for(const name of ["OVCAccess","BindingPhase","OVCIdentitySegmented","Demand"])
      bytecodes[name] = ethers.keccak256((await artifacts.readArtifact(name)).bytecode);
    const dir=path.join(stage,"results/validation");fs.mkdirSync(dir,{recursive:true});
    fs.writeFileSync(path.join(dir,"access-real-corpus.json"),JSON.stringify({observed_at_utc:new Date().toISOString(),
      scope:"Stage 04 local Hardhat; complete Demand publication, encrypted key handover and Access disputes; not a public testnet run",
      bytecodes,artifacts:rows,transactions:txs},null,2)+"\n");
  });
});
