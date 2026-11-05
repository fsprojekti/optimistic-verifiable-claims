const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;
const { chacha20 } = require("../tests/lib/chacha20");
const { TransactionJournal } = require("./transaction-journal");
const { receiptIdentifier } = require("./receipt-identifiers");
const {
  PLAINTEXT_DOMAIN,
  CIPHERTEXT_DOMAIN,
  segmentedCommitment,
} = require("../tests/lib/segmented-commitment");

const CHUNK_BY_NETWORK = {
  sepolia: 3072,
  megaethTestnet: 3072,
  arbitrumSepolia: 3072,
};

const TX_CAP_BY_NETWORK = {
  hardhat: 1_000_000_000n,
  localhost: 1_000_000_000n,
  sepolia: 16_777_216n,
  arbitrumSepolia: 32_000_000n,
  megaethTestnet: 200_000_000n,
};

let persistRows = () => {};
let journal;
let signingWallet;

const interTransactionDelayMs = Number(process.env.OVC_TESTNET_DELAY_MS || 0);
if (!Number.isSafeInteger(interTransactionDelayMs) || interTransactionDelayMs < 0) {
  throw new Error("OVC_TESTNET_DELAY_MS must be a non-negative integer");
}

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const rpcBackoffs = [];

function isRateLimit(error) {
  const message = String(error.shortMessage || error.message || error);
  return error.statusCode === 429 || /429|too many requests|rate limit/i.test(message);
}

async function withRpcRetry(label, operation, attempts = 8) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (!isRateLimit(error) || attempt >= attempts) throw error;
      const waitMs = Math.min(30_000, 2_000 * (2 ** (attempt - 1)));
      console.warn(`${label}: RPC rate limited; retry ${attempt}/${attempts} after ${waitMs} ms`);
      rpcBackoffs.push({ atMs: Date.now(), waitMs, label });
      await sleep(waitMs);
    }
  }
}

async function pace() {
  if (interTransactionDelayMs > 0) await sleep(interTransactionDelayMs);
}

function csv(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function transactionGasLimit(estimate, cap) {
  const headroom = estimate / 20n > 200_000n ? estimate / 20n : 200_000n;
  const proposed = estimate + headroom;
  return proposed < cap ? proposed : cap;
}

async function record(rows, operation, send, details = {}) {
  if (journal) {
    const replay = journal.has(operation);
    const { receipt, entry } = await journal.execute(operation, send);
    rows.push({ operation, submitted_at_utc: entry.submitted_at_utc,
      receipt_at_utc: entry.receipt_at_utc, estimate_gas: details.estimateGas ?? "",
      gas_limit: entry.gas_limit, tx_hash: entry.hash, block_number: receipt.blockNumber,
      gas_used: receipt.gasUsed, submission_to_receipt_ms:
        Date.parse(entry.receipt_at_utc) - Date.parse(entry.submitted_at_utc), status: receipt.status });
    persistRows();
    console.log(`${replay ? "resume " : ""}${operation}: ${entry.hash} | gas ${receipt.gasUsed}`);
    if (!replay) await pace();
    return receipt;
  }
  const submittedAt = Date.now();
  const tx = await send();
  const receipt = await withRpcRetry(`${operation} receipt`, () => tx.wait());
  const includedAt = Date.now();
  rows.push({
    operation,
    submitted_at_utc: new Date(submittedAt).toISOString(),
    receipt_at_utc: new Date(includedAt).toISOString(),
    estimate_gas: details.estimateGas ?? "",
    gas_limit: tx.gasLimit,
    tx_hash: receipt.hash,
    block_number: receipt.blockNumber,
    gas_used: receipt.gasUsed,
    submission_to_receipt_ms: includedAt - submittedAt,
    status: receipt.status,
  });
  persistRows();
  console.log(`${operation}: ${receipt.hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`);
  await pace();
  return receipt;
}

async function deploy(rows, name, args = []) {
  const factory = await ethers.getContractFactory(name, signingWallet);
  if (journal) {
    const receipt = await record(rows, `deploy${name}`, async () => {
      const contract = await factory.deploy(...args);
      return contract.deploymentTransaction();
    });
    return factory.attach(receipt.contractAddress);
  }
  const submittedAt = Date.now();
  const contract = await factory.deploy(...args);
  const tx = contract.deploymentTransaction();
  const receipt = await withRpcRetry(`deploy${name} receipt`, () => tx.wait());
  const includedAt = Date.now();
  rows.push({
    operation: `deploy${name}`,
    submitted_at_utc: new Date(submittedAt).toISOString(),
    receipt_at_utc: new Date(includedAt).toISOString(),
    estimate_gas: "",
    gas_limit: tx.gasLimit,
    tx_hash: receipt.hash,
    block_number: receipt.blockNumber,
    gas_used: receipt.gasUsed,
    submission_to_receipt_ms: includedAt - submittedAt,
    status: receipt.status,
  });
  persistRows();
  console.log(`deploy${name}: ${receipt.hash} | block ${receipt.blockNumber} | gas ${receipt.gasUsed}`);
  await pace();
  return contract;
}

async function main() {
  if (!process.env.OVC_TESTNET_PRIVATE_KEY) {
    throw new Error("OVC_TESTNET_PRIVATE_KEY is required; no private key is stored in the repository");
  }
  const networkName = hre.network.name;
  const chunkBytes = Number(process.env.OVC_TESTNET_CHUNK_BYTES || CHUNK_BY_NETWORK[networkName]);
  if (!chunkBytes) throw new Error(`No chunk size configured for ${networkName}`);
  const txCap = TX_CAP_BY_NETWORK[networkName];
  if (!txCap) throw new Error(`No transaction cap configured for ${networkName}`);

  const corpusRoot = process.env.OVC_CORPUS_ROOT || path.join(
    __dirname,
    "..", "..", "..", "stage-02-secure-real-corpus-validation",
    "data", "corpus", "generated", "gcode", "cura"
  );
  const artifactPath = process.env.OVC_TESTNET_ARTIFACT || path.join(corpusRoot, "rackstack_hinge.gcode");
  const complete = fs.readFileSync(artifactPath);
  const requestedArtifactBytes = process.env.OVC_TESTNET_ARTIFACT_BYTES || String(chunkBytes);
  const artifactBytes = requestedArtifactBytes.toLowerCase() === "full"
    ? complete.length
    : Number(requestedArtifactBytes);
  if (!Number.isSafeInteger(artifactBytes) || artifactBytes <= 0) {
    throw new Error(`Invalid OVC_TESTNET_ARTIFACT_BYTES: ${requestedArtifactBytes}`);
  }
  const plaintext = complete.subarray(0, Math.min(artifactBytes, complete.length));
  const chunkCount = Math.ceil(plaintext.length / chunkBytes);
  const artifactSha256 = crypto.createHash("sha256").update(complete).digest("hex");
  const key = crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-KEY:${artifactSha256}`).digest();
  const nonce = crypto.createHash("sha256").update(`OVC-STAGE03-TESTNET-NONCE:${artifactSha256}`).digest().subarray(0, 12);
  const ciphertext = chacha20(plaintext, key, nonce);
  const hG = segmentedCommitment(plaintext, chunkBytes, PLAINTEXT_DOMAIN);
  const hC = segmentedCommitment(ciphertext, chunkBytes, CIPHERTEXT_DOMAIN);
  const hK = ethers.keccak256(key);
  const [defaultSigner] = await ethers.getSigners();
  const signer = process.env.OVC_TESTNET_CHECKPOINT
    ? new ethers.Wallet(process.env.OVC_TESTNET_PRIVATE_KEY, ethers.provider) : defaultSigner;
  signingWallet = signer;
  const rows = [];
  const network = await withRpcRetry("getNetwork", () => ethers.provider.getNetwork());
  const expectedChain = { hardhat: 31337, localhost: 31337, sepolia: 11155111,
    arbitrumSepolia: 421614, megaethTestnet: 6343 }[networkName];
  if (network.chainId !== BigInt(expectedChain)) throw new Error("UNEXPECTED_CHAIN: refusing transaction submission");
  if (process.env.OVC_TESTNET_ADDRESS &&
      signer.address.toLowerCase() !== process.env.OVC_TESTNET_ADDRESS.toLowerCase()) {
    throw new Error("SIGNER_MISMATCH: configured address differs from signing wallet");
  }
  const balance = await withRpcRetry("getBalance", () => ethers.provider.getBalance(signer.address));
  if (balance === 0n) throw new Error("PAUSED_FUNDS: configured signer has zero testnet balance");
  if (process.env.OVC_TESTNET_CHECKPOINT) {
    const bytecodes = {};
    for (const name of ["Demand", "OVCIdentitySegmented"]) {
      bytecodes[name] = ethers.keccak256((await hre.artifacts.readArtifact(name)).bytecode);
    }
    journal = new TransactionJournal(path.resolve(process.env.OVC_TESTNET_CHECKPOINT), signer, {
      network: networkName, chain_id: network.chainId.toString(), signer: signer.address,
      artifact_sha256: artifactSha256, sample_bytes: plaintext.length, chunk_bytes: chunkBytes,
      plaintext_commitment: hG, ciphertext_commitment: hC, bytecodes,
      pacing_ms: interTransactionDelayMs,
    }, { reserveWei: ethers.parseEther(process.env.OVC_TESTNET_RESERVE_ETH || "0.005"), cap: txCap,
      // Sepolia activated Glamsterdam on 2026-10-06. EIP-8037 separates state
      // gas from the EIP-7825 execution cap. 50M is our deployment budget,
      // not a claim about the network's execution-gas cap; RPC estimation applies.
      deploymentCap: networkName === "sepolia" ? 50_000_000n : txCap });
  }

  const headers = [
    "observed_at_utc", "network", "chain_id", "artifact_sha256", "sample_bytes", "chunk_bytes", "chunk_count",
    "operation", "submitted_at_utc", "receipt_at_utc", "estimate_gas", "gas_limit", "tx_hash",
    "block_number", "gas_used", "submission_to_receipt_ms", "status"
  ];
  const observed = journal?.data.created_at_utc || new Date().toISOString();
  const runId = observed.replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "..", "..", "results", "raw-data", "testnets", networkName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `identity-representative-${runId}.csv`);
  persistRows = () => {
    const enriched = rows.map(row => ({
      observed_at_utc: observed,
      network: networkName,
      chain_id: network.chainId,
      artifact_sha256: artifactSha256,
      sample_bytes: plaintext.length,
      chunk_bytes: chunkBytes,
      chunk_count: chunkCount,
      ...row,
    }));
    fs.writeFileSync(
      outPath,
      [headers.join(","), ...enriched.map(row => headers.map(h => csv(row[h])).join(","))].join("\n") + "\n",
      "utf8"
    );
  };

  console.log(`Network: ${networkName} (${network.chainId})`);
  console.log(`Signer: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} native test ETH`);
  console.log(`Artifact: ${artifactPath}`);
  console.log(`Workload: ${plaintext.length} bytes in ${chunkCount} chunk(s) of at most ${chunkBytes} bytes`);
  console.log(`Expected lifecycle transactions including setup: ${13 + (2 * chunkCount)}`);
  console.log(`Configured transaction cap: ${txCap}`);
  console.log(`Configured inter-transaction delay: ${interTransactionDelayMs} ms`);
  console.log(`Incremental results: ${outPath}`);

  const demand = await deploy(rows, "Demand", [chunkBytes]);
  const identity = await deploy(rows, "OVCIdentitySegmented", [100000, await demand.getAddress()]);
  await record(rows, "setCoordinator", () => identity.setCoordinator(signer.address));
  const posted = await record(rows, "postDemand", () => demand.postDemand(
    hG, hC, 0, nonce, ciphertext.length, chunkBytes
  ));
  const demandId = receiptIdentifier(posted, demand, "DemandPosted", "demandId", "consumer", signer.address);
  await record(rows, "prepareBinding", () => demand.prepareBinding(demandId, signer.address));
  for (let i = 0, offset = 0; offset < ciphertext.length; i++, offset += chunkBytes) {
    const chunk = ciphertext.subarray(offset, Math.min(offset + chunkBytes, ciphertext.length));
    if (journal?.has(`depositCiphertextChunk[${i}]`)) {
      await record(rows, `depositCiphertextChunk[${i}]`, () => { throw new Error("Unexpected replay send"); });
      continue;
    }
    const estimate = await withRpcRetry(
      `deposit chunk ${i} estimate`,
      () => demand.depositCiphertextChunk.estimateGas(demandId, chunk)
    );
    if (estimate >= txCap) throw new Error(`deposit chunk ${i} estimate ${estimate} reaches cap ${txCap}`);
    const gasLimit = transactionGasLimit(estimate, txCap);
    await record(rows, `depositCiphertextChunk[${i}]`, () => demand.depositCiphertextChunk(
      demandId, chunk, { gasLimit }
    ), { estimateGas: estimate });
  }
  await record(rows, "sealCiphertext", () => demand.sealCiphertext(demandId));
  const committed = await record(rows, "commitClaim", () => identity.commitClaim(
    signer.address, hC, hG, 0, hK
  ));
  const claimId = receiptIdentifier(committed, identity, "ClaimCommitted", "claimId", "claimant", signer.address);
  await record(rows, "setDemand", () => identity.setDemand(claimId, demandId));
  await record(rows, "configureWitnessTerms", () => identity.configureWitnessTerms(claimId, 0, 0));
  await record(rows, "disputeClaim", () => identity.disputeClaim(claimId));
  await record(rows, "revealKey", () => identity.revealKey(claimId, key));
  await record(rows, "startAdjudication", () => identity.startAdjudication(claimId));
  for (let i = 0; i < chunkCount; i++) {
    if (journal?.has(`processChunk[${i}]`)) {
      await record(rows, `processChunk[${i}]`, () => { throw new Error("Unexpected replay send"); });
      continue;
    }
    const estimate = await withRpcRetry(
      `process chunk ${i} estimate`,
      () => identity.processChunk.estimateGas(claimId)
    );
    if (estimate >= txCap) throw new Error(`process chunk ${i} estimate ${estimate} reaches cap ${txCap}`);
    const gasLimit = transactionGasLimit(estimate, txCap);
    await record(rows, `processChunk[${i}]`, () => identity.processChunk(
      claimId, { gasLimit }
    ), { estimateGas: estimate });
  }
  const finalized = await record(rows, "finalizeAdjudication", () => identity.finalizeAdjudication(claimId));
  const claim = await withRpcRetry("read final claim", () => identity.claims(claimId, { blockTag: finalized.blockNumber }));
  if (claim.outcome !== 2n) throw new Error(`Unexpected outcome ${claim.outcome}`);

  const protocolStartIndex = rows.findIndex(row => row.operation === "postDemand");
  const protocolEndIndex = rows.findIndex(row => row.operation === "finalizeAdjudication");
  const protocolRows = rows.slice(protocolStartIndex, protocolEndIndex + 1);
  const firstProtocolRow = protocolRows[0];
  const lastProtocolRow = protocolRows[protocolRows.length - 1];
  const firstBlock = await withRpcRetry(
    "read first protocol block", () => ethers.provider.getBlock(firstProtocolRow.block_number)
  );
  const lastBlock = await withRpcRetry(
    "read last protocol block", () => ethers.provider.getBlock(lastProtocolRow.block_number)
  );
  const phaseMs = (firstOperation, lastOperation) => {
    const first = rows.find(row => row.operation === firstOperation || row.operation.startsWith(firstOperation));
    const last = [...rows].reverse().find(
      row => row.operation === lastOperation || row.operation.startsWith(lastOperation)
    );
    return Date.parse(last.receipt_at_utc) - Date.parse(first.submitted_at_utc);
  };
  const clientWallClockMs =
    Date.parse(lastProtocolRow.receipt_at_utc) - Date.parse(firstProtocolRow.submitted_at_utc);
  const scheduledDelayMs = interTransactionDelayMs * Math.max(0, protocolRows.length - 1);
  const protocolStartMs = Date.parse(firstProtocolRow.submitted_at_utc);
  const protocolEndMs = Date.parse(lastProtocolRow.receipt_at_utc);
  const rpcBackoffMs = rpcBackoffs
    .filter(backoff => backoff.atMs >= protocolStartMs && backoff.atMs <= protocolEndMs)
    .reduce((sum, backoff) => sum + backoff.waitMs, 0);
  const summary = {
    observed_at_utc: observed,
    network: networkName,
    chain_id: network.chainId,
    artifact_path: artifactPath,
    artifact_sha256: artifactSha256,
    artifact_bytes: plaintext.length,
    chunk_bytes: chunkBytes,
    chunk_count: chunkCount,
    protocol_transaction_count: protocolRows.length,
    protocol_gas: protocolRows.reduce((sum, row) => sum + BigInt(row.gas_used), 0n),
    client_wall_clock_ms: clientWallClockMs,
    configured_inter_transaction_delay_ms: interTransactionDelayMs,
    scheduled_protocol_delay_ms: scheduledDelayMs,
    client_wall_clock_less_scheduled_delay_ms: Math.max(0, clientWallClockMs - scheduledDelayMs),
    rpc_rate_limit_backoff_ms: rpcBackoffMs,
    client_wall_clock_less_controlled_waits_ms:
      Math.max(0, clientWallClockMs - scheduledDelayMs - rpcBackoffMs),
    first_inclusion_block: firstProtocolRow.block_number,
    last_inclusion_block: lastProtocolRow.block_number,
    onchain_block_timestamp_span_s: Number(lastBlock.timestamp) - Number(firstBlock.timestamp),
    bidding_commitment_ms: phaseMs("postDemand", "postDemand"),
    binding_publication_phase_ms: phaseMs("prepareBinding", "sealCiphertext"),
    binding_dispute_phase_ms: phaseMs("commitClaim", "startAdjudication"),
    adjudication_phase_ms: phaseMs("processChunk", "finalizeAdjudication"),
    outcome: "Valid",
    checkpoint_launches: journal?.data.launches ?? 1,
    timing_interrupted: (journal?.data.launches ?? 1) > 1,
  };
  const summaryPath = path.join(outDir, `identity-representative-${runId}-summary.csv`);
  const summaryHeaders = Object.keys(summary);
  fs.writeFileSync(
    summaryPath,
    [summaryHeaders.join(","), summaryHeaders.map(header => csv(summary[header])).join(",")].join("\n") + "\n",
    "utf8"
  );

  const enriched = rows.map(row => ({
    observed_at_utc: observed,
    network: networkName,
    chain_id: network.chainId,
    artifact_sha256: artifactSha256,
    sample_bytes: plaintext.length,
    chunk_bytes: chunkBytes,
    chunk_count: chunkCount,
    ...row,
  }));
  persistRows();
  if (enriched.length <= 50) {
    console.table(enriched.map(({ tx_hash, artifact_sha256, ...row }) => row));
  } else {
    console.log(`${enriched.length} transaction rows saved; suppressing the large terminal table.`);
  }
  console.log(outPath);
  console.table([summary]);
  console.log(summaryPath);
  if (journal) {
    journal.data.completed_at_utc = new Date().toISOString();
    journal.data.summary_path = summaryPath;
    journal.data.transaction_csv_path = outPath;
    journal.data.outcome = "Valid";
    journal.save();
  }
}

main().catch(error => {
  const message = String(error.shortMessage || error.message || error).replace(/\s+/g, " ").slice(0, 500);
  console.error(message);
  process.exitCode = /PAUSED_FUNDS|insufficient funds/i.test(message) ? 2
    : /CHECKPOINT_MISMATCH|UNEXPECTED_CHAIN|SIGNER_MISMATCH|RECEIPT_IDENTITY|GAS_CAP|REVERTED_TRANSACTION|REORG_REVIEW|execution reverted/i.test(message) ? 4 : 3;
});
