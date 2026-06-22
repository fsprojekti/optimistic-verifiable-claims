require("@nomicfoundation/hardhat-toolbox");

const localhostUrl = process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545";

module.exports = {
  solidity: "0.8.20",
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
    }
  },
};