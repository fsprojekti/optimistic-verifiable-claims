# Results

Measured on a local node with the block gas limit raised (`hardhat.config.js`), so raw EVM
gas is isolated from any chain's block limit. Gas values are deterministic and reproducible
by re-running the harnesses in [`README.md`](README.md); the CSVs live under
`experiments/raw-data/`. Cost and time are projected onto three deployment chains using the
parameters in the final section.

The four evaluation stages mirror the paper:

- **R1 — Chunk selection.** Fixes the operating chunk `c*` per chain.
- **R2 — Demand publication.** `O(N)`, unconditional (the cost floor).
- **R3 — Binding.** `O(1)`, size-independent.
- **R4 — Dispute adjudication.** `O(N)`, conditional; reported as the increment on top of the floor.

---

## R1 — Chunk selection and the computational boundary

### Per-chunk transaction gas (measured)

Each value is the gas for one transaction carrying one chunk, from `raw-data/r1/` (deposit)
and `raw-data/r3/` (adjudication).

| Chunk | Deposit / upload | OVC-Identity | OVC-Conformance | OVC-Feature |
| ---: | ---: | ---: | ---: | ---: |
| 1 KB | 0.79 M | 0.92 M | 1.15 M | 2.40 M |
| 4 KB | 2.97 M | 3.36 M | 4.31 M | 9.23 M |
| 8 KB | 5.88 M | 6.61 M | 8.53 M | 18.32 M |
| 12 KB | 8.79 M | 9.86 M | 12.75 M | 27.43 M |
| 16 KB | 11.69 M | 13.11 M | 16.96 M | 36.53 M |
| 64 KB | 46.60 M | 52.25 M | 67.57 M | 145.75 M |
| 128 KB | 93.15 M | 104.72 M | 135.03 M | 291.39 M |
| 256 KB | 186.30 M | 210.65 M | 269.97 M | 582.71 M |

Effective per-byte rates at the operating chunk: deposit **714 gas/byte**, OVC-Identity
**801**, OVC-Conformance **1,750** (worst case), OVC-Feature **2,945** (worst case).
OVC-Feature is the heaviest and therefore the binding constraint on chunk size.

### Operating chunk by chain

The largest chunk whose heaviest transaction (OVC-Feature) stays within 95 % of the block
gas limit:

| Chain | Block gas limit | Operating chunk `c*` | OVC-Feature gas | Fill |
| :--- | ---: | ---: | ---: | ---: |
| Ethereum (L1) | 36 M | 14 KB | 31.98 M | 88.8 % |
| Arbitrum (L2) | 32 M | 13 KB | 29.70 M | 92.8 % |
| opBNB (L2) | 200 M | 80 KB | 182.15 M | 91.1 % |

**Boundary finding.** A monolithic (single-transaction) reveal of any industrial artifact
exceeds every real block limit — the infeasibility is driven by the large *linear* term, not
the superlinear memory tail. Total gas is nearly chunk-independent (≈ 2 % across the feasible
range) while transaction count varies twentyfold, so chunk selection is a feasibility and
latency decision, not a cost lever. The operating chunk is the largest that the whole chain
of claims admits.

---

## R2 — Demand publication

Publishing a Demand is the only unconditional, size-proportional cost — the protocol's cost
floor: `postDemand`, the chunked ciphertext deposit, and `seal`. Gas is quoted at Ethereum's
`c*`; the other chains differ by < 0.5 %. Durations are ceilings; Ethereum is a band
(δ ∈ [1,4]), rollups at δ ≈ 1.

| Artifact | Gas | Ethereum | Arbitrum | opBNB |
| :--- | ---: | :--- | :--- | :--- |
| 64 KB | 47.0 M | $70.45 / 2.1–8.4 min | $2.82 / 3 s | $0.0280 / 4 s |
| 256 KB | 187.4 M | $281.09 / 6.3–25.2 min | $11.25 / 8 s | $0.1119 / 9 s |
| 1 MB | 749.1 M | $1,124 / 0.4–1.5 h | $44.97 / 30 s | $0.4473 / 22 s |
| 5 MB | 3,745.0 M | $5,617 / 1.8–7.4 h | $224.80 / 2.5 min | $2.24 / 1.6 min |
| **3DBenchy (6.41 MB)** | **4,804.8 M** | **$7,207 / 2.4–9.4 h** | **$288.42 / 3.2 min** | **$2.87 / 2.1 min** |
| 10 MB | 7,489.8 M | $11,235 / 3.7–14.7 h | $449.60 / 4.9 min | $4.47 / 3.2 min |
| 25 MB | 18,724.4 M | $28,087 / 9.2–36.6 h | $1,124 / 12.3 min | $11.18 / 8.1 min |
| 50 MB | 37,448.6 M | $56,173 / 18–73 h | $2,248 / 24.6 min | $22.36 / 16.1 min |

Gas is linear in artifact size to within the two `O(1)` transactions (an 800× size increase
raises gas 797×). This cost is incurred before any Provider bids and whether or not any ever
does.

---

## R3 — Binding

Instantiating all four OVC instances against the selected Provider and accepting them. `O(1)`
and independent of artifact size (measured identical from 64 KB to 5 MB).

| Transaction | Gas | Ethereum | Arbitrum | opBNB |
| :--- | ---: | ---: | ---: | ---: |
| `bindProvider` (four claims + key) | 898,290 | $1.35 | $0.0539 | $0.00054 |
| `accept` (Provider co-signs) | 109,264 | $0.16 | $0.0066 | $0.00007 |
| **Total** | **1,007,554** | **$1.51** | **$0.0605** | **$0.00060** |

Binding is ≈ 2 % of publishing even the 64 KB artifact and 0.02 % of the 3DBenchy — the
commitment apparatus is nearly free; the data movement around it is not.

---

## R4 — Dispute adjudication

Every figure below is the **conditional increment** a dispute adds on top of the already-paid
floor (R2). Disputes are per instance. The 3DBenchy rows use per-chunk gas measured on the
real artifact; the synthetic rows are the worst-case witnesses (see methodology).

### Per-instance dispute increment (3DBenchy, 6.41 MB)

| Instance | Gas | Share | Ethereum | Arbitrum | opBNB |
| :--- | ---: | ---: | ---: | ---: | ---: |
| OVC-Access (`O(1)`) | 63,971 | < 0.1 % | $0.10 | $0.0038 | $0.00004 |
| OVC-Identity | 5.398 G | 19.1 % | $8,098 | $323.91 | $3.24 |
| OVC-Conformance | 5.351 G | 18.9 % | $8,027 | $321.09 | $3.21 |
| OVC-Feature | 17.551 G | 62.0 % | $26,326 | $1,053 | $10.53 |
| **All four** | **28.30 G** | **100 %** | **$42,451** | **$1,698** | **$16.98** |

OVC-Feature alone is more than the other three combined: on a real artifact the semantic
predicate, not the confidentiality machinery, is the dominant cost centre.

### Fully contested dispute across the ladder

All four instances contested (2 deposits of `G` + 3 adjudication sweeps + `O(1)` Access).

| Artifact | Gas | Ethereum | Arbitrum | opBNB |
| :--- | ---: | :--- | :--- | :--- |
| 64 KB | 0.36 G | $540.43 / 12.3–49.2 min | $21.63 / 15 s | $0.2153 / 32 s |
| 1 MB | 5.76 G | $8,645 / 1.9–7.7 h | $345.96 / 2.6 min | $3.44 / 2.0 min |
| **3DBenchy (6.41 MB)** | **28.30 G** | **$42,451 / 11.8–47.3 h** | **$1,699 / 15.9 min** | **$16.86 / 10.8 min** |
| 10 MB | 57.64 G | $86,453 / 18–74 h | $3,460 / 24.7 min | $34.44 / 16.4 min |
| 50 MB | 288.18 G | $432,266 / 92–366 h | $17,298 / 2.1 h | $172.18 / 1.3 h |

The measured 3DBenchy increment runs 24 % below what the worst-case synthetic rates project
for its size (28.3 G vs 37.0 G): OVC-Identity is content-independent (±0.2 %), the
OVC-Conformance scan short-circuits on the first motion command (−55 %), and OVC-Feature
carries fewer E-coordinates per byte than the adversarial synthetic (−11 %).

---

## Full protocol cost

Demand publication (R2) + binding (R3) + fully contested dispute (R4). The undisputed cost is
the R2 floor plus $1.51 (binding) or less, on every chain.

| Artifact | Gas | Ethereum | Arbitrum | opBNB |
| :--- | ---: | :--- | :--- | :--- |
| 64 KB | 0.41 G | $612.38 / 0.2–1.0 h | $24.51 / 19 s | $0.2439 / 39 s |
| 1 MB | 6.51 G | $9,771 / 2.3–9.3 h | $390.99 / 3.1 min | $3.89 / 2.5 min |
| **3DBenchy (6.41 MB)** | **33.11 G** | **$49,660 / 14.2–56.8 h** | **$1,988 / 19.1 min** | **$19.73 / 12.9 min** |
| 10 MB | 65.13 G | $97,690 / 22–88 h | $3,909 / 29.7 min | $38.91 / 19.7 min |
| 50 MB | 325.63 G | $488,440 / 110–439 h | $19,546 / 2.5 h | $194.54 / 1.6 h |

A fully contested job costs 8.7× an undisputed one at synthetic rates (6.9× for the measured
3DBenchy). The chain separation is set almost entirely by gas price: ≈ 25× Ethereum →
Arbitrum, ≈ 100× Arbitrum → opBNB. On Layer 1 a 50 MB dispute reaches 4.5–18 days, beyond any
practical manufacturing SLA; rollups keep it to hours.

---

## Chain parameters

| Chain | Block gas limit | Gas price | Token | Block time | Cost rate |
| :--- | ---: | ---: | ---: | ---: | ---: |
| Ethereum (L1) | 36 M | 0.5 Gwei | $3,000 (ETH) | 12 s | $1,500 / Ggas |
| Arbitrum (L2) | 32 M (exec) | 0.02 Gwei | $3,000 (ETH) | 0.25 s | $60 / Ggas |
| opBNB (L2) | 200 M | 0.001 Gwei | $600 (BNB) | 1 s | $0.60 / Ggas |

Cost = gas × gas price (Gwei) × 10⁻⁹ × token price. Duration = transaction count × β × block
time × δ, with β = 1.5 (median inclusion) and δ the congestion factor (Ethereum reported over
δ ∈ [1,4]; rollups at δ ≈ 1). Token prices are representative midpoints; absolute USD scales
linearly with them while the chain ranking and feasibility thresholds do not.

---

## Notes on methodology

- **Two gas methods, identical results.** `tx` (mined, receipt `gasUsed`) and
  `eth_estimateGas` (direct EVM execution) return bit-identical counts. The latter is used
  only when calldata size prevents block inclusion in the test environment; real-chain
  feasibility is handled by the operating-chunk selection above.
- **Worst-case synthetic witnesses.** The synthetic artifacts are each predicate's worst
  case: the OVC-Conformance witness places its first motion command at the end of each chunk
  (the scan never terminates early), and the OVC-Feature witness is all extrusion lines (the
  machine model evaluates state on every line). Projections from them are therefore
  conservative upper bounds; the 3DBenchy measurements quantify the margin below.
- **Composition is exact.** Per-chunk gas is constant by EVM physics, so total gas for any
  artifact size is the per-chunk gas times the chunk count plus the `O(1)` lifecycle
  transactions. No multi-thousand-transaction sweep is executed; derived totals are labelled
  as such.
