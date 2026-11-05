require("@nomicfoundation/hardhat-toolbox");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../../.env"), quiet: true });

const localhostUrl = process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545";
const testnetAccounts = process.env.OVC_TESTNET_PRIVATE_KEY
  ? [process.env.OVC_TESTNET_PRIVATE_KEY]
  : [];

module.exports = {
  paths: {
    tests: "./tests",
  },
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      blockGasLimit: 0x1fffffffffffff, // bypass Hardhat 2.28+ Fusaka per-tx cap (16.7 M)
      allowUnlimitedContractSize: true,
      // gas: "auto",
      // initialBaseFeePerGas: 0,
    },
    localhost: {
      url: localhostUrl,
      timeout: 3600000
    },
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      accounts: testnetAccounts,
      timeout: 120000,
    },
    megaethTestnet: {
      url: process.env.MEGAETH_TESTNET_RPC_URL || "https://carrot.megaeth.com/rpc",
      accounts: testnetAccounts,
      timeout: 120000,
    },
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      accounts: testnetAccounts,
      timeout: 120000,
    },
  },
};
