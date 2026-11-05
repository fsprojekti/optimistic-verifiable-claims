const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const hre = require("hardhat");
const { ethers } = hre;
const { chacha20 } = require("../tests/lib/chacha20");
const {
  PLAINTEXT_DOMAIN,
  CIPHERTEXT_DOMAIN,
  segmentedCommitment,
} = require("../tests/lib/segmented-commitment");

const TX_CAP_BY_NETWORK = {
  hardhat: 1_000_000_000n,
  sepolia: 16_777_216n,
  arbitrumSepolia: 32_000_000n,
  megaethTestnet: 200_000_000n,
};

const interTransactionDelayMs = Number(process.env.OVC_TESTNET_DELAY_MS || 0);
if (!Number.isSafeInteger(interTransactionDelayMs) || interTransactionDelayMs < 0) {
  throw new Error("OVC_TESTNET_DELAY_MS must be a non-negative integer");
}
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

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
      await sleep(waitMs);
    }
  }
}

async function pace() {
  if (interTransactionDelayMs > 0) await sleep(interTransactionDelayMs);
}

function csv(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function errorText(error) {
  return String(error.shortMessage || error.reason || error.message || error).replace(/\s+/g, " ").slice(0, 300);
}

function transactionGasLimit(estimate, cap) {
  const headroom = estimate / 20n > 200_000n ? estimate / 20n : 200_000n;
  const proposed = estimate + headroom;
  return proposed < cap ? proposed : cap;
}

async function main() {
  if (!process.env.OVC_TESTNET_PRIVATE_KEY) {
    throw new Error("OVC_TESTNET_PRIVATE_KEY is required in the ignored project-root .env");
  }

  const networkName = hre.network.name;
  const txCap = TX_CAP_BY_NETWORK[networkName];
  if (!txCap) throw new Error(`No transaction cap configured for ${networkName}`);

  const sizes = (process.env.OVC_CHUNK_PROBE_BYTES || "1024,2048,3072,4096")
    .split(",")
    .map(value => Number(value.trim()))
    .filter(Number.isFinite);
  if (!sizes.length || sizes.some(size => !Number.isSafeInteger(size) || size <= 0)) {
    throw new Error("OVC_CHUNK_PROBE_BYTES must be a comma-separated list of positive integers");
  }
  for (let i = 1; i < sizes.length; i++) {
    if (sizes[i] <= sizes[i - 1]) throw new Error("Chunk probe sizes must be strictly increasing");
  }

  const corpusRoot = process.env.OVC_CORPUS_ROOT || path.join(
    __dirname,
    "..", "..", "..", "stage-02-secure-real-corpus-validation",
    "data", "corpus", "generated", "gcode", "cura"
  );
  const artifactPath = process.env.OVC_TESTNET_ARTIFACT || path.join(corpusRoot, "rackstack_hinge.gcode");
  const artifact = fs.readFileSync(artifactPath);
  if (sizes[sizes.length - 1] > artifact.length) {
    throw new Error(`Largest probe (${sizes[sizes.length - 1]}) exceeds artifact size (${artifact.length})`);
  }

  const artifactSha256 = crypto.createHash("sha256").update(artifact).digest("hex");
  const key = crypto.createHash("sha256").update(`OVC-STAGE03-PROBE-KEY:${artifactSha256}`).digest();
  const nonce = crypto.createHash("sha256").update(`OVC-STAGE03-PROBE-NONCE:${artifactSha256}`).digest().subarray(0, 12);
  const hK = ethers.keccak256(key);
  const [signer] = await ethers.getSigners();
  const network = await withRpcRetry("getNetwork", () => ethers.provider.getNetwork());
  const balance = await withRpcRetry("getBalance", () => ethers.provider.getBalance(signer.address));
  if (balance === 0n) throw new Error(`${networkName}: configured signer has zero testnet balance`);

  const observed = new Date().toISOString();
  const runId = observed.replace(/[:.]/g, "-");
  const outDir = path.join(__dirname, "..", "..", "results", "raw-data", "chunk-probes", networkName);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `identity-chunk-probe-${runId}.csv`);
  const headers = [
    "observed_at_utc", "network", "chain_id", "artifact_sha256", "chunk_bytes",
    "operation", "method", "estimate_gas", "gas_limit", "actual_gas", "tx_hash",
    "block_number", "submission_to_receipt_ms", "status", "note"
  ];
  const rows = [];
  const persist = () => fs.writeFileSync(
    outPath,
    [headers.join(","), ...rows.map(row => headers.map(header => csv(row[header])).join(","))].join("\n") + "\n",
    "utf8"
  );
  const addRow = row => {
    rows.push({
      observed_at_utc: observed,
      network: networkName,
      chain_id: network.chainId,
      artifact_sha256: artifactSha256,
      ...row,
    });
    persist();
  };

  async function send(chunkBytes, operation, sendTransaction, details = {}) {
    const tx = await sendTransaction();
    const submittedAt = Date.now();
    let receipt;
    let waitError;
    try {
      receipt = await withRpcRetry(`${operation} receipt`, () => tx.wait());
    } catch (error) {
      if (!error.receipt) throw error;
      receipt = error.receipt;
      waitError = error;
    }
    addRow({
      chunk_bytes: chunkBytes,
      operation,
      method: "transaction",
      estimate_gas: details.estimateGas ?? "",
      gas_limit: tx.gasLimit,
      actual_gas: receipt.gasUsed,
      tx_hash: receipt.hash,
      block_number: receipt.blockNumber,
      submission_to_receipt_ms: Date.now() - submittedAt,
      status: receipt.status === 1 ? "TX_OK" : "TX_FAILED",
      note: waitError ? errorText(waitError) : (details.note ?? ""),
    });
    console.log(`${chunkBytes || "setup"} | ${operation} | gas ${receipt.gasUsed} | ${receipt.hash}`);
    if (receipt.status !== 1) throw new Error(`${operation} transaction failed: ${errorText(waitError)}`);
    await pace();
    return receipt;
  }

  console.log(`Network: ${networkName} (${network.chainId})`);
  console.log(`Signer: ${signer.address}`);
  console.log(`Balance: ${ethers.formatEther(balance)} native test ETH`);
  console.log(`Configured transaction cap: ${txCap}`);
  console.log(`Probe sizes: ${sizes.join(", ")} bytes`);
  console.log(`Configured inter-transaction delay: ${interTransactionDelayMs} ms`);
  console.log(`Incremental results: ${outPath}`);

  const demandFactory = await ethers.getContractFactory("Demand");
  const demand = await demandFactory.deploy(sizes[sizes.length - 1]);
  const demandDeploy = demand.deploymentTransaction();
  const demandSubmitted = Date.now();
  const demandReceipt = await withRpcRetry("deployDemand receipt", () => demandDeploy.wait());
  addRow({
    chunk_bytes: "", operation: "deployDemand", method: "transaction", estimate_gas: "",
    gas_limit: demandDeploy.gasLimit, actual_gas: demandReceipt.gasUsed, tx_hash: demandReceipt.hash,
    block_number: demandReceipt.blockNumber, submission_to_receipt_ms: Date.now() - demandSubmitted,
    status: "TX_OK", note: "shared deployment",
  });
  await pace();

  const identityFactory = await ethers.getContractFactory("OVCIdentitySegmented");
  const identity = await identityFactory.deploy(100000, await demand.getAddress());
  const identityDeploy = identity.deploymentTransaction();
  const identitySubmitted = Date.now();
  const identityReceipt = await withRpcRetry(
    "deployOVCIdentitySegmented receipt", () => identityDeploy.wait()
  );
  addRow({
    chunk_bytes: "", operation: "deployOVCIdentitySegmented", method: "transaction", estimate_gas: "",
    gas_limit: identityDeploy.gasLimit, actual_gas: identityReceipt.gasUsed, tx_hash: identityReceipt.hash,
    block_number: identityReceipt.blockNumber, submission_to_receipt_ms: Date.now() - identitySubmitted,
    status: "TX_OK", note: "shared deployment",
  });
  await pace();
  await send("", "setCoordinator", () => identity.setCoordinator(signer.address), { note: "shared setup" });

  for (const chunkBytes of sizes) {
    console.log(`\n--- probing ${chunkBytes} bytes ---`);
    try {
      const plaintext = artifact.subarray(0, chunkBytes);
      const ciphertext = chacha20(plaintext, key, nonce);
      const hG = segmentedCommitment(plaintext, chunkBytes, PLAINTEXT_DOMAIN);
      const hC = segmentedCommitment(ciphertext, chunkBytes, CIPHERTEXT_DOMAIN);

      await send(chunkBytes, "postDemand", () => demand.postDemand(
        hG, hC, 0, nonce, ciphertext.length, chunkBytes
      ));
      const demandId = await withRpcRetry("demandCount", () => demand.demandCount());
      await send(chunkBytes, "prepareBinding", () => demand.prepareBinding(
        demandId, signer.address
      ));

      const depositEstimate = await withRpcRetry(
        `deposit ${chunkBytes} estimate`,
        () => demand.depositCiphertextChunk.estimateGas(demandId, ciphertext)
      );
      if (depositEstimate > txCap) {
        throw new Error(`deposit estimate ${depositEstimate} reaches configured transaction cap ${txCap}`);
      }
      const depositLimit = transactionGasLimit(depositEstimate, txCap);
      await send(
        chunkBytes,
        "depositCiphertextChunk",
        () => demand.depositCiphertextChunk(demandId, ciphertext, { gasLimit: depositLimit }),
        { estimateGas: depositEstimate }
      );
      await send(chunkBytes, "sealCiphertext", () => demand.sealCiphertext(demandId));
      await send(chunkBytes, "commitClaim", () => identity.commitClaim(signer.address, hC, hG, 0, hK));
      const claimId = await withRpcRetry("claimCount", () => identity.claimCount());
      await send(chunkBytes, "setDemand", () => identity.setDemand(claimId, demandId));
      await send(chunkBytes, "configureWitnessTerms", () => identity.configureWitnessTerms(claimId, 0, 0));
      await send(chunkBytes, "disputeClaim", () => identity.disputeClaim(claimId));
      await send(chunkBytes, "revealKey", () => identity.revealKey(claimId, key));
      await send(chunkBytes, "startAdjudication", () => identity.startAdjudication(claimId));

      const processEstimate = await withRpcRetry(
        `process ${chunkBytes} estimate`,
        () => identity.processChunk.estimateGas(claimId)
      );
      addRow({
        chunk_bytes: chunkBytes,
        operation: "processChunk",
        method: "eth_estimateGas",
        estimate_gas: processEstimate,
        gas_limit: txCap,
        actual_gas: "",
        tx_hash: "",
        block_number: "",
        submission_to_receipt_ms: "",
        status: processEstimate < txCap ? "ESTIMATE_OK" : "ESTIMATE_AT_CAP",
        note: `configured transaction cap ${txCap}`,
      });
      if (processEstimate > txCap) {
        throw new Error(`process estimate ${processEstimate} exceeds configured transaction cap ${txCap}`);
      }

      const processLimit = transactionGasLimit(processEstimate, txCap);
      await send(
        chunkBytes,
        "processChunk",
        () => identity.processChunk(claimId, { gasLimit: processLimit }),
        { estimateGas: processEstimate, note: `configured cap ${txCap}` }
      );
      await send(chunkBytes, "finalizeAdjudication", () => identity.finalizeAdjudication(claimId));
      const claim = await withRpcRetry("read final claim", () => identity.claims(claimId));
      if (claim.outcome !== 2n) throw new Error(`unexpected outcome ${claim.outcome}`);
      addRow({
        chunk_bytes: chunkBytes, operation: "candidate", method: "summary",
        estimate_gas: processEstimate, gas_limit: processLimit, actual_gas: "", tx_hash: "",
        block_number: "", submission_to_receipt_ms: "", status: "CANDIDATE_OK",
        note: "actual inclusion completed with Valid outcome",
      });
    } catch (error) {
      const note = errorText(error);
      addRow({
        chunk_bytes: chunkBytes, operation: "candidate", method: "summary", estimate_gas: "",
        gas_limit: txCap, actual_gas: "", tx_hash: "", block_number: "",
        submission_to_receipt_ms: "", status: "CANDIDATE_FAILED", note,
      });
      console.error(`${chunkBytes} bytes failed: ${note}`);
      console.error("Stopping after the first failed or unsafe candidate.");
      break;
    }
  }

  console.log(`\nResults: ${outPath}`);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
