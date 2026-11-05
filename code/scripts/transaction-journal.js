const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

function saveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n");
  // A file-sync client (OneDrive) can hold the target briefly; retry the atomic rename.
  for (let attempt = 1; ; attempt++) {
    try { fs.renameSync(temporary, file); return; }
    catch (error) {
      if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(error.code)) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250 * attempt);
    }
  }
}

// A signed transaction is saved before broadcast. A retry sends the same bytes,
// so loss of the RPC response cannot duplicate a deployment or a chunk upload.
class TransactionJournal {
  constructor(file, wallet, identity, { reserveWei = 0n, cap, deploymentCap = cap, timeoutMs = 120000, pollMs = 2000 } = {}) {
    this.file = file;
    this.wallet = wallet;
    this.provider = wallet.provider;
    this.reserveWei = reserveWei;
    this.cap = cap;
    this.deploymentCap = deploymentCap;
    this.timeoutMs = timeoutMs;
    this.pollMs = pollMs;
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
    // Client-side phases of the preparation, timed so that client and endpoint latency separate.
    const t = [performance.now()];
    const [pending, latest] = await Promise.all([
      this.provider.send("eth_getTransactionCount", [this.wallet.address, "pending"]),
      this.provider.send("eth_getTransactionCount", [this.wallet.address, "latest"]),
    ]);
    if (pending !== latest) throw new Error("PENDING_EXTERNAL: account has an untracked pending transaction");
    // A lagging RPC backend can report the nonce of the previous journaled transaction; reusing
    // it would re-sign an identical transaction (same calldata) and take its receipt for a new one.
    const lastUsed = Math.max(-1, ...Object.values(this.data.operations).map(o => o.nonce ?? -1));
    if (Number(BigInt(pending)) <= lastUsed) {
      throw new Error(`STALE_NONCE: RPC reports nonce ${Number(BigInt(pending))}, journal already used ${lastUsed}`);
    }
    t.push(performance.now());
    const tx = await this.wallet.populateTransaction({ ...request, nonce: Number(BigInt(pending)) });
    t.push(performance.now());
    const budget = this.active.startsWith("deploy") ? this.deploymentCap : this.cap;
    if (budget && tx.gasLimit > budget) throw new Error("GAS_CAP: estimated gas exceeds configured budget");
    const balance = BigInt(await this.provider.send("eth_getBalance", [this.wallet.address, "latest"]));
    t.push(performance.now());
    const required = tx.gasLimit * (tx.maxFeePerGas ?? tx.gasPrice) + (tx.value ?? 0n) + this.reserveWei;
    if (balance < required) throw new Error("PAUSED_FUNDS: balance below transaction budget plus reserve");
    const raw = await this.wallet.signTransaction(tx);
    t.push(performance.now());
    if (Object.values(this.data.operations).some(o => o.hash === ethers.keccak256(raw))) {
      throw new Error("JOURNAL_ERROR: signed transaction duplicates a journaled one");
    }
    const ms = i => Math.round((t[i + 1] - t[i]) * 10) / 10;
    this.data.operations[this.active] = {
      hash: ethers.keccak256(raw), raw, nonce: tx.nonce,
      gas_limit: tx.gasLimit.toString(), submitted_at_utc: new Date().toISOString(), poll_ms: this.pollMs,
      phases_ms: { estimate: this.estimateMs ?? null, nonce: ms(0), populate: ms(1), balance: ms(2), sign: ms(3) },
    };
    const saveStart = performance.now();
    this.save();
    const entry = this.data.operations[this.active];
    entry.phases_ms.save = Math.round((performance.now() - saveStart) * 10) / 10;
    const broadcastStart = performance.now();
    const response = await this.provider.broadcastTransaction(raw);
    entry.phases_ms.broadcast = Math.round((performance.now() - broadcastStart) * 10) / 10;
    return response;
  }

  async execute(operation, send) {
    let entry = this.data.operations[operation];
    let receipt;
    if (!entry) {
      this.active = operation;
      try { await send(); }
      catch (error) {
        // A node may accept the signed bytes but report a duplicate/old nonce.
        // Only an actual receipt for our saved hash can establish success.
        if (!this.has(operation) || !/already known|known transaction|nonce too low/i.test(error.shortMessage || error.message)) throw error;
      } finally { this.active = null; }
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
          if (!/already known|known transaction|nonce too low/i.test(error.shortMessage || error.message)) throw error;
        }
      }
      const deadline = Date.now() + this.timeoutMs;
      while (!receipt && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, this.pollMs));
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
