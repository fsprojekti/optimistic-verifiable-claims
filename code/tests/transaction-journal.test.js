const { expect } = require("chai");
const { ethers } = require("hardhat");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { TransactionJournal } = require("../scripts/transaction-journal");

describe("Resumable testnet transaction journal", function () {
  let wallet, directory, file, identity;
  beforeEach(async function () {
    wallet = ethers.Wallet.createRandom().connect(ethers.provider);
    await ethers.provider.send("hardhat_setBalance", [wallet.address, "0x8ac7230489e80000"]);
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "ovc-journal-"));
    file = path.join(directory, "checkpoint.json");
    identity = { chain: "31337", signer: wallet.address, artifact: "fixture" };
  });
  afterEach(function () {
    for (const name of fs.readdirSync(directory)) fs.unlinkSync(path.join(directory, name));
    fs.rmdirSync(directory);
  });
  const request = () => ({ to: ethers.ZeroAddress, value: 1n, gasLimit: 21000n });
  const freshWallet = wallet => new ethers.Wallet(wallet.privateKey, ethers.provider);

  it("replays a completed operation without another transfer or nonce", async function () {
    const journal = new TransactionJournal(file, wallet, identity);
    const first = await journal.execute("transfer", () => wallet.sendTransaction(request()));
    const resumed = new TransactionJournal(file, freshWallet(wallet), identity);
    const second = await resumed.execute("transfer", () => { throw Error("must not send twice"); });
    expect(second.receipt.hash).to.equal(first.receipt.hash);
    expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x1");
  });

  it("recovers when the node accepted a transaction but its response was lost", async function () {
    const broadcast = ethers.provider.broadcastTransaction.bind(ethers.provider);
    const journal = new TransactionJournal(file, wallet, identity);
    ethers.provider.broadcastTransaction = async raw => { await broadcast(raw); throw Error("response lost"); };
    try {
      await expect(journal.execute("transfer", () => wallet.sendTransaction(request()))).to.be.rejectedWith("response lost");
    } finally { ethers.provider.broadcastTransaction = broadcast; }
    const resumed = new TransactionJournal(file, freshWallet(wallet), identity);
    const result = await resumed.execute("transfer", () => { throw Error("must not resign"); });
    expect(result.receipt.status).to.equal(1);
    expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x1");
  });

  it("broadcasts the saved bytes after interruption before initial broadcast", async function () {
    const broadcast = ethers.provider.broadcastTransaction.bind(ethers.provider);
    const journal = new TransactionJournal(file, wallet, identity);
    ethers.provider.broadcastTransaction = async () => { throw Error("offline"); };
    try {
      await expect(journal.execute("transfer", () => wallet.sendTransaction(request()))).to.be.rejectedWith("offline");
    } finally { ethers.provider.broadcastTransaction = broadcast; }
    const savedHash = journal.data.operations.transfer.hash;
    const resumed = new TransactionJournal(file, freshWallet(wallet), identity);
    const result = await resumed.execute("transfer", () => { throw Error("must not resign"); });
    expect(result.receipt.hash).to.equal(savedHash);
    expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x1");
  });

  it("recovers an accepted transaction reported as nonce too low within the same launch", async function () {
    const broadcast = ethers.provider.broadcastTransaction.bind(ethers.provider);
    const journal = new TransactionJournal(file, wallet, identity);
    ethers.provider.broadcastTransaction = async raw => { await broadcast(raw); throw Error("nonce too low"); };
    try {
      const result = await journal.execute("transfer", () => wallet.sendTransaction(request()));
      expect(result.receipt.status).to.equal(1);
      expect(journal.data.launches).to.equal(1);
      expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x1");
    } finally { ethers.provider.broadcastTransaction = broadcast; }
  });

  it("does not treat nonce too low as success without a matching receipt", async function () {
    const broadcast = ethers.provider.broadcastTransaction.bind(ethers.provider);
    const journal = new TransactionJournal(file, wallet, identity, { timeoutMs: 1 });
    ethers.provider.broadcastTransaction = async () => { throw Error("nonce too low"); };
    try {
      await expect(journal.execute("transfer", () => wallet.sendTransaction(request()))).to.be.rejectedWith("RECEIPT_TIMEOUT");
      expect(journal.data.operations.transfer.status).to.equal(undefined);
      expect(journal.data.operations.transfer.raw).to.be.a("string");
      expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x0");
    } finally { ethers.provider.broadcastTransaction = broadcast; }
  });

  it("pauses before signing when the balance would consume the reserve", async function () {
    const journal = new TransactionJournal(file, wallet, identity, { reserveWei: ethers.parseEther("11") });
    await expect(journal.execute("transfer", () => wallet.sendTransaction(request()))).to.be.rejectedWith("PAUSED_FUNDS");
    expect(journal.has("transfer")).to.equal(false);
    expect(await ethers.provider.send("eth_getTransactionCount", [wallet.address, "latest"])).to.equal("0x0");
  });

  it("refuses a checkpoint for changed input or signer", function () {
    new TransactionJournal(file, wallet, identity);
    expect(() => new TransactionJournal(file, freshWallet(wallet), { ...identity, artifact: "changed" }))
      .to.throw("CHECKPOINT_MISMATCH");
  });

  it("allows an explicit deployment budget while retaining the operation budget", async function () {
    const journal = new TransactionJournal(file, wallet, identity, { cap: 21000n, deploymentCap: 100000n });
    const deployed = await journal.execute("deployFixture", () => wallet.sendTransaction({
      data: "0x600060005360016000f3", gasLimit: 60000n,
    }));
    expect(deployed.receipt.status).to.equal(1);
    await expect(journal.execute("ordinaryCall", () => wallet.sendTransaction({
      to: ethers.ZeroAddress, gasLimit: 22000n,
    }))).to.be.rejectedWith("GAS_CAP");
    expect(journal.has("ordinaryCall")).to.equal(false);
  });
});
