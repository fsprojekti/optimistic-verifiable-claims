const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  fs.renameSync(temporary, file);
}

// A signed transaction is saved before broadcast. A retry sends the same bytes,
// so loss of the RPC response cannot duplicate a deployment or a chunk upload.
class TransactionJournal {
  constructor(file, wallet, identity, { reserveWei = 0n, cap, deploymentCap = cap, timeoutMs = 120000 } = {}) {
    this.file = file;
    this.wallet = wallet;
    this.provider = wallet.provider;
    this.reserveWei = reserveWei;
    this.cap = cap;
    this.deploymentCap = deploymentCap;
    this.timeoutMs = timeoutMs;
    this.active = null;
    this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {
      version: 1, identity, created_at_utc: new Date().toISOString(), operations: {}, launches: 0,
    };
    if (JSON.stringify(this.data.identity) !== JSON.stringify(identity)) {
      throw new Error("CHECKPOINT_MISMATCH: signer, chain, input or bytecode changed");
    }
    this.data.launches += 1;
    this.save();
    wallet.sendTransaction = request => this.send(request);
  }

  save() { saveJson(this.file, this.data); }
  has(operation) { return !!this.data.operations[operation]; }

  async send(request) {
    if (!this.active) throw new Error("JOURNAL_ERROR: transaction outside a named operation");
    if (this.has(this.active)) throw new Error("JOURNAL_ERROR: operation already signed");
    const [pending, latest] = await Promise.all([
      this.provider.send("eth_getTransactionCount", [this.wallet.address, "pending"]),
      this.provider.send("eth_getTransactionCount", [this.wallet.address, "latest"]),
    ]);
    if (pending !== latest) throw new Error("PENDING_EXTERNAL: account has an untracked pending transaction");
    const tx = await this.wallet.populateTransaction({ ...request, nonce: Number(BigInt(pending)) });
    const budget = this.active.startsWith("deploy") ? this.deploymentCap : this.cap;
    if (budget && tx.gasLimit > budget) throw new Error("GAS_CAP: estimated gas exceeds configured budget");
    const balance = BigInt(await this.provider.send("eth_getBalance", [this.wallet.address, "latest"]));
    const required = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice) + (tx.value ?? 0n) + this.reserveWei;
    if (balance < required) throw new Error("PAUSED_FUNDS: balance below transaction budget plus reserve");
    const raw = await this.wallet.signTransaction(tx);
    this.data.operations[this.active] = {
      hash: ethers.keccak256(raw), raw, nonce: tx.nonce,
      gas_limit: tx.gasLimit.toString(), submitted_at_utc: new Date().toISOString(),
    };
    this.save();
    return this.provider.broadcastTransaction(raw);
  }

  async execute(operation, send) {
    let entry = this.data.operations[operation];
    let receipt;
    if (!entry) {
      this.active = operation;
      try { await send(); } finally { this.active = null; }
      entry = this.data.operations[operation];
      if (!entry) throw new Error("JOURNAL_ERROR: callback did not sign a transaction");
    }
    receipt = await this.provider.getTransactionReceipt(entry.hash);
    if (!receipt) {
      const pending = await this.provider.getTransaction(entry.hash);
      if (!pending) {
        if (!entry.raw) throw new Error("REORG_REVIEW: confirmed transaction is no longer available");
        try { await this.provider.broadcastTransaction(entry.raw); }
        catch (error) {
          if (!/already known|known transaction/i.test(error.shortMessage || error.message)) throw error;
        }
      }
      const deadline = Date.now() + this.timeoutMs;
      while (!receipt && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 2000));
        receipt = await this.provider.getTransactionReceipt(entry.hash);
      }
    }
    if (!receipt) throw new Error("RECEIPT_TIMEOUT: transaction remains pending");
    if (receipt.status !== 1) throw new Error(`REVERTED_TRANSACTION: ${entry.hash}`);
    if (!entry.receipt_at_utc) entry.receipt_at_utc = new Date().toISOString();
    entry.block_number = receipt.blockNumber;
    entry.gas_used = receipt.gasUsed.toString();
    entry.fee_wei = receipt.fee.toString();
    entry.contract_address = receipt.contractAddress;
    entry.status = 1;
    delete entry.raw;
    this.save();
    return { receipt, entry };
  }
}

module.exports = { TransactionJournal, saveJson };
