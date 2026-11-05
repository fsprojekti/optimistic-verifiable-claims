# Optimistic Verifiable Claims (OVC) — Reproducibility Package

[![DOI](https://zenodo.org/badge/DOI/10.5281/zenodo.20794987.svg)](https://doi.org/10.5281/zenodo.20794987)

Public artifacts accompanying the paper:

> **"Optimistic Verifiable Claims: A Blockchain Protocol for Conditionally Confidential
> Bidding in Decentralized Manufacturing"** — M. Corn, N. Rožman, P. Podržaj
> (arXiv:2607.25517)

**Version 4.0.0** belongs to the revised version of the paper. It contains the smart
contracts, the measurement runners, every archived receipt and the code that generates each
table and figure of the paper from those receipts. Versions 1.0.0–3.0.0 belong to the first
version of the paper (synthetic artifacts, Ethereum/Arbitrum/opBNB) and remain available on
Zenodo and as Git tags.

---

## Protocol in brief

OVC lets a manufacturing Consumer publish a *claim* about a concealed design file (G-code),
for example the length of filament it consumes, so that a Provider can price and bid on it
without seeing the design. A claim is committed when the job is posted and stands unless the
selected Provider challenges it; a challenge triggers a deterministic on-chain check that
exposes any dishonesty. The encrypted design is published only once a Provider is selected,
and the plaintext is disclosed only to settle a dispute.

| Instance | Contract | What it asserts |
| :--- | :--- | :--- |
| **OVC-Access** | `OVCAccess` | the decryption key reaches the selected Provider (RSA-OAEP key handover) |
| **OVC-Identity** | `OVCIdentitySegmented` | the published ciphertext decrypts (ChaCha20) to the committed artifact |
| **OVC-Conformance** | `OVCConformanceSegmented` | the artifact is G-code (G0/G1 motion marker) |
| **OVC-Feature** | `OVCFeatureSegmented` | the artifact commands the declared net filament extrusion (G0–G3, absolute/relative E) |

`Demand.sol` holds the Demand and the deferred ciphertext; `BindingPhase.sol` instantiates all
four instances against the selected Provider in one coordinator transaction;
`SegmentedCommitment.sol` gives the bounded-transaction (chunked) EVM commitment.

---

## Repository layout

```
code/
  contracts/        Solidity implementation (OVCBase*, the four instances, Demand, BindingPhase,
                    ChaCha20, RSAOAEP, SegmentedCommitment)
  tests/            protocol and unit tests; tests/pilot/ holds the measurement drivers
  scripts/          campaign runners (local Anvil and public testnets) and the result builders
data/corpus/        frozen corpus manifest (SHA-256 of every input), slicer profiles, licenses
results/
  raw-data/         one directory per campaign: receipts, transaction CSVs, run metadata
  derived/          numbers derived from the receipts (paper/stage05-results.json, source map)
  validation/       Access validation records
paper/latex/        tables/ and img/ exactly as generated for the paper
methodology.md      evaluation design;  results.md  results record;  decisions/  design decisions
```

Failed and aborted attempts are kept under `results/raw-data/` and marked as such; no run was
deleted.

### Campaigns used in the paper

| Paper | Campaign directory (`results/raw-data/`) |
| :--- | :--- |
| R1 operating chunk | `r1-chunk-sweep-2026-10-22`, `r1-megaeth-chunk-2026-10-29`, `r1-megaeth-bracket-2026-10-29`, `megaeth-chunk-probe-2026-10-29`, `monolithic-ladder-2026-10-22` |
| R2 demand and publication, R4 disputes | `corpus-ladder-2026-10-22`, `corpus-ladder-batched-2026-10-26`, `corpus-ladder-megaeth-2026-10-29` |
| R3 binding and acceptance | `r3-accept-2026-10-22` |
| Ethereum gas (mainnet fork) | `mainnet-fork-2026-10-30` |
| Transaction timing (public testnets) | `testnet-fullpath-2026-10-29`, `timing-revalidation-2026-11-02` (pre-registered protocol in `PROTOCOL.md`) |
| Chain parameters and fee variability | `chain-params-2026-10-29`, `token-prices-2026-10-29` |

---

## Reproducing

### 1. Regenerate the tables and figures from the archived receipts

Python 3.11+ with `matplotlib` and `numpy`:

```bash
python code/scripts/build-stage05-results.py
```

This rewrites `paper/latex/tables/*.tex`, the figures `paper/latex/img/r*.pdf`,
`results/derived/paper/stage05-results.json` and `results/derived/paper/source-map.json`
(SHA-256 of every input and output). The tables and the JSON are byte-identical to the
archived ones; the PDF figures differ only in their embedded creation date.

### 2. Restore the G-code inputs

The 18 executed files come from the
[OpenGCode MultiSlicer Corpus v1.0.0](https://github.com/fsprojekti/opengcode-multislicer-corpus/releases/tag/v1.0.0).
Download `opengcode-multislicer-corpus-v1.0.0.zip`, verify it against the published `.sha256`,
and copy `opengcode-multislicer-corpus-v1.0.0/data/corpus/generated/gcode/` to
`data/corpus/generated/gcode/` (or point `OVC_CORPUS_ROOT` at the extracted
`data/corpus/generated/`). The runners check every file against
`data/corpus/generated/gcode-manifest.csv`.

### 3. Re-run the measurements

Node.js 20+ and [Foundry](https://getfoundry.sh) Anvil (the campaigns used Anvil 1.7.1):

```bash
cd code
npm ci
npx hardhat test                 # protocol and unit tests
python scripts/run-corpus-ladder.py r1-chunk-sweep-2026-10-22
```

`npx hardhat test` rewrites `results/validation/access-validation.json`; the gas of the
RSA-OAEP calls there varies by a few units with the random padding.

`run-corpus-ladder.py` defines every local campaign. Each case starts a fresh Anvil
(Cancun, raised block gas limit), executes the complete four-claim path and re-fetches and
archives every receipt; it expects Anvil at `%USERPROFILE%/.foundry/bin/anvil.exe`. Gas is
deterministic, so a re-run reproduces the archived `gasUsed` values.

The public-testnet runners (`run-testnet-fullpath.js`, `run-timing-revalidation.sh`) need a
funded testnet-only account in the environment variable `OVC_TESTNET_PRIVATE_KEY`; RPC
endpoints default to public ones and can be overridden in `hardhat.config.js`. Testnet timing
depends on network conditions and is not expected to repeat exactly.

---

## License

Code is released under the MIT License (`LICENSE`). The G-code corpus and the source models
keep their own licenses, listed in `data/corpus/licenses/` and `data/corpus/ATTRIBUTION.md`.

## Citation

Please cite the paper and this archive; `CITATION.cff` gives the archive metadata. The concept
DOI [10.5281/zenodo.20794987](https://doi.org/10.5281/zenodo.20794987) resolves to the latest
version.
