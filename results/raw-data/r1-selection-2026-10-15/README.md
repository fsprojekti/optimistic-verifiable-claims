# Extended R1 measurements - 15 October 2026

Completed local execution of the current Stage 04 production contracts. No public-network
transactions or confidential customer inputs were used. The frozen inputs are the paired
`rackstack_hinge` Cura (264,386 bytes), Orca (280,935 bytes) and Prusa (316,712 bytes) files.

## Scope and result

All three complete inputs were executed at chunk sizes 1,024, 2,048, 3,072, 4,096, 4,160,
4,224, 5,120, 6,144, 8,192, 16,384, 32,768, 65,536 and 131,072 bytes, plus one whole-file
chunk per artifact. Each of the 42 jobs adjudicated Access, Identity, Conformance and Feature:
168 Valid outcomes, independently confirmed from receipt events, and 16,966 successful
recorded transactions. Contract deployment receipts are outside this transaction count.
The nine original 3-KiB predicate gas profiles were reproduced exactly.

For the reference budget of 16,777,216 gas and fill factor 0.95 (15,938,355.2 gas),
4,160 bytes is the largest tested common feasible candidate. Identity is limiting:
its maximum transaction uses 15,835,195 gas at 4,160 bytes and 16,077,244 at 4,224 bytes.
The combined chunk count falls from 283 at 3 KiB to 209, a 26.15% reduction. Across six
size-dependent sweeps, this removes 444 chunk transactions for the three disputed jobs.
This is a result for the measured candidate grid and three inputs of one geometry, not
a byte-level global optimum, arbitrary-input guarantee or public-testnet certification.
Existing public measurements remain at 3,072 bytes.

Whole-file execution uses the current production kernels with one chunk per artifact.
Upload, deposits and processing remain separate transactions; the whole protocol is not
collapsed into one transaction. Whole-file Identity uses 1.052-1.273 billion gas.

## Environment and evidence

Anvil 1.7.1, Cancun, chain 31337, localhost port 19545; 10-billion-gas block limit and
3-billion-gas kernel transaction allowance permit measurement beyond the reference budget.
Solidity 0.8.20, optimizer enabled with 200 runs, Paris compiler target. The compilation
validation checks the dependency closure of all six deployed contract artifacts.

- `campaign.json`: configuration, source hashes, compiler settings and completed cases.
- `audit.json`: independent reconciliation, verdict verification and evidence SHA-256 hashes.
- `process-summary.csv` and `case-summary.csv`: exact gas measurements and reference-budget screen.
- `compilation-validation.json`: source/build/artifact consistency.
- Case directories: streamed receipts, exact transaction/summary/predicate CSVs and run metadata.
- Compressed RPC receipt archives: independently re-fetched before each local node stopped.
  The first three cases use the shared `rpc-receipts-before-restart.json` archive.
- `node-checkpoint.json` and the recorded startup attempt preserve node lifecycle history.

The later cases used fresh local nodes to avoid growing state-management overhead. A failed
prune-history-zero startup produced no measurement receipts; the completed isolated runs used
prune-history one. Local wall times are not treated as comparative network performance.
This README was added after the final evidence audit and is descriptive documentation.

## Reproduction

From the repository root, the offline audit can be reproduced with:

```powershell
python research/stage-04-jestech-corpus-testnet/code/scripts/audit-r1-local.py
```

It reads archived RPC receipts; it does not contact a public chain. Regenerate paper tables
and plots with `paper/build.ps1`. The measurement entry points are `code/scripts/run-r1-local.py`
and `code/scripts/run-r1-isolated.py`, with `code/tests/pilot/r1-chunk-selection.js` as the runner.
Their source hashes are frozen in the campaign. They preserve completed cases and reject
incomplete receipt overwrites. A fresh measurement campaign should use a separate working
copy and output directory; preserve this completed archive. The isolated driver expects an
initialized campaign manifest and Anvil at the recorded user installation path.
