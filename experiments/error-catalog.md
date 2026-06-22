# Test Error Catalog

Errors encountered during R1–R3 benchmarking and what they mean for real-chain feasibility.
Each error type is a signal, not just a test failure — they expose the hard limits of the
monolithic design and justify the segmented architecture.

---

## E1 — JavaScript Heap Out of Memory (OOM crash)

**Symptom:** Node.js process dies with `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`. Test exits immediately, no report written.

**Trigger:** Building the full witness buffer for large G-code sizes in monolithic OVC-Identity.
The witness is `K (32 B) + G (N MB) + C (N MB)` — for 50 MB G-code this is ~100 MB raw,
which ethers.js hex-encodes into a ~200 MB string before JSON-RPC serialisation.

**Observed at:** `ovc-identity-scalability.js`, 50 MB with 8 GB heap.

**Mitigation in tests:** Increased heap to 16 GB (`--max-old-space-size=16384`). Added `try/finally` so partial results are always saved.

**Real-chain meaning:** Not directly a chain constraint — this is a client-side tool limitation.
On a real chain, the submission would fail at the transport/mempool layer (see E3, E4) before the
client ever hits a heap limit. The OOM shows the monolithic witness is too large to even *construct*
locally, let alone submit.

---

## E2 — Graceful ethers.js Failure (FAIL row in CSV)

**Symptom:** Test catches an error, writes `status: FAIL` to CSV, continues to next size. Report is
written with partial results. No crash.

**Trigger:** ethers.js fails to allocate or encode a large buffer, or the provider rejects the
request. Common causes: string allocation failure for large hex payloads, provider timeout, or
Anvil transport buffer limit.

**Observed at:** `ovc-identity-scalability.js`, 50 MB (graceful failure after try/finally was added).

**Mitigation in tests:** `try/finally` wrapping the size loop ensures report is always written.
`try/catch` per size records the failure and continues.

**Real-chain meaning:** Same root cause as E1 — the monolithic witness cannot be submitted as a
single transaction. On a real chain this would be a mempool rejection due to calldata size or gas
limit exceeded.

---

## E3 — Gas Limit Too Low

**Symptom:** Transaction reverts with `out of gas` or estimateGas throws. The `catch` block records
`status: FAIL`.

**Trigger:** Gas limit formula underestimates the actual cost. Observed when using `bytes * 700`
for small sizes (1 KB, 4 KB, 16 KB) in `ovc-identity-scalability.js` — the formula was calibrated
for large sizes where data cost dominates, but for small sizes the fixed overhead (~21 K base tx +
cold SSTORE setup) was not covered.

**Observed at:** `ovc-identity-scalability.js` small sizes before fix. Fixed by switching to
`bytes * 1500 + 100_000_000`.

**Real-chain meaning:** Direct analogue. On a real chain, a transaction with insufficient gas reverts
and the sender loses the gas spent. Callers must estimate gas correctly or add sufficient headroom.

---

## E4 — EVM Memory Expansion (superlinear gas growth)

**Symptom:** Not a failure — `gas/byte` increases at large sizes instead of staying flat or
decreasing. Visible in results tables.

**Trigger:** EVM memory expansion cost is quadratic: `3 * words + words² / 512`. Large witnesses
or large in-memory buffers during execution push the EVM memory footprint up, and the quadratic
term begins to dominate at tens of MB.

**Observed at:** All monolithic instances at large sizes (10 MB+). Most pronounced in OVC-Identity
where the witness is 2× G-code size (`K + G + C`). Conformance and Feature also show rising
gas/byte from ~10 MB onward.

**Example (OVC-Conformance monolithic):**
```
64 KB  → 471.06 gas/byte
1 MB   → 472.41 gas/byte
10 MB  → 490.38 gas/byte
25 MB  → 520.38 gas/byte
50 MB  → 570.38 gas/byte
```

**Real-chain meaning:** Direct analogue — same EVM runs on mainnet. This is a genuine,
chain-level cost increase. At 50 MB, the gas/byte for OVC-Conformance is ~21% higher than at
64 KB. The segmented approach avoids this: each `processChunk` resets EVM memory, so per-chunk
gas stays flat regardless of total G-code size.

---

## E5 — Hardhat Default Block Gas Limit

**Symptom:** Large transactions fail with `Transaction gas limit is X and exceeds block gas limit`.

**Trigger:** Hardhat 2.28+ introduced a Fusaka-era per-transaction gas cap of ~16.7 M gas by
default. Any single transaction costing more than this would be rejected.

**Mitigation in tests:** `hardhat.config.js` sets `blockGasLimit: 0x1fffffffffffff` (very large)
to bypass the cap so raw EVM gas can be measured without network constraints.

**Real-chain meaning:** This IS the real constraint on L1. Ethereum mainnet block gas limit is
~30 M gas. Any single transaction exceeding ~30 M gas cannot be included in a block regardless
of willingness to pay. This is the hard ceiling that makes the monolithic approach infeasible for
large G-code on L1 — and the primary motivation for segmentation. R4 applies real chain gas
limits to the R1/R3 measurements to determine feasibility per chain.

---

## E6 — Anvil HTTP Request Size Limit

**Symptom:** `eth_sendRawTransaction` or `eth_estimateGas` fails with an HTTP 413 or connection
reset when calldata is very large.

**Trigger:** Default HTTP servers impose a request body size limit (commonly 1–8 MB). Large
calldata (50 MB+ for monolithic identity) exceeds this.

**Mitigation in tests:** Anvil is started with `--no-request-size-limit` to disable the cap
entirely, allowing measurement of arbitrarily large transactions.

**Real-chain meaning:** Public Ethereum nodes (Infura, Alchemy, etc.) impose their own request
size limits (typically 1–128 KB of calldata for free tiers). Transactions with large calldata
must go through a full node or a provider that accepts large transactions. This is a practical
deployment constraint on top of the block gas limit (E5).

---

## E7 — Anvil Block Gas Limit Too Low

**Symptom:** Transaction rejected before execution with `Server error: intrinsic gas too high -- tx.gas_limit > env.block.gas_limit`. The test catches it, writes `status: FAIL` to CSV, and continues.

**Trigger:** The test sets an explicit per-transaction `gasLimit` based on the size formula
(`bytes × 3000 + 100_000_000`). For 50 MB this evaluates to **~157 B gas**. Anvil's
`--gas-limit` was 100 B — the submitted gas limit exceeded the block ceiling, so Anvil
rejected the transaction outright without attempting execution.

**Observed at:** `ovc-identity-scalability.js`, 50 MB probe. Anvil started with
`--gas-limit 100000000000`.

**Mitigation in tests:** Increased Anvil `--gas-limit` to `300000000000` (300 B) in
`tests/run.md`. This covers 50 MB (~157 B required) with ~2× headroom and accommodates
the quadratic gas growth (E4) at large sizes without hitting the ceiling.

**Real-chain meaning:** Direct analogue. Every chain has a per-block (and per-transaction)
gas ceiling. On Ethereum L1 (~30 M gas) a 50 MB witness transaction is ~5000× over the
limit. On high-throughput L2s the ceiling is higher but still finite. This error is the
local-testnet echo of E5 — here triggered by the test's own gas estimate rather than
Hardhat's network config.

---

## E8 — Hardhat HTTP Timeout on eth_estimateGas

**Symptom:** `eth_estimateGas` call fails with `Headers Timeout Error` after ~1200 s.
Test catches it, writes `status: FAIL`, continues.

**Trigger:** `hardhat.config.js` `localhost.timeout` was 1200000 ms (1200 s). For large chunks
in OVC-Identity segmented, `eth_estimateGas` asks Anvil to simulate `processChunk` — which
reads the stored ciphertext from contract storage and XOR-decrypts every byte. For a 50 MB
chunk this simulation ran for ~1197 s before the Hardhat HTTP client cut the connection.

**Observed at:** `ovc-identity-scalability-segmented.js`, 50 MB chunk. Anvil was still
computing; the timeout was on the client side, not an EVM gas or OOM failure.

**Why Identity is slower than Conformance/Feature:** `processChunk` for Identity performs
a byte-by-byte XOR decrypt of the stored ciphertext in addition to the rolling hash update.
Conformance scans for G-code syntax; Feature extracts E-values — both are cheaper per byte.

**Mitigation in tests:** Increased `localhost.timeout` to 3600000 ms (3600 s) in
`hardhat.config.js`. The 50 MB degenerate chunk (N=1) is the worst case; practical chunk
sizes (≤1 MB) complete in seconds.

**Real-chain meaning:** Not a chain constraint — `eth_estimateGas` is a local simulation.
On a real chain the transaction would be submitted without a client-side timeout; the block
gas limit (E5/E7) is the binding constraint, not simulation time.

---

## E9 — Anvil OOM on Large depositChunk (Conformance / Feature segmented)

**Symptom:** `depositChunk` transaction for large G chunks (5 MB+) causes Anvil to crash
mid-transaction with `other side closed`, then subsequent calls fail with
`HH108: Cannot connect to the network localhost`.

**Trigger:** In OVC-Conformance and OVC-Feature segmented, G is deposited on-chain during
the dispute window via `depositChunk`. This writes the entire chunk to contract storage via
SSTORE. For a 5 MB chunk: 5 MB ÷ 32 bytes = 163,840 storage slots × 20,000 gas = ~3.27 B
gas in SSTOREs alone. Committing 163,840 new state entries in one block exhausts Anvil's
in-process memory.

**Not triggered in OVC-Identity segmented:** C is deposited during binding (not adjudication),
and `processChunk` only reads stored data — no large SSTORE batches during the adjudication
measurement window.

**Observed at:** `ovc-conformance-scalability-segmented.js`, `ovc-feature-scalability-segmented.js`,
5 MB chunk and above.

**Mitigation in tests:** None needed — 5 MB+ chunks are impractical in a segmented design.
The useful measurement range is 1 KB–1 MB, which is fully captured. Sizes ≥ 5 MB record
`status: FAIL` and the matrix shows `FAIL` for those rows.

**Real-chain meaning:** On a real chain, a 5 MB `depositChunk` is a valid (if expensive)
transaction, bounded only by block gas limit. The Anvil crash is a local-node memory
constraint, not an EVM constraint. The SSTORE cost (~3.27 B gas for 5 MB) already makes
such large chunks economically infeasible on any real chain.

---

## Summary table

| ID | Layer | Crash? | Mitigation in tests | Real-chain analogue |
|----|-------|--------|---------------------|---------------------|
| E1 | Client (Node.js) | Yes | `--max-old-space-size=16384`, `try/finally` | Mempool/transport rejection |
| E2 | Client (ethers.js) | No | `try/catch` per size, `try/finally` for report | Mempool rejection |
| E3 | EVM | No | Correct gas limit formula | Transaction reverts, gas burned |
| E4 | EVM (gas model) | No | None needed — this is data | Same cost on any EVM chain |
| E5 | Network (block limit) | No | `blockGasLimit` override in hardhat.config.js | Hard ceiling on L1/L2 |
| E6 | Transport (HTTP) | No | `--no-request-size-limit` on Anvil | Provider/node body size limits |
| E7 | Anvil block gas ceiling | No | `--gas-limit 300000000000` on Anvil | Per-block gas cap on every chain |
