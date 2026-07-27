# Optimistic Verifiable Claims (OVC) — Reproducibility Package

Public artifacts accompanying the paper:

> **"Optimistic Verifiable Claims: A Blockchain Protocol for Conditionally Confidential
> Bidding in Decentralized Manufacturing"**

This repository contains the **smart contracts**, the **gas-measurement harnesses**, and the
**raw measurement results** needed to reproduce the empirical findings of the paper. Its goal
is reproducibility of the on-chain gas measurements, not regeneration of the paper's figures:
the plotting and presentation scripts are not included here.

---

## Protocol in brief

OVC lets a manufacturing Consumer publish a *claim* about a concealed design file (G-code) —
for example, the length of filament it consumes — so that a Provider can price and bid on it
without seeing the design. A claim is committed when the job is posted and stands unless the
selected Provider challenges it; a challenge triggers a deterministic on-chain predicate that
exposes any dishonesty. The design stays confidential on the honest, no-dispute path.

The lifecycle has three pre-contractual phases:

1. **Bidding** — the Consumer posts a provider-independent **Demand**: the artifact
   commitment `H̃(G)`, the declared feature value `f_claim`, and the on-chain ciphertext
   `C` (the encrypted design, uploaded in chunks). Providers bid on the Demand.
2. **Binding** — against the *selected* Provider, all four OVC instances are instantiated in
   one atomic coordinator transaction, and the encrypted decryption key is published
   on-chain.
3. **Specification Handover** — the Provider decrypts and verifies; acceptance or dispute of
   any claim is adjudicated here.

The four OVC instances, each a commit–dispute–reveal claim over the Demand:

| Instance | Contract | What it asserts | Dispute predicate |
| :--- | :--- | :--- | :--- |
| **OVC-Access** | `OVCAccess` | Key `K` is correctly wrapped for the Provider | `keccak256(K ∥ providerKeyHash) == commitment` |
| **OVC-Identity** | `OVCIdentitySegmented` | Ciphertext `C` in the Demand is `G ⊕ K` | `H̃(C) == rollingKeccak(G ⊕ K)` |
| **OVC-Conformance** | `OVCConformanceSegmented` | `G` contains valid motion commands | syntactic scan for `G0`/`G1` |
| **OVC-Feature** | `OVCFeatureSegmented` | Declared `f_claim` matches `G` | machine-model evaluation of net extrusion |

All instances share `OVCBase` / `OVCBaseSegmented`, a common state machine whose terminal
outcomes are **Accepted**, **Valid**, **Inconsistent**, **Incorrect**, and **Withheld**.
Cross-instance consistency is enforced at binding: the coordinator reads `H̃(G)`, `H̃(C)`,
and `f_claim` from the sealed Demand rather than accepting them from its caller, so all four
instances are bound to the artifact that was published for bidding.

---

## Segmentation and chunk size

A multi-megabyte artifact cannot be uploaded or adjudicated in a single transaction: it would
exceed any real chain's block gas limit. The segmented contracts process the artifact in
fixed-size **chunks**, resetting EVM memory between transactions. A single rolling-hash
commitment `H̃` fixes the chunk boundaries, so every party that must reproduce the hash
replays the same boundaries. The **operating chunk** is the largest chunk whose heaviest
transaction still fits within a target chain's block gas limit; it is a deployment parameter,
not a protocol constant.

---

## What is measured

All gas is measured on a high-capacity local node (`hardhat.config.js` raises the block gas
limit) so that raw EVM demand is isolated from any particular chain's block limit; chain
limits and prices re-enter only in the paper's projections. Two measurement methods return
bit-identical gas counts (the EVM is deterministic):

- **`tx`** — a transaction is mined and `gasUsed` is read from the receipt.
- **`eth_estimateGas`** — direct EVM execution via JSON-RPC, used only when calldata size
  physically prevents block inclusion in the test environment (large chunks).

The harnesses write per-chunk and per-operation gas as CSVs under `experiments/raw-data/`.
Because per-chunk gas is constant by EVM physics, total gas for any artifact size is composed
arithmetically from the per-chunk gas and the chunk count; the paper's cost and time
projections are derived from these CSVs and the chain parameters below.

### Harnesses → measurements

| Harness | Writes to | Measures |
| :--- | :--- | :--- |
| `tests/r1/ovc-identity-binding-scalability.js` | `raw-data/r1/` | ciphertext-deposit gas per chunk, across the chunk-size spectrum |
| `tests/r1/binding-phase.js` | `raw-data/r1/` | full two-phase flow: `postDemand`, `depositCiphertextChunk`, `seal`, `bindProvider`, `accept` |
| `tests/r2/ovcGas.test.js` | `raw-data/r2/` | per-instance stage gas across the four terminal outcomes |
| `tests/r3/ovc-identity-scalability-segmented.js` | `raw-data/r3/` | OVC-Identity adjudication gas per chunk |
| `tests/r3/ovc-conformance-scalability-segmented.js` | `raw-data/r3/` | OVC-Conformance adjudication gas per chunk |
| `tests/r3/ovc-feature-scalability-segmented.js` | `raw-data/r3/` | OVC-Feature adjudication gas per chunk |
| `tests/benchy-showcase.js` | `raw-data/benchy/` | per-chunk gas measured on the real 6.41 MB 3DBenchy artifact |

The `*-ceiling` and `*-ceiling13` raw-data directories hold focused runs near each chain's
operating chunk (13/14/15/80/88 KB). The monolithic (`tests/r3/ovc-*-scalability.js`)
harnesses are retained for reference; they measure the single-transaction case that motivates
segmentation.

The measured constants that anchor the paper (at the operating chunk):

- ciphertext deposit ≈ **714 gas/byte**
- OVC-Identity adjudication ≈ **801 gas/byte** (reads `C` from the Demand into memory)
- OVC-Conformance ≈ **1,750 gas/byte** worst case (deposit + full syntactic scan)
- OVC-Feature ≈ **2,945 gas/byte** worst case (deposit + machine-model evaluation)
- Binding handshake = **1,007,554 gas**, size-independent (`bindProvider` 898,290 + `accept` 109,264)

---

## Chain parameters (used for the paper's projections)

| Chain | Block gas limit | Gas price | Token | Block time | Operating chunk |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Ethereum (L1) | 36 M | 0.5 Gwei | $3,000 (ETH) | 12 s | 14 KB |
| Arbitrum (L2) | 32 M (exec) | 0.02 Gwei | $3,000 (ETH) | 0.25 s | 13 KB |
| opBNB (L2) | 200 M | 0.001 Gwei | $600 (BNB) | 1 s | 80 KB |

Token prices are representative midpoints; absolute USD scales linearly with them, while the
chain ranking and all feasibility thresholds are invariant. The projection arithmetic
(gas → USD and gas → duration) is documented in `RESULTS.md`; the scripts that generate the
paper's tables and figures from these CSVs are not part of this package.

---

## Reproducing the measurements

```bash
# Install dependencies
npm install

# Two-phase flow sanity check (honest accept-all-four + Identity dispute)
npx hardhat test tests/c15-two-phase-flow.js

# Ciphertext-deposit and full two-phase gas
npx hardhat test tests/r1/ovc-identity-binding-scalability.js
npx hardhat test tests/r1/binding-phase.js

# Per-instance stage gas across the four outcomes
npx hardhat test tests/r2/ovcGas.test.js

# Adjudication gas per chunk (dispute path)
npx hardhat test tests/r3/ovc-identity-scalability-segmented.js
npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js
npx hardhat test tests/r3/ovc-feature-scalability-segmented.js

# Real-artifact measurement (3DBenchy)
npx hardhat test tests/benchy-showcase.js
```

Each run writes CSVs under `experiments/raw-data/`. The measured values of record are
tabulated in [`RESULTS.md`](RESULTS.md).

---

## Repository layout

```
contracts/
  OVCBase.sol / OVCBaseSegmented.sol   # shared commit-dispute-reveal state machine
  Demand.sol                           # bidding-phase Demand store (C, H̃(G), f_claim)
  BindingPhase.sol                     # binds all four instances against a selected Provider
  OVCAccess.sol                        # OVC-Access
  OVCIdentity.sol / OVCIdentitySegmented.sol      # OVC-Identity (segmented reads C from Demand)
  OVCConformance.sol / OVCConformanceSegmented.sol
  OVCFeature.sol / OVCFeatureSegmented.sol

tests/
  c15-two-phase-flow.js                # bidding→binding→handover sanity test
  r1/  binding-phase.js                # full two-phase gas
       ovc-identity-binding-scalability.js   # ciphertext-deposit chunk spectrum
  r2/  ovcGas.test.js                  # per-instance stage gas, four outcomes
  r3/  ovc-{identity,conformance,feature}-scalability-segmented.js   # adjudication chunk spectrum
       ovc-{identity,conformance,feature}-scalability.js             # monolithic reference
  benchy-showcase.js                   # real 3DBenchy measurement
  scenarios/                           # per-instance correctness tests

scripts/
  benchmarkCsv.js                      # CSV writer used by the harnesses

experiments/raw-data/                  # measured gas CSVs (the results of record)

RESULTS.md                             # measured and derived numbers
```

---

## Configuration

`hardhat.config.js` sets `blockGasLimit: 0x1fffffffffffff` so that the harnesses measure raw
EVM gas without any network-imposed per-transaction ceiling. Chain-specific block gas limits
and their feasibility implications are applied only in the projections documented in
`RESULTS.md`.

---

## Archived version

This package is archived on Zenodo under the concept DOI
[10.5281/zenodo.20794987](https://doi.org/10.5281/zenodo.20794987), which resolves to the
latest archived version.
