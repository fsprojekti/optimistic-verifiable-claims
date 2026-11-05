const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const NETWORKS = [
  {
    name: "Ethereum Sepolia",
    chainId: 11155111n,
    rpc: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
    candidateChunkBytes: 3072,
    statedTxGasCap: 16777216,
    capBasis: "EIP-7825",
  },
  {
    name: "MegaETH Testnet",
    chainId: 6343n,
    rpc: process.env.MEGAETH_TESTNET_RPC_URL || "https://carrot.megaeth.com/rpc",
    candidateChunkBytes: 3072,
    statedTxGasCap: 200000000,
    capBasis: "MegaEVM compute cap; multidimensional limits and 20M volatile-data cap also apply",
  },
  {
    name: "Arbitrum Sepolia",
    chainId: 421614n,
    rpc: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
    candidateChunkBytes: 3072,
    statedTxGasCap: 32000000,
    capBasis: "EIP-8123 example; live inclusion still required",
  },
];

function csv(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function main() {
  const rows = [];
  for (const network of NETWORKS) {
    const provider = new ethers.JsonRpcProvider(network.rpc, undefined, { staticNetwork: false });
    const started = performance.now();
    const [actualNetwork, block, clientVersion, feeData] = await Promise.all([
      provider.getNetwork(),
      provider.getBlock("latest"),
      provider.send("web3_clientVersion", []),
      provider.getFeeData(),
    ]);
    const rpcMs = Math.round(performance.now() - started);
    if (actualNetwork.chainId !== network.chainId) {
      throw new Error(`${network.name}: expected ${network.chainId}, got ${actualNetwork.chainId}`);
    }
    rows.push({
      observed_at_utc: new Date().toISOString(),
      network: network.name,
      chain_id: actualNetwork.chainId,
      block_number: block.number,
      block_gas_limit: block.gasLimit,
      block_gas_used: block.gasUsed,
      base_fee_per_gas: block.baseFeePerGas ?? "",
      gas_price: feeData.gasPrice ?? "",
      max_fee_per_gas: feeData.maxFeePerGas ?? "",
      rpc_roundtrip_ms: rpcMs,
      candidate_chunk_bytes: network.candidateChunkBytes,
      stated_tx_gas_cap: network.statedTxGasCap,
      cap_basis: network.capBasis,
      client_version: clientVersion,
    });
  }

  const headers = Object.keys(rows[0]);
  const outDir = path.join(__dirname, "..", "..", "results", "raw-data", "testnet-readiness");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "network-snapshot.csv");
  fs.writeFileSync(
    outPath,
    [headers.join(","), ...rows.map(row => headers.map(h => csv(row[h])).join(","))].join("\n") + "\n",
    "utf8"
  );
  console.table(rows.map(({ client_version, cap_basis, ...row }) => row));
  console.log(outPath);
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
