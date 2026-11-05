/**
 * Public-testnet execution of the complete four-claim path (posting, deferred ciphertext
 * upload, binding, and Identity, Access, Conformance and Feature disputes), the same
 * sequence and fixtures as tests/pilot/corpus-ladder.js, so every receipt can be paired with
 * its local Anvil counterpart.
 *
 * Usage (from code/):
 *   npx hardhat run --network <sepolia|arbitrumSepolia|megaethTestnet> scripts/run-testnet-fullpath.js
 *
 * Environment:
 *   OVC_TESTNET_PRIVATE_KEY  funded signer (Consumer); the Provider key is derived from it
 *   OVC_ARTIFACT_KEYS        comma-separated model_id:slicer keys (default: the three rackstack_hinge outputs)
 *   OVC_TESTNET_CHUNK_BYTES  chunk size (default per network)
 *   OVC_RUN_DIR              run directory under results/raw-data (resumable; journals live there)
 *   OVC_ACCEPT_PATH=1        undisputed path: the Provider accepts all four claims after binding
 *
 * Every transaction is signed into a journal before broadcast, so a relaunch resumes without
 * duplicating any operation. Submission and receipt times are recorded for the time model.
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { chacha20 } = require("../tests/lib/chacha20");
const { encryptAccessKey, decryptAccessKey, accessLinkCommitment } = require("../tests/lib/access-envelope");
const { netExtrusion } = require("../tests/lib/gcode-reference");
const { PLAINTEXT_DOMAIN, CIPHERTEXT_DOMAIN, segmentedCommitment } = require("../tests/lib/segmented-commitment");
const { TransactionJournal, saveJson } = require("./transaction-journal");
const { receiptIdentifier } = require("./receipt-identifiers");

const NETWORKS = {
  sepolia: { chainId: 11155111n, chunk: 4160, cap: 16_777_216n,
    // Glamsterdam (EIP-8037) meters state gas outside the EIP-7825 execution cap.
    stateBudget: 60_000_000n },
  arbitrumSepolia: { chainId: 421614n, chunk: 8000, cap: 32_000_000n, stateBudget: 32_000_000n },
  // MegaETH meters storage and code deposit separately from its 200 M compute limit;
  // the network enforces its own limits, these budgets only guard the signer.
  megaethTestnet: { chainId: 6343n, chunk: 24960, cap: 200_000_000n, stateBudget: 1_000_000_000n, deployBudget: 1_000_000_000n },
  // Dry run against a local Anvil node, for pairing with the corpus ladder.
  localhost: { chainId: 31337n, chunk: 4160, cap: 16_777_216n, stateBudget: 60_000_000n },
};
const DISPUTE_WINDOW = 100_000;
// Receipt polling interval; it bounds the time resolution of every step (2 s before 08:10 UTC).
const POLL_MS = 250;
const ACCEPT_PATH = process.env.OVC_ACCEPT_PATH === "1";
const REIMBURSEMENT = 1n;
const STAGE_ROOT = path.join(__dirname, "..", "..");
const CORPUS_ROOT = process.env.OVC_CORPUS_ROOT || path.join(STAGE_ROOT, "data", "corpus", "generated");
const ARTIFACT_KEYS = (process.env.OVC_ARTIFACT_KEYS ||
  "rackstack_hinge:cura,rackstack_hinge:orca,rackstack_hinge:prusa").split(",").filter(Boolean);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function isTransient(error) {
  const message = String(error.shortMessage || error.message || error);
  return error.statusCode === 429 || /429|too many requests|rate limit|timeout|ECONNRESET|ETIMEDOUT|socket hang up|502|503|504|missing response|network error|block not found|header not found|unknown block|PENDING_EXTERNAL|STALE_NONCE|in-flight transaction limit|gapped-nonce|failed to call backend|backend endpoint|RECEIPT_TIMEOUT/i.test(message);
}

async function withRpcRetry(label, operation, attempts = 10) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isTransient(error) || attempt >= attempts) throw error;
      const waitMs = Math.min(60_000, 2_000 * (2 ** (attempt - 1)));
      console.warn(`${label}: transient RPC error; retry ${attempt}/${attempts} after ${waitMs} ms`);
      await sleep(waitMs);
    }
  }
}

function parseCsvLine(line) {
  const values = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; ++i) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; ++i; } else quoted = !quoted;
    } else if (ch === "," && !quoted) { values.push(current); current = ""; } else current += ch;
  }
  values.push(current);
  return values;
}

function loadArtifacts() {
  const lines = fs.readFileSync(path.join(CORPUS_ROOT, "gcode-manifest.csv"), "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
  const headers = parseCsvLine(lines.shift());
  const rows = lines.map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i]])));
  return ARTIFACT_KEYS.map(key => {
    const matches = rows.filter(row => `${row.model_id}:${row.slicer}` === key);
    if (matches.length !== 1) throw new Error(`Artifact ${key} not found exactly once in the frozen manifest`);
    return matches[0];
  });
}

// Same deterministic fixtures as the local ladder, so commitments and calldata match it.
function benchmarkSecret(domain, outputSha256, length) {
  return crypto.createHash("sha256").update(`OVC-ANVIL-PILOT-V1:${domain}:`).update(outputSha256).digest().subarray(0, length);
}

function csv(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const networkName = hre.network.name;
  const net = NETWORKS[networkName];
  if (!net) throw new Error(`Unsupported network ${networkName}`);
  if (!process.env.OVC_TESTNET_PRIVATE_KEY) throw new Error("OVC_TESTNET_PRIVATE_KEY is required");
  const chunkBytes = Number(process.env.OVC_TESTNET_CHUNK_BYTES || net.chunk);
  const runDir = path.join(STAGE_ROOT, "results", "raw-data",
    process.env.OVC_RUN_DIR || `testnet-fullpath-2026-10-29/${networkName}`);
  fs.mkdirSync(runDir, { recursive: true });

  const provider = ethers.provider;
  const network = await withRpcRetry("getNetwork", () => provider.getNetwork());
  if (network.chainId !== net.chainId) throw new Error("UNEXPECTED_CHAIN: refusing transaction submission");
  const consumer = new ethers.Wallet(process.env.OVC_TESTNET_PRIVATE_KEY, provider);
  const providerKey = ethers.keccak256(ethers.concat([process.env.OVC_TESTNET_PRIVATE_KEY, ethers.toUtf8Bytes("OVC-STAGE05-PROVIDER")]));
  const providerWallet = new ethers.Wallet(providerKey, provider);
  const clientVersion = await withRpcRetry("clientVersion", () => provider.send("web3_clientVersion", []));

  const statePath = path.join(runDir, "run-state.json");
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : {
    created_at_utc: new Date().toISOString(), network: networkName, chain_id: network.chainId.toString(),
    client_version: clientVersion, chunk_bytes: chunkBytes, consumer: consumer.address,
    provider: providerWallet.address, artifacts: {},
  };
  if (state.chunk_bytes !== chunkBytes || state.consumer !== consumer.address) throw new Error("CHECKPOINT_MISMATCH: run state differs");
  // Launch times separate relaunch gaps from client and network time in the time model.
  (state.launches ||= []).push(new Date().toISOString());
  if (!state.access_public_key) {
    // Benchmark Access key pair; its private half is a test fixture and is archived with the run.
    const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 0x10001 });
    state.access_public_key = publicKey.export({ type: "spki", format: "der" }).toString("hex");
    state.access_private_key_pem = privateKey.export({ type: "pkcs8", format: "pem" });
  }
  saveJson(statePath, state);
  const accessPublicKey = Buffer.from(state.access_public_key, "hex");
  const accessPrivateKey = crypto.createPrivateKey(state.access_private_key_pem);

  const bytecodes = {};
  for (const name of ["Demand", "OVCAccess", "OVCIdentitySegmented", "OVCConformanceSegmented", "OVCFeatureSegmented", "BindingPhase"]) {
    bytecodes[name] = ethers.keccak256((await hre.artifacts.readArtifact(name)).bytecode);
  }
  const identity = { network: networkName, chain_id: network.chainId.toString(), chunk_bytes: chunkBytes, bytecodes };
  const journals = {
    [consumer.address]: new TransactionJournal(path.join(runDir, "consumer.journal.json"), consumer,
      { ...identity, signer: consumer.address }, { reserveWei: ethers.parseEther("0.002"), cap: net.stateBudget, deploymentCap: net.deployBudget ?? 60_000_000n, pollMs: POLL_MS }),
    [providerWallet.address]: new TransactionJournal(path.join(runDir, "provider.journal.json"), providerWallet,
      { ...identity, signer: providerWallet.address }, { reserveWei: 0n, cap: net.stateBudget, pollMs: POLL_MS }),
  };

  const rows = [];
  const txPath = path.join(runDir, "transactions.csv");
  const headers = ["network", "artifact_key", "size_bytes", "chunk_size_bytes", "chunk_index", "operation", "signer",
    "estimate_gas", "gas_limit", "gas_used", "fee_wei", "tx_hash", "block_number", "submitted_at_utc", "receipt_at_utc",
    "submission_to_receipt_ms", "status", "poll_ms"];
  const persist = () => fs.writeFileSync(txPath, [headers.join(","), ...rows.map(r => headers.map(h => csv(r[h])).join(","))].join("\n") + "\n");

  // One named, journaled transaction. A replayed operation is read back from its receipt.
  async function call(wallet, artifact, operation, contract, method, args = [], { value = 0n, chunkIndex = "" } = {}) {
    const journal = journals[wallet.address];
    const op = artifact ? `${artifact.model_id}:${artifact.slicer}/${operation}${chunkIndex === "" ? "" : `[${chunkIndex}]`}` : operation;
    let estimate = "";
    const replay = journal.has(op);
    const send = async () => {
      if (replay) throw new Error("Unexpected replay send");
      const bound = contract.connect(wallet);
      // Load-balanced public RPCs can serve a backend that has not yet seen the previous receipt;
      // a revert at estimation (before signing) is therefore retried before it is believed.
      // An estimate above the budget (the MegaETH endpoint has returned its block limit after an
      // internal timeout) is likewise re-estimated before it is believed.
      const estimateStart = performance.now();
      for (let attempt = 1; ; attempt++) {
        try {
          estimate = await withRpcRetry(`${op} estimate`, () => bound[method].estimateGas(...args, { value }));
          journal.estimateMs = Math.round((performance.now() - estimateStart) * 10) / 10;
          if (estimate > net.stateBudget) throw new Error(`GAS_CAP: ${op} estimate ${estimate} exceeds ${net.stateBudget}`);
          break;
        } catch (error) {
          if (attempt >= 5 || !/execution reverted|GAS_CAP/i.test(String(error.shortMessage || error.message))) throw error;
          console.warn(`${op} estimate rejected (${String(error.shortMessage || error.message).slice(0, 80)}); retry ${attempt}/5 after 5000 ms`);
          await sleep(5000);
        }
      }
      const headroom = estimate / 20n > 100_000n ? estimate / 20n : 100_000n;
      // A lagging backend can also estimate a sweep against the state before the previous chunk
      // and return too little (Sepolia, 2 November 2026: featureProcessChunk ran out of gas), so the
      // limit is never below 1.05x the most this operation has used in the run.
      const used = Object.entries(journal.data.operations)
        .filter(([name, e]) => e.status === 1 && name.replace(/\[\d+\]$/, "").endsWith(`/${operation}`))
        .map(([, e]) => BigInt(e.gas_used));
      const floor = used.length ? used.reduce((a, b) => (a > b ? a : b)) * 21n / 20n : 0n;
      const wanted = estimate + headroom > floor ? estimate + headroom : floor;
      const gasLimit = wanted < net.stateBudget ? wanted : net.stateBudget;
      return bound[method](...args, { value, gasLimit });
    };
    const { receipt, entry } = await withRpcRetry(op, () => journal.execute(op, send));
    rows.push({ network: networkName, artifact_key: artifact ? `${artifact.model_id}:${artifact.slicer}` : "setup",
      size_bytes: artifact?.size_bytes ?? "", chunk_size_bytes: chunkBytes, chunk_index: chunkIndex, operation,
      signer: wallet === consumer ? "consumer" : "provider", estimate_gas: estimate, gas_limit: entry.gas_limit,
      gas_used: receipt.gasUsed, fee_wei: entry.fee_wei, tx_hash: entry.hash, block_number: receipt.blockNumber,
      submitted_at_utc: entry.submitted_at_utc, receipt_at_utc: entry.receipt_at_utc,
      submission_to_receipt_ms: Date.parse(entry.receipt_at_utc) - Date.parse(entry.submitted_at_utc), status: receipt.status,
      poll_ms: entry.poll_ms ?? 2000 });
    persist();
    if (rows.length % 25 === 0 || /finalize|Finalize|seal|bind|deploy/.test(operation)) {
      console.log(`[progress] ${new Date().toISOString()} ${op} gas ${receipt.gasUsed} block ${receipt.blockNumber} (${rows.length} receipts)`);
    }
    return receipt;
  }

  async function deploy(name, args) {
    const factory = await ethers.getContractFactory(name, consumer);
    const op = `deploy${name}`;
    const { receipt, entry } = await withRpcRetry(op, () => journals[consumer.address].execute(op,
      async () => (await factory.deploy(...args)).deploymentTransaction()));
    rows.push({ network: networkName, artifact_key: "setup", chunk_size_bytes: chunkBytes, operation: op, signer: "consumer",
      gas_limit: entry.gas_limit, gas_used: receipt.gasUsed, fee_wei: entry.fee_wei, tx_hash: entry.hash,
      block_number: receipt.blockNumber, submitted_at_utc: entry.submitted_at_utc, receipt_at_utc: entry.receipt_at_utc,
      submission_to_receipt_ms: Date.parse(entry.receipt_at_utc) - Date.parse(entry.submitted_at_utc), status: receipt.status });
    persist();
    console.log(`${op}: ${receipt.contractAddress} gas ${receipt.gasUsed}`);
    return factory.attach(receipt.contractAddress);
  }

  console.log(`${networkName} (${network.chainId}) ${clientVersion}; ${chunkBytes}-byte chunks; consumer ${consumer.address}; provider ${providerWallet.address}`);

  // Fund the derived Provider for its own transactions (disputes, key registration).
  const providerBalance = await withRpcRetry("provider balance", () => provider.getBalance(providerWallet.address));
  if (!journals[consumer.address].has("fundProvider") && providerBalance < ethers.parseEther("0.01")) {
    const amount = networkName === "arbitrumSepolia" ? "0.05" : "0.02";
    const { receipt } = await journals[consumer.address].execute("fundProvider", () => consumer.sendTransaction({ to: providerWallet.address, value: ethers.parseEther(amount) }));
    console.log(`fundProvider ${amount}: ${receipt.hash}`);
  }

  const demand = await deploy("Demand", [chunkBytes]);
  const access = await deploy("OVCAccess", [DISPUTE_WINDOW]);
  const identityC = await deploy("OVCIdentitySegmented", [DISPUTE_WINDOW, await demand.getAddress()]);
  const conformance = await deploy("OVCConformanceSegmented", [DISPUTE_WINDOW]);
  const feature = await deploy("OVCFeatureSegmented", [DISPUTE_WINDOW]);
  const binding = await deploy("BindingPhase", [await access.getAddress(), await identityC.getAddress(),
    await conformance.getAddress(), await feature.getAddress(), await demand.getAddress()]);
  state.contracts = { Demand: demand.target, OVCAccess: access.target, OVCIdentitySegmented: identityC.target,
    OVCConformanceSegmented: conformance.target, OVCFeatureSegmented: feature.target, BindingPhase: binding.target };
  saveJson(statePath, state);

  await call(providerWallet, null, "registerAccessPublicKey", binding, "registerAccessPublicKey", [accessPublicKey]);
  for (const [label, contract] of [["Access", access], ["Identity", identityC], ["Conformance", conformance], ["Feature", feature]]) {
    await call(consumer, null, `setCoordinator${label}`, contract, "setCoordinator", [binding.target]);
  }

  for (const artifact of loadArtifacts()) {
    const key0 = `${artifact.model_id}:${artifact.slicer}`;
    const plaintext = fs.readFileSync(path.join(CORPUS_ROOT, artifact.output_file));
    if (plaintext.length !== Number(artifact.size_bytes) ||
        crypto.createHash("sha256").update(plaintext).digest("hex") !== artifact.output_sha256) {
      throw new Error(`${key0}: corpus file does not match the frozen manifest`);
    }
    const st = state.artifacts[key0] ||= { access_seed: crypto.randomBytes(32).toString("hex") };
    saveJson(statePath, state);
    if (st.completed_at_utc) { console.log(`${key0}: already complete`); continue; }

    const key = benchmarkSecret("KEY", artifact.output_sha256, 32);
    const nonce = benchmarkSecret("NONCE", artifact.output_sha256, 12);
    const ciphertext = chacha20(plaintext, key, nonce);
    const hG = segmentedCommitment(plaintext, chunkBytes, PLAINTEXT_DOMAIN);
    const hC = segmentedCommitment(ciphertext, chunkBytes, CIPHERTEXT_DOMAIN);
    const hK = ethers.keccak256(key);
    const fClaim = netExtrusion(plaintext.toString("utf8"));
    const chunkCount = Math.ceil(plaintext.length / chunkBytes);

    const posted = await call(consumer, artifact, "postDemand", demand, "postDemand", [hG, hC, fClaim, nonce, ciphertext.length, chunkBytes]);
    const demandId = receiptIdentifier(posted, demand, "DemandPosted", "demandId", "consumer", consumer.address);
    await call(consumer, artifact, "prepareBinding", demand, "prepareBinding", [demandId, providerWallet.address]);
    for (let i = 0; i < chunkCount; ++i) {
      const chunk = ciphertext.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, ciphertext.length));
      await call(consumer, artifact, "depositCiphertextChunk", demand, "depositCiphertextChunk", [demandId, chunk], { chunkIndex: i });
    }
    await call(consumer, artifact, "sealCiphertext", demand, "sealCiphertext", [demandId]);

    const accessSeed = Buffer.from(st.access_seed, "hex");
    const envelope = encryptAccessKey(key, accessPublicKey, providerWallet.address, demandId, accessSeed);
    if (!decryptAccessKey(envelope, accessPrivateKey, providerWallet.address, demandId, hK).equals(key)) throw new Error("Access envelope check failed");
    const bound = await call(consumer, artifact, "bindProvider", binding, "bindProvider",
      [demandId, providerWallet.address, hK, envelope, accessLinkCommitment(key, accessPublicKey, envelope), [REIMBURSEMENT, REIMBURSEMENT, REIMBURSEMENT]]);
    const ev = bound.logs.map(log => { try { return binding.interface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === "ProviderBound");
    const { accessClaimId, identityClaimId, conformanceClaimId, featureClaimId } = ev.args;
    if (ACCEPT_PATH) {
      // Undisputed path: the Provider accepts all four claims after binding (R3).
      const accepted = await call(providerWallet, artifact, "acceptBinding", binding, "accept", [ev.args.bindingId]);
      for (const [label, verifier, claimId] of [["Access", access, accessClaimId], ["Identity", identityC, identityClaimId],
        ["Conformance", conformance, conformanceClaimId], ["Feature", feature, featureClaimId]]) {
        if ((await withRpcRetry(`read ${label} claim`, () => verifier.claims(claimId, { blockTag: accepted.blockNumber }))).outcome !== 1n) {
          throw new Error(`${key0}: ${label} not Accepted`);
        }
      }
      st.completed_at_utc = new Date().toISOString();
      st.outcome = "4 Accepted";
      saveJson(statePath, state);
      console.log(`COMPLETE ${key0}: 4 Accepted outcomes`);
      continue;
    }

    await call(providerWallet, artifact, "disputeClaim", identityC, "disputeClaim", [identityClaimId], { value: REIMBURSEMENT });
    await call(consumer, artifact, "revealKey", identityC, "revealKey", [identityClaimId, key]);
    await call(consumer, artifact, "startAdjudication", identityC, "startAdjudication", [identityClaimId]);
    for (let i = 0; i < chunkCount; ++i) await call(consumer, artifact, "processChunk", identityC, "processChunk", [identityClaimId], { chunkIndex: i });
    const idFinal = await call(consumer, artifact, "finalizeAdjudication", identityC, "finalizeAdjudication", [identityClaimId]);
    if ((await withRpcRetry("read Identity claim", () => identityC.claims(identityClaimId, { blockTag: idFinal.blockNumber }))).outcome !== 2n) throw new Error(`${key0}: Identity not Valid`);

    await call(providerWallet, artifact, "accessDisputeClaim", access, "disputeClaim", [accessClaimId]);
    const accFinal = await call(consumer, artifact, "accessRevealWitness", access, "revealWitness", [accessClaimId, ethers.concat([key, accessSeed])]);
    if ((await withRpcRetry("read Access claim", () => access.claims(accessClaimId, { blockTag: accFinal.blockNumber }))).outcome !== 2n) throw new Error(`${key0}: Access not Valid`);

    for (const [label, contract, claimId] of [["Conformance", conformance, conformanceClaimId], ["Feature", feature, featureClaimId]]) {
      const p = label.toLowerCase();
      await call(providerWallet, artifact, `${p}DisputeClaim`, contract, "disputeClaim", [claimId], { value: REIMBURSEMENT });
      for (let i = 0; i < chunkCount; ++i) {
        const chunk = plaintext.subarray(i * chunkBytes, Math.min((i + 1) * chunkBytes, plaintext.length));
        await call(consumer, artifact, `${p}DepositChunk`, contract, "depositChunk", [claimId, chunk], { chunkIndex: i });
      }
      await call(consumer, artifact, `${p}StartAdjudication`, contract, "startAdjudication", [claimId]);
      for (let i = 0; i < chunkCount; ++i) await call(consumer, artifact, `${p}ProcessChunk`, contract, "processChunk", [claimId], { chunkIndex: i });
      const fin = await call(consumer, artifact, `${p}FinalizeAdjudication`, contract, "finalizeAdjudication", [claimId]);
      if ((await withRpcRetry(`read ${label} claim`, () => contract.claims(claimId, { blockTag: fin.blockNumber }))).outcome !== 2n) throw new Error(`${key0}: ${label} not Valid`);
    }
    st.completed_at_utc = new Date().toISOString();
    st.outcome = "4 Valid";
    saveJson(statePath, state);
    console.log(`COMPLETE ${key0}: 4 Valid outcomes`);
  }
  state.completed_at_utc = new Date().toISOString();
  saveJson(statePath, state);
  console.log(`${networkName} complete; ${rows.length} receipts in ${txPath}`);
}

main().catch(error => {
  console.error(String(error.shortMessage || error.message || error).replace(/\s+/g, " ").slice(0, 800));
  process.exitCode = /PAUSED_FUNDS|insufficient funds/i.test(String(error.message)) ? 2 : 3;
});
