/**
 * MegaETH per-transaction feasibility of the size-dependent deposits (R1 on MegaETH).
 *
 * MegaEVM bounds a transaction by resources besides compute gas, so the largest chunk a
 * deposit transaction can carry is found on the network itself: bisection over the 64-byte
 * grid, each probe deploying Demand(z), posting and preparing a Demand, then estimating and
 * (when it fits) sending one ciphertext chunk of z bytes.
 *
 * Usage (from code/): npx hardhat run --network megaethTestnet scripts/probe-megaeth-chunk.js
 * Output: results/raw-data/megaeth-chunk-probe-2026-10-29/probe.json
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");
const { ethers } = hre;

const OUT = path.join(__dirname, "..", "..", "results", "raw-data", "megaeth-chunk-probe-2026-10-29");
const LO = Number(process.env.OVC_PROBE_LO || 24960); // known to fit (full-path campaign)
const HI = Number(process.env.OVC_PROBE_HI || 49728); // known to fail

async function probe(wallet, z) {
  const demand = await (await ethers.getContractFactory("Demand", wallet)).deploy(z);
  await demand.waitForDeployment();
  const h = ethers.keccak256(ethers.toUtf8Bytes(`probe-${z}`));
  await (await demand.postDemand(h, h, 0, "0x" + "00".repeat(12), 2 * z, z)).wait();
  const id = await demand.demandCount();
  await (await demand.prepareBinding(id, wallet.address)).wait();
  const chunk = crypto.randomBytes(z);
  const result = { chunk_bytes: z, demand: demand.target };
  try {
    const estimate = await demand.depositCiphertextChunk.estimateGas(id, chunk);
    const receipt = await (await demand.depositCiphertextChunk(id, chunk, { gasLimit: estimate + estimate / 20n })).wait();
    Object.assign(result, { fits: receipt.status === 1, estimate_gas: estimate.toString(), gas_used: receipt.gasUsed.toString(), tx_hash: receipt.hash });
  } catch (e) {
    Object.assign(result, { fits: false, error: String(e.shortMessage || e.message).slice(0, 200) });
  }
  console.log(JSON.stringify(result));
  return result;
}

async function main() {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== 6343n) throw new Error("MegaETH testnet only");
  const wallet = new ethers.Wallet(process.env.OVC_TESTNET_PRIVATE_KEY, ethers.provider);
  fs.mkdirSync(OUT, { recursive: true });
  const probes = [];
  let lo = LO, hi = HI; // invariant: lo fits, hi does not
  while (hi - lo > 64) {
    const mid = Math.floor((lo + hi) / 2 / 64) * 64;
    const r = await probe(wallet, mid);
    probes.push(r);
    if (r.fits) lo = mid; else hi = mid;
  }
  const out = { observed_at_utc: new Date().toISOString(), chain_id: network.chainId.toString(),
    client_version: await ethers.provider.send("web3_clientVersion", []), signer: wallet.address,
    grid_bytes: 64, largest_fitting_chunk_bytes: lo, smallest_failing_chunk_bytes: hi, probes };
  fs.writeFileSync(path.join(OUT, "probe.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`largest fitting deposit chunk ${lo} B; ${hi} B fails`);
}

main().catch(e => { console.error(String(e.shortMessage || e.message)); process.exitCode = 1; });
