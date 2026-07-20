# Optimistic Verifiable Claims (OVC) — Reproducibility Package

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20794987.svg)](https://doi.org/10.5281/zenodo.20794987)

This repository contains the smart contracts, gas-measurement test suite, and the raw
measurement results for the paper:

> **Optimistic Verifiable Claims: A Blockchain Protocol for Conditionally Confidential
> Bidding in Decentralized Manufacturing.**
> Marko Corn, Nejc Rožman, Primož Podržaj. Faculty of Mechanical Engineering, University
> of Ljubljana.

It lets a reader (i) re-run every on-chain gas measurement reported in the paper and
(ii) inspect the exact result files those measurements produced. All numbers in the paper
are raw EVM gas; the chain-cost and dispute-duration projections (R4) are computed
analytically from these gas measurements and the deployment-chain parameters given in the
paper, so R4 requires no separate execution. The R4 model is stated in full under
"Reproducing R4" below so the projections can be re-derived from the CSVs alone.

> **Note.** This package reproduces the *measurements and result files*. It does not
> include the figure-rendering scripts; the figures in the paper are visualisations of the
> CSV data under `experiments/raw-data/`.

---

## Repository layout

```
contracts/            Solidity sources (OVC base + four instances, monolithic & segmented)
  OVCBase.sol             atomic OVC primitive / FSM
  OVCAccess.sol           OVC-Access      (key access + provider linkage)
  OVCIdentity.sol         OVC-Identity    (K|G|C triple + XOR consistency)
  OVCConformance.sol      OVC-Conformance (G-code G0/G1 syntax scan)
  OVCFeature.sol          OVC-Feature     (net material consumption, G-code machine model)
  OVC*Segmented.sol       segmented (chunked) variants
  OVCBaseSegmented.sol    segmented base (rolling-hash anchoring)
  BindingPhase.sol        atomic four-instance binding coordinator

tests/                Hardhat gas-measurement suite (see tests/run.md for full commands)
  scenarios/             end-to-end per-instance scenario tests (R-labels in run.md)
  r1/                    R1 — binding-phase gas, chunk-size sweep
  r2/                    R2 — optimistic / stage-level outcome gas
  r3/                    R3 — scalability: monolithic + segmented adjudication
  benchy-showcase.js     all four instances on the real 3DBenchy artifact
  feature-parser.js      OVC-Feature machine-model correctness suite
  lib/gcode-reference.js off-chain reference implementation of f(G)
  *.gcode                real slicer output used as measurement input
  run.md                 canonical, copy-pasteable run commands
  run-128.ps1            focused single-chunk (128 KB) probe runner

scripts/
  benchmarkCsv.js       CSV/Markdown report writer used by the tests (required)

experiments/          PRE-COMPUTED RESULTS (the exact files used in the paper)
  raw-data/              measured CSVs (re-running the tests overwrites these)
    r1/ r1-812/ r1-ceiling/ r1-ceiling13/ r2/
    r3/ r3-128/ r3-812/ r3-ceiling/ r3-ceiling13/
  reports/              human-readable .md/.txt summaries per measurement
  error-catalog.md      notes on failure modes encountered during measurement

hardhat.config.js     Solidity 0.8.20, optimizer disabled (conservative upper-bound gas)
```

The measured results are committed under `experiments/`, so the paper's numbers can be
inspected without re-running anything. Re-running the tests regenerates these files
in place.

---

## Requirements

- **Node.js 20.x** and npm
- **Foundry / Anvil** — used as the local EVM node with a very high block gas limit, which
  is required for the monolithic adjudication tests (single transactions exceeding 88 M
  gas). Install via <https://book.getfoundry.sh/getting-started/installation>.
- ~16 GB RAM for the large-artifact (R1/R3) sweeps; the commands set a 16 GB Node heap.

Solidity is compiled with the **optimizer disabled** (0 runs), so all reported gas
figures are conservative upper bounds, exactly as in the paper.

---

## Setup

```bash
npm install
npx hardhat compile
```

---

## Reproducing the measurements

Start a local Anvil node once (high gas limit so monolithic reveals fit a single block):

```bash
anvil --host 0.0.0.0 --port 8545 --gas-limit 300000000000 --no-request-size-limit
```

Then run the suites below from the repository root. `tests/run.md` is the canonical,
copy-pasteable list (including the environment-variable overrides for custom
chunk/G-code ladders); the essentials are:

```powershell
# R1 — Binding phase (chunk-size sweep + coordinator)
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r1/ovc-identity-binding-scalability.js --network localhost
npx hardhat test tests/r1/binding-phase.js --network localhost

# R2 — Optimistic / stage-level outcome gas
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r2/ovcGas.test.js --network localhost

# R3 — Scalability: monolithic baselines
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-identity-scalability.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-conformance-scalability.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-feature-scalability.js --network localhost

# R3 — Scalability: segmented (chunked) adjudication
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-identity-scalability-segmented.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-feature-scalability-segmented.js --network localhost
```

Each test writes a CSV to `experiments/raw-data/<group>/` and a summary to
`experiments/reports/<group>/`. The focused 128 KB probe (`tests/run-128.ps1`) writes to
the `*-128` subdirectories so it does not overwrite the full-spectrum results.

End-to-end per-instance scenario checks (correctness, not scaling):

```powershell
npx hardhat test tests/scenarios/ovc-access.js      --network localhost
npx hardhat test tests/scenarios/ovc-identity.js    --network localhost
npx hardhat test tests/scenarios/ovc-conformance.js --network localhost
npx hardhat test tests/scenarios/ovc-feature.js     --network localhost
```

---

## Mapping results to the paper

| Paper element | Measurement | Result files |
|---|---|---|
| Stage-level lifecycle gas (four outcomes) | R2 | `experiments/raw-data/r2/`, `experiments/reports/r2/` |
| Binding-phase upload gas vs. chunk size | R1 | `experiments/raw-data/r1/`, `r1-128/` |
| Monolithic adjudication baseline (Block Horizon) | R3 monolithic | `experiments/raw-data/r3/ovc-*-scalability-raw.csv` |
| Segmented adjudication / forensic gradient | R3 segmented | `experiments/raw-data/r3/ovc-*-segmented-*.csv`, `r3-128/` |
| Chain cost & dispute-duration projections | R4 (analytical) | derived in the paper from R1–R3 gas + chain parameters |

---

## Reproducing R4 (chain projections)

R4 executes no transactions. It maps the measured gas onto deployment chains using only
the CSVs in `experiments/raw-data/` and the chain parameters in the paper.

**1. Operating chunk.** For each chain, take the largest chunk whose heaviest per-chunk
transaction consumes at most 95% of that chain's block gas limit. The heaviest transaction
is `OVC-Feature processChunk` at every chunk size, so the semantic predicate sets the
operating point. Per-chunk gas is in
`experiments/raw-data/r3*/ovc-*-segmented-per-chunk-raw.csv`. Chunk sizes are sampled near
each chain's ceiling (hence the `r3-812`, `r3-ceiling`, `r3-ceiling13` sweeps) rather than
on a power-of-two grid, because total gas is nearly chunk-independent while transaction
count is inversely proportional to chunk size.

**2. Worst-case dispute gas** (all four instances contested), for artifact size `n` at
operating chunk `s`, with `N = ceil(n / s)`:

```
gas = n * bind_rate                      OVC-Identity ciphertext upload at binding
    + 2 * n * bind_rate                  on-chain deposit of G (Conformance + Feature)
    + N * (id_chunk + conf_chunk + feat_chunk)   adjudication of the three scanning instances
    + access_gas                         OVC-Access, O(1)
```

`bind_rate` is the per-byte gas of `depositChunk` from `experiments/raw-data/r1*/`; the
`*_chunk` terms are the per-chunk values from the R3 files above. The optimistic path is
the first term alone.

**3. Cost and time.**

```
cost_usd = gas * gas_price_gwei * 1e-9 * token_usd
t        = (6 * N + 20) * beta * block_time
```

`beta = 1.5` is the median inclusion factor. The `6N` term is the six size-proportional
transaction sweeps (one upload, two deposits, three adjudications); `+20` covers the O(1)
lifecycle transactions of the four instances. Ethereum is reported as a band over a
congestion factor `delta` in [1, 4].

For the 3DBenchy rows the `*_chunk` terms are replaced by the values measured directly on
the real artifact, reported in `experiments/reports/benchy-showcase.md`.

---

## Citation

If you use this code or data, please cite the paper above and this archived software
record:

> Corn, M., Rožman, N., Podržaj, P. *Optimistic Verifiable Claims (OVC): Reproducibility
> Package*. Zenodo. https://doi.org/10.5281/zenodo.20794987

The DOI above is the *concept* DOI: it always resolves to the latest archived version.
Each release also receives its own version DOI, listed on the Zenodo record.

## License

Released under the MIT License (see `package.json`). Confirm with the authors before
redistribution if a different license is required.
