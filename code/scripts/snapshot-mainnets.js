// Reads the deployment-chain parameters used by the cost and time model from public mainnet
// RPCs: block gas limit, mean block time and gas price (median over a recent block window).
//
// Usage: node code/scripts/snapshot-mainnets.js [outDir]
// Output: <outDir>/chain-params.json (raw readings and the derived values)
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const WINDOW = 1024; // blocks for block time and fee history
const DAYS = Number(process.env.OVC_FEE_DAYS || 365); // days of base-fee samples for the representative gas price
const PER_DAY = Number(process.env.OVC_FEE_SAMPLES_PER_DAY || 4);

const NETWORKS = [
  {
    name: "Ethereum",
    chainId: 1n,
    rpc: process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
    txGasCap: 16777216,
    capBasis: "EIP-7825 per-transaction cap",
  },
  {
    name: "Arbitrum One",
    chainId: 42161n,
    rpc: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    txGasCap: 32000000,
    capBasis: "ArbOS per-transaction execution limit",
  },
  {
    name: "MegaETH",
    chainId: 4326n,
    rpc: process.env.MEGAETH_RPC_URL || "https://mainnet.megaeth.com/rpc",
    txGasCap: null,
    capBasis: "block gas limit (per-transaction feasibility measured on the testnet)",
  },
];

function median(values) {
  const s = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return s[Math.floor(s.length / 2)];
}

async function read(network) {
  const provider = new ethers.JsonRpcProvider(network.rpc);
  const actual = await provider.getNetwork();
  if (actual.chainId !== network.chainId) {
    throw new Error(`${network.name}: expected ${network.chainId}, got ${actual.chainId}`);
  }
  const latest = await provider.getBlock("latest");
  const first = await provider.getBlock(latest.number - WINDOW);
  const gasPrice = BigInt(await provider.send("eth_gasPrice", []));
  // feeHistory caps the block count per call on some providers; read the window in pieces.
  const baseFees = [];
  const tips = [];
  for (let end = latest.number; end > latest.number - WINDOW; end -= 256) {
    const h = await provider.send("eth_feeHistory", [ethers.toQuantity(256), ethers.toQuantity(end), [50]]);
    baseFees.push(...h.baseFeePerGas.slice(0, -1).map(BigInt));
    tips.push(...(h.reward || []).map((r) => BigInt(r[0])));
  }
  const baseFee = median(baseFees);
  const tip = tips.length ? median(tips) : 0n;
  const blockTime = (latest.timestamp - first.timestamp) / WINDOW;
  const txLimit = network.txGasCap ?? Number(latest.gasLimit);
  // Base fee from block headers, PER_DAY blocks per day over the prior DAYS days (feeHistory is
  // pruned on public RPCs); the recent median priority fee is added, for a representative price.
  const blocksPerDay = Math.round(86400 / blockTime);
  const daily = [];
  for (let d = 0; d < DAYS; d++) {
    const fees = [];
    for (let k = 0; k < PER_DAY; k++) {
      const n = latest.number - d * blocksPerDay - Math.round((k * blocksPerDay) / PER_DAY);
      try {
        const b = await provider.getBlock(n);
        if (b?.baseFeePerGas != null) fees.push(b.baseFeePerGas);
      } catch (e) { /* missing header: skipped and counted below */ }
    }
    daily.push(fees.length
      ? { day: d, samples: fees.length, gwei: Number(median(fees) + tip) / 1e9 }
      : { day: d, samples: 0, error: "no block headers" });
  }
  const dailyGwei = daily.filter((x) => x.gwei !== undefined).map((x) => x.gwei).sort((a, b) => a - b);
  return {
    observed_at_utc: new Date().toISOString(),
    network: network.name,
    chain_id: actual.chainId.toString(),
    rpc: network.rpc,
    block_number: latest.number,
    block_gas_limit: latest.gasLimit.toString(),
    per_tx_gas_limit: txLimit,
    per_tx_limit_basis: network.capBasis,
    window_blocks: WINDOW,
    mean_block_time_s: blockTime,
    eth_gasPrice_wei: gasPrice.toString(),
    median_base_fee_wei: baseFee.toString(),
    median_priority_fee_p50_wei: tip.toString(),
    effective_gas_price_gwei: Number(baseFee + tip) / 1e9,
    daily_window_days: DAYS,
    daily_samples: daily.length,
    daily_valid_samples: dailyGwei.length,
    daily_median_gwei: dailyGwei.length ? dailyGwei[Math.floor(dailyGwei.length / 2)] : null,
    daily_min_gwei: dailyGwei[0] ?? null,
    daily_max_gwei: dailyGwei[dailyGwei.length - 1] ?? null,
    daily,
  };
}

async function main() {
  const outDir = path.resolve(process.argv[2] || ".");
  fs.mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const network of NETWORKS) {
    const row = await read(network);
    console.log(JSON.stringify(row));
    rows.push(row);
  }
  fs.writeFileSync(path.join(outDir, "chain-params.json"), JSON.stringify(rows, null, 2) + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
