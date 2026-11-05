"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { TransactionJournal, saveJson } = require("./transaction-journal");
const { receiptIdentifier } = require("./receipt-identifiers");
const { chacha20 } = require("../tests/lib/chacha20");
const { PLAINTEXT_DOMAIN, CIPHERTEXT_DOMAIN, segmentedCommitment } = require("../tests/lib/segmented-commitment");
const { createAccessKeyPair, encryptAccessKey, decryptAccessKey, accessLinkCommitment } = require("../tests/lib/access-envelope");

const STAGE = path.resolve(__dirname, "../..");
const PROJECT = path.resolve(STAGE, "../..");
const CAMPAIGN = path.join(STAGE, "results/access-testnets/2026-10-14");
const PRIVATE = path.join(PROJECT, ".secrets/stage04-access-2026-10-14");
const CHAINS = { sepolia: 11155111n, arbitrumSepolia: 421614n, megaethTestnet: 6343n };
const NAMES = ["OVCAccess", "OVCIdentitySegmented", "OVCConformanceSegmented", "OVCFeatureSegmented", "BindingPhase"];
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");

function safeError(error) {
  return String(error.shortMessage || error.code || error.message || "Unknown failure")
    .replace(/0x[0-9a-fA-F]{64,}/g, "[hex redacted]").replace(/https?:\/\/\S+/g, "[RPC]").slice(0, 240);
}

function publicState(data) {
  const copy = JSON.parse(JSON.stringify(data));
  for (const operation of Object.values(copy.operations)) delete operation.raw;
  return copy;
}

async function readRetry(read, attempts = 6) {
  for (let n = 0; ; ++n) {
    try { return await read(); }
    catch (error) {
      if (n + 1 >= attempts || /CALL_EXCEPTION|INVALID_ARGUMENT/.test(error.code || "")) throw error;
      await wait(Math.min(10000, 1000 * 2 ** n));
    }
  }
}

function secrets(file, pendingFile) {
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  if (fs.existsSync(pendingFile)) throw Error("Missing RSA opening for an existing journal; refusing regeneration");
  const keys = createAccessKeyPair();
  const value = { public_key: keys.publicKey.toString("hex"),
    private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }), seed: crypto.randomBytes(32).toString("hex") };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  return value;
}

async function runAccessJob(hre, options) {
  const { ethers } = hre;
  const { wallet, reference, output, privateDirectory, reserveWei = ethers.parseEther("0.005"), paceMs = 1000 } = options;
  const provider = wallet.provider;
  const chain = await provider.getNetwork();
  const plain = reference.plaintext;
  const artifactHash = sha256(plain);
  if (artifactHash !== reference.artifactSha256) throw Error("Artifact hash mismatch");
  const key = crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-KEY:${artifactHash}`).digest();
  const nonce = crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-NONCE:${artifactHash}`).digest().subarray(0, 12);
  const cipher = chacha20(plain, key, nonce), hK = ethers.keccak256(key);
  const hG = segmentedCommitment(plain, 3072, PLAINTEXT_DOMAIN), hC = segmentedCommitment(cipher, 3072, CIPHERTEXT_DOMAIN);
  const demand = await ethers.getContractAt("Demand", reference.demandAddress, wallet);
  const id = BigInt(reference.demandId);
  const record = await readRetry(() => demand.demands(id));
  if (record.consumer.toLowerCase() !== wallet.address.toLowerCase() ||
      record.selectedProvider.toLowerCase() !== wallet.address.toLowerCase() ||
      record.hG !== hG || record.hC !== hC || record.nonce !== ethers.hexlify(nonce) ||
      record.totalCiphertextBytes !== BigInt(plain.length) || record.chunkSize !== 3072n || record.state !== 3n) {
    throw Error("Source demand does not match the frozen artifact, actor or sealed profile");
  }
  const bytecodes = {};
  for (const name of ["Demand", ...NAMES]) bytecodes[name] = ethers.keccak256((await hre.artifacts.readArtifact(name)).bytecode);
  const sources = [path.basename(__filename), "transaction-journal.js", "receipt-identifiers.js"].map(name => [name, sha256(fs.readFileSync(path.join(__dirname, name)))]);
  sources.push(["access-envelope.js", sha256(fs.readFileSync(path.join(__dirname, "../tests/lib/access-envelope.js")))]);
  const journalFile = path.join(privateDirectory, "transactions.private.json");
  const privateMaterial = secrets(path.join(privateDirectory, "rsa.private.json"), journalFile);
  const publicKey = Buffer.from(privateMaterial.public_key, "hex"), seed = Buffer.from(privateMaterial.seed, "hex");
  const envelope = encryptAccessKey(key, publicKey, wallet.address, id, seed);
  const identity = { profile: "stage04-access-rsa-oaep-v1", network: reference.network, chain_id: chain.chainId.toString(),
    signer: wallet.address, provider: wallet.address, consumer_provider_same_account: true,
    slicer: reference.slicer, artifact_sha256: artifactHash, artifact_bytes: plain.length, source_demand: reference.demandAddress,
    source_demand_id: id.toString(), source_checkpoint_sha256: reference.sourceCheckpointSha256,
    plaintext_commitment: hG, ciphertext_commitment: hC, public_key_sha256: sha256(publicKey), envelope_hash: ethers.keccak256(envelope),
    bytecodes, runner_sources: sources, pacing_ms: paceMs };
  const journal = new TransactionJournal(journalFile, wallet, identity, {
    reserveWei, cap: chain.chainId === 11155111n ? 16777216n : chain.chainId === 6343n ? 200000000n : 32000000n,
    deploymentCap: chain.chainId === 11155111n ? 50000000n : chain.chainId === 6343n ? 200000000n : 32000000n, timeoutMs: 120000 });
  const exportState = () => saveJson(output, publicState(journal.data));
  exportState();
  async function execute(operation, send) {
    const replay = journal.has(operation);
    try {
      const { receipt } = await journal.execute(operation, send);
      console.log(`${reference.slicer} ${replay ? "resume " : ""}${operation}: ${receipt.hash} | gas ${receipt.gasUsed}`);
      exportState(); if (!replay && paceMs) await wait(paceMs);
      return receipt;
    } finally { exportState(); }
  }
  async function deploy(name, args) {
    const factory = await ethers.getContractFactory(name, wallet);
    const receipt = await execute(`deploy${name}`, async () => {
      const request = await factory.getDeployTransaction(...args);
      const estimate = await provider.estimateGas({ ...request, from: wallet.address });
      return wallet.sendTransaction({ ...request, gasLimit: estimate + estimate / 10n + 100000n });
    });
    if (!receipt.contractAddress) throw Error("Deployment receipt has no address");
    return factory.attach(receipt.contractAddress);
  }
  const access = await deploy("OVCAccess", [100000]);
  const identityContract = await deploy("OVCIdentitySegmented", [100000, demand.target]);
  const conformance = await deploy("OVCConformanceSegmented", [100000]);
  const feature = await deploy("OVCFeatureSegmented", [100000]);
  const binding = await deploy("BindingPhase", [access.target, identityContract.target, conformance.target, feature.target, demand.target]);
  for (const [name, contract] of [["Access", access], ["Identity", identityContract], ["Conformance", conformance], ["Feature", feature]]) {
    await execute(`setCoordinator${name}`, () => contract.setCoordinator(binding.target));
  }
  await execute("registerAccessPublicKey", () => binding.registerAccessPublicKey(publicKey));
  const boundReceipt = await execute("bindProvider", () => binding.bindProvider(id, wallet.address, hK, envelope,
    accessLinkCommitment(key, publicKey, envelope), [0, 0, 0]));
  const bindingId = receiptIdentifier(boundReceipt, binding, "ProviderBound", "bindingId", "provider", wallet.address);
  let boundEvent;
  for (const log of boundReceipt.logs) {
    if (log.address.toLowerCase() !== binding.target.toLowerCase()) continue;
    try { const parsed = binding.interface.parseLog(log); if (parsed?.name === "ProviderBound") boundEvent = parsed.args; } catch {}
  }
  if (!boundEvent) throw Error("Missing bound claim IDs");
  const accessId = boundEvent.accessClaimId;
  const bound = await readRetry(() => binding.bindings(bindingId, { blockTag: boundReceipt.blockNumber }));
  const recovered = decryptAccessKey(Buffer.from(ethers.getBytes(bound.encryptedKey)), crypto.createPrivateKey(privateMaterial.private_key),
    wallet.address, id, hK);
  // Verify all ciphertext bytes read from the existing on-chain Demand store.
  const parts = [], count = Math.ceil(plain.length / 3072);
  for (let i = 0; i < count; i += 2) {
    const read = await Promise.all(Array.from({ length: Math.min(2, count - i) }, (_, j) =>
      readRetry(() => demand.getCiphertextChunk(id, i + j))));
    parts.push(...read.map(x => Buffer.from(ethers.getBytes(x))));
    if (paceMs) await wait(Math.min(paceMs, 100));
  }
  const onchainCipher = Buffer.concat(parts);
  if (!onchainCipher.equals(cipher) || sha256(chacha20(onchainCipher, recovered, nonce)) !== artifactHash) {
    throw Error("Full on-chain ciphertext handover failed");
  }
  const wrong = createAccessKeyPair();
  let unauthorizedRejected = false;
  try { decryptAccessKey(envelope, wrong.privateKey, wallet.address, id, hK); } catch { unauthorizedRejected = true; }
  if (!unauthorizedRejected) throw Error("Wrong RSA recipient unexpectedly decrypted the key");
  await execute("disputeClaim", () => access.disputeClaim(accessId));
  const finalReceipt = await execute("revealWitness", () => access.revealWitness(accessId, ethers.concat([key, seed])));
  const claim = await readRetry(() => access.claims(accessId, { blockTag: finalReceipt.blockNumber }));
  if (claim.outcome !== 2n || claim.state !== 4n || claim.commitment !== hK ||
      claim.providerKeyHash !== ethers.keccak256(publicKey) || claim.auxHash !== accessLinkCommitment(key, publicKey, envelope)) {
    throw Error("Access verdict or bound fields mismatch");
  }
  const operations = Object.values(journal.data.operations);
  if (operations.length !== 13 || operations.some(op => op.status !== 1 || op.raw)) throw Error("Incomplete operation coverage");
  journal.data.outcome = "Valid"; journal.data.completed_at_utc = new Date().toISOString();
  journal.data.summary = {
    binding_id: bindingId.toString(), access_claim_id: accessId.toString(), access_address: access.target,
    binding_address: binding.target, reused_ciphertext: true, ciphertext_chunks_read: count,
    complete_artifact_recovered: true, unauthorized_rsa_recipient_rejected: true,
    publicly_known_artifact_key_fixture: true, public_confidentiality_proof: false,
    full_pipeline_predicates_executed: false, access_dispute_gas:
      (BigInt(journal.data.operations.disputeClaim.gas_used) + BigInt(journal.data.operations.revealWitness.gas_used)).toString(),
    successful_transactions: operations.length, total_fee_wei: operations.reduce((x,op) => x + BigInt(op.fee_wei),0n).toString(),
    timing_interrupted: journal.data.launches > 1,
    wall_clock_ms: Date.now() - Date.parse(journal.data.created_at_utc) };
  journal.save(); exportState();
  console.log(`${reference.network} ${reference.slicer}: VALID; all ${plain.length} bytes recovered; 13 successful transactions`);
  return publicState(journal.data);
}

async function campaignMain(hre) {
  const { ethers } = hre, name = hre.network.name;
  if (!CHAINS[name]) throw Error("Only explicitly configured public testnets are allowed");
  if (!process.env.OVC_TESTNET_PRIVATE_KEY) throw Error("Test account is not configured");
  const wallet = new ethers.Wallet(process.env.OVC_TESTNET_PRIVATE_KEY, ethers.provider);
  const actual = await ethers.provider.getNetwork();
  if (actual.chainId !== CHAINS[name] || wallet.address.toLowerCase() !== "0x3ffaa6b60c24356123b1eed5f4570400ac4efcb5") {
    throw Error("Unexpected network or research account; refusing submission");
  }
  const statusFile = path.join(CAMPAIGN,name,"status.json");
  for (const slicer of ["cura","orca","prusa"]) {
    const output = path.join(CAMPAIGN,name,`${slicer}.json`);
    if (fs.existsSync(output) && JSON.parse(fs.readFileSync(output,"utf8")).outcome === "Valid") continue;
    const sourceFile = path.join(STAGE,`results/raw-data/duration-campaigns/d5-recovery-2026-10-12/${name}/full-${slicer}.checkpoint.json`);
    const sourceBytes = fs.readFileSync(sourceFile), source = JSON.parse(sourceBytes);
    if (source.outcome !== "Valid" || source.identity.signer.toLowerCase() !== wallet.address.toLowerCase()) throw Error("Unqualified source checkpoint");
    const receipt = await readRetry(async () => {
      const found = await ethers.provider.getTransactionReceipt(source.operations.postDemand.hash);
      if (!found) throw Error("Source posting receipt unavailable"); return found;
    });
    const oldDemand = await ethers.getContractAt("Demand",source.operations.deployDemand.contract_address,wallet);
    const demandId = receiptIdentifier(receipt,oldDemand,"DemandPosted","demandId","consumer",wallet.address);
    const plaintext = fs.readFileSync(path.join(STAGE,`data/corpus/generated/gcode/${slicer}/rackstack_hinge.gcode`));
    let complete = false;
    for (let attempt = 1; attempt <= 15; ++attempt) {
      saveJson(statusFile,{network:name,state:"running",current_job:slicer,attempt,updated_at_utc:new Date().toISOString()});
      try {
        await runAccessJob(hre,{wallet:new ethers.Wallet(process.env.OVC_TESTNET_PRIVATE_KEY,ethers.provider),output,
          privateDirectory:path.join(PRIVATE,name,slicer),reference:{network:name,slicer,plaintext,
            artifactSha256:source.identity.artifact_sha256,demandAddress:oldDemand.target,demandId,
            sourceCheckpointSha256:sha256(sourceBytes)}});
        complete = true; break;
      } catch(error) {
        const summary = safeError(error);
        const fatal = /mismatch|refusing|REVERTED_TRANSACTION|CHECKPOINT_MISMATCH|CALL_EXCEPTION|Incomplete operation|Missing RSA|GAS_CAP|Unexpected|Unsupported/.test(summary+" "+(error.code||""));
        saveJson(statusFile,{network:name,state:fatal?"failed":"retrying",current_job:slicer,attempt,error:summary,updated_at_utc:new Date().toISOString()});
        console.error(`${name} ${slicer}: ${summary}; ${fatal?"stopping":"retry in 30 s"}`);
        if (fatal) throw Error(summary);
        await wait(30000);
      }
    }
    if (!complete) throw Error("Retry budget exhausted; checkpoint preserved");
  }
  saveJson(statusFile,{network:name,state:"complete",completed_jobs:3,updated_at_utc:new Date().toISOString()});
}

module.exports = { runAccessJob, publicState, safeError, campaignMain };
if (require.main === module) {
  const hre = require("hardhat");
  campaignMain(hre).catch(error => {
    const summary = safeError(error);
    saveJson(path.join(CAMPAIGN,hre.network.name,"status.json"),{
      network:hre.network.name,state:"failed",error:summary,updated_at_utc:new Date().toISOString()
    });
    console.error(summary); process.exitCode=1;
  });
}
