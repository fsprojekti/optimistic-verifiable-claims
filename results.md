# Results

Append dated results and interpretations here. Do not silently replace results after the stage is
closed.


## 22 October 2026 — T2 chain operating chunks

Campaign `results/raw-data/r1-chain-brackets-2026-10-22` (fresh Anvil 1.7.1 per size; three
`rackstack_hinge` outputs; complete four-claim path): 6 sizes, 72 Valid outcomes, 2,934 receipts,
all re-fetched and archived. Maximum transaction in every case is Identity `processChunk`.

| Size (B) | Max tx gas | ≤ 0.95 × 32 M | ≤ 0.95 × 100 M |
|---|---|---|---|
| 7,936 | 30,126,898 | yes | yes |
| 8,000 | 30,369,320 | yes | yes |
| 8,064 | 30,611,748 | no | yes |
| 24,896 | 94,589,440 | no | yes |
| 24,960 | 94,833,535 | no | yes |
| 25,024 | 95,077,635 | no | no |

Operating chunks (φ = 0.95): Ethereum 4,160 B (EIP-7825 cap 16,777,216; Stage 04 R1),
Arbitrum One 8,000 B (32 M), opBNB 24,960 B (100 M). Final binding: 1.93 M gas; Access reveal: 0.43 M.

## 22 October 2026 — Correction: T2 superseded by D6

While preparing the Feature description, corpus Benchy showed that the Feature model ignored
G2/G3 arc moves (see [D6](decisions/D6-FEATURE-ARC-MOVES.md)). The T2 bracket campaign above and
the first ladder case were produced with the defective Feature code; their evidence directories
were removed, and the corpus ladder was stopped after one completed case. The maximum
transaction in every bracket was Identity `processChunk`, whose code is unchanged, so the
operating chunks are expected to stand; they are re-derived from the corrected R1 sweep
`r1-chunk-sweep-2026-10-22` (20 configurations, including whole-file) before the ladder restarts.

## 22 October 2026 — T2 R1 chunk sweep (corrected Feature)

Campaign `results/raw-data/r1-chunk-sweep-2026-10-22`: 20 configurations (19 chunk sizes from
1,024 to 131,072 B and one whole-file chunk) on the three `rackstack_hinge` outputs, complete
four-claim path, fresh Anvil per configuration: 240 Valid outcomes, 19,900 audited receipts.

Operating chunks (φ = 0.95), limiting process OVC-Identity in every case:

| Chain (limit) | c* | Max tx at c* | Fill | Next size |
|---|---|---|---|---|
| Ethereum (16.78 M, EIP-7825) | 4,160 B | 15,835,195 | 94.4% | 4,224 B: 16,077,244 |
| Arbitrum One (32 M) | 8,000 B | 30,369,320 | 94.9% | 8,064 B: 30,611,748 |
| opBNB (100 M) | 24,960 B | 94,833,535 | 94.8% | 25,024 B: 95,077,635 |

Per-process bounds (linear interpolation; KiB): upload 21.8 / 41.7 / 130.5 (extrapolated),
Identity 4.1 / 7.8 / 24.4, Feature 9.5 / 18.1 / 56.7; the Conformance scan stops at the first
marker, so its per-chunk gas is flat (≤ 1.26 M) and unbounded within the grid. Whole-file
Identity on the hinge files: 1.05–1.27 billion gas for 264–317 kB.

After this campaign the ladder driver gained an accept-path mode and a configurable kernel gas
limit (defaults unchanged); the runner gained per-campaign settings. The sweep's `campaign.json`
records the earlier source hashes.

## 22 October 2026 — T6 R3 accepted path

Campaign `results/raw-data/r3-accept-2026-10-22`: nine files (rackstack_hinge, electronics_enclosure,
amazing_distal_shell; 0.26–4.43 MB) at 24,960-byte chunks, posting, publication, binding and the
Provider's `accept`: 36 Accepted outcomes, all receipts audited. Binding + acceptance:
2,037,272–2,037,296 gas (spread 24 gas), independent of size. Stage 01: 1,007,554 gas; the increase
is the RSA-OAEP key, envelope and linkage pinned for OVC-Access.

## 22 October 2026 — T7 first attempt failed (transport limit)

The first monolithic case (electronics_enclosure, Cura, 1.57 MB) failed with `ECONNRESET` on the
whole-file upload: Anvil's default request-body limit is 2 MB. The 0.26–0.32 MB whole-file runs of
T2 were below it. The rerun adds `--no-request-size-limit` after the corpus ladder completes (the
runner cannot change while the ladder's source hashes are pinned); the failed attempt's directory
is moved aside then.

## 26 October 2026 — T3 throughput and batched sweeps

After 28 of 45 ladder cases (all 15 at 24,960 B; 13 at 8,000 B) the campaign had run four days
instead of the estimated 14 hours. Anvil was CPU-bound (one core) and its throughput fell with
contract storage: from ~12 tx/s to ~0.25 tx/s on the 43.7 MB files (chunk-8000/aloha_under_arm-cura:
16.5 h). A separate deposit-only benchmark showed the same decline (4.5 → 1.6 tx/s between 2.5 and
12.5 MB stored) with and without `--prune-history`, consistent with per-block state work that grows
with storage while every transaction is mined in its own block.

The remaining cases therefore use `tests/pilot/corpus-ladder-batched.js`: identical transactions,
but the four artifact-wide sweeps are submitted with automine disabled and mined 100 per block.
Validation (`results/raw-data/batched-validation-2026-10-26/chunk-24960-benchy-cura`, fresh node):
2,643 of 2,644 transactions have byte-identical gas to the original measurement; the one difference
is `bindProvider` (+12 gas), whose calldata contains the random RSA-OAEP envelope (zero versus
non-zero bytes). All four outcomes Valid; 46 blocks instead of 2,644; 117 s instead of 1,404 s.

The original campaign stops after chunk-8000/moveo_articulation-orca; the remaining 16 cases
(chunk-8000/nasa_wrench-prusa and all 15 at 4,160 B) run as `corpus-ladder-batched-2026-10-26`,
followed by the monolithic rerun (`--no-request-size-limit`).

## 29 October 2026 — Public testnets, MegaETH chunk, network model (owner decision)

The deployment chains are now Ethereum, Arbitrum One and MegaETH (replacing opBNB), each
represented by its public testnet. Archive: `results/raw-data/testnet-fullpath-2026-10-29/`
(journals, `journal-transactions.csv`, run state and logs per run).

| Run | Chunk | Files | Confirmed tx | Outcomes |
|---|---:|---|---:|---|
| sepolia | 4,160 | 3 hinge, full path | 1,314 | 12 Valid |
| sepolia-accept | 4,160 | hinge Cura, undisputed | 80 | 4 Accepted |
| arbitrumSepolia | 8,000 | 3 hinge, full path | 720 | 12 Valid |
| arbitrumSepolia-accept | 8,000 | hinge Cura, undisputed | 50 | 4 Accepted |
| megaethTestnet | 24,960 | 3 hinge, full path | 276 | 12 Valid (chunk-dependence check) |
| megaethTestnet-49728-rejected | 49,728 | setup, posting | 13 | first deposit rejected (slot limit) |
| megaethTestnet-31872 | 31,872 | 3 hinge, full path | 227 | 12 Valid |
| megaethTestnet-31872-accept | 31,872 | hinge Cura, undisputed | 25 | 4 Accepted |
| megaethTestnet-31872-benchy | 31,872 | Benchy Prusa, full path | 2,313 | 4 Valid (validation) |

Every public receipt pairs with its local counterpart (0 unpaired). Gas ratios public/local:
Arbitrum 1.00000 for every operation except Access (1.063, EIP-7883 in ArbOS); MegaETH
processing 1.0004-1.0009, storage writes 1.227, fixed calls 1.6-2.2; Sepolia (Glamsterdam,
EIP-8037 state gas) uploads and plaintext deposits 4.80-4.81, postDemand 4.32, bindProvider
4.56, Identity processing 1.001, Feature 1.015, Conformance scan 1.22. Access gas equals the
independent Stage 04 public Access campaign on all three networks (601,062 / 510,742 / 628,422).

MegaETH operating chunk: the MegaEVM limit of 1,000 new storage slots per transaction binds
the deposit; bisection on the testnet (`megaeth-chunk-probe-2026-10-29/probe.json`): 31,872 B
admitted, 31,936 B rejected. Compute alone would allow 49,728 B (local bracket
`r1-megaeth-bracket-2026-10-29`; the ladder started at 49,728 B is kept as
`corpus-ladder-megaeth-49728-aborted-2026-10-29`). Local: `r1-megaeth-chunk-2026-10-29`
(hinge at 31,872 B) and `corpus-ladder-megaeth-2026-10-29` (15 cases, all Valid, audited).

Validation (Benchy Prusa on MegaETH, model fitted to the hinge files): gas 97.348 predicted
against 97.357 Ggas measured (-0.010 %); active time 3.67 h against 2.78 h [2.62-2.93] predicted
(+32 % measured), deposit preparation on the endpoint slowing from 0.7 s to 2-4 s during the run.
Projections pool all measured steps.

Benchy Prusa (full cost = posting + publication + binding + all four disputes):
Ethereum $62,661 / 70.9 h, Arbitrum $4,950 / 6.8 h, MegaETH $262.84 / 3.6 h; undisputed
$13,739 / 12.3 h, $470.35 / 1.0 h, $28.57 / 9.5 min. Instance shares of a fully contested
dispute: Ethereum Feature 41 %, Identity 30 %, Conformance 28 %; Arbitrum 34 / 55 / 11 %;
MegaETH 35 / 53 / 12 %.

Runner incidents (none affects a recorded receipt): Sepolia stale nonce from the load-balanced
RPC re-signed one identical transaction (conformanceProcessChunk[11]/[12]); the journal was
repaired (backup `sepolia/consumer.journal.before-nonce-repair.json`) and now rejects reused
nonces and duplicate hashes. A first launch per network polled receipts every 2 s; those steps
are excluded from timing (poll_ms column). OneDrive rename locks and endpoint errors were
retried.

## 30 October 2026 — Ethereum gas on a mainnet fork (owner decision)

Archive: `results/raw-data/mainnet-fork-2026-10-30/` (`full-path/`, `accept/`, logs,
`fork-node-info.json`). Anvil fork of `ethereum-rpc.publicnode.com` at block 26,303,908
(hardfork Bpo1), chain id 31337, Ethereum operating chunk 4,160 B.

| Run | Files | Receipts | Outcomes |
|---|---|---:|---|
| full-path | 3 hinge, full path | 1,313 | 12 Valid |
| accept | hinge Cura, undisputed | 80 | 4 Accepted |

Fork/local gas ratio 1.00000 for every operation except `accessRevealWitness` 1.0634
(EIP-7883 ModExp repricing). Access increment 510,746 gas. Benchy Prusa on Ethereum:
undisputed $2,855 / 12 h, full cost $29,875 / 3 days; instance shares of a fully contested
dispute: Identity 55 %, Feature 34-35 %, Conformance 11-12 % (Identity 54.5-55.8 % across the
corpus).

Benchy time validation on MegaETH (29 October, +32 %) is judged invalid as a validation: the
run differed from the hinge runs in deposit preparation (0.7 s -> 2-4 s), whose client and
endpoint shares were not recorded, and the client's journal was on OneDrive (one EPERM lock).
To be repeated with an instrumented client writing outside OneDrive.

## 2-4 November 2026 — Timing revalidation (pre-registered)

Protocol: `results/raw-data/timing-revalidation-2026-11-02/PROTOCOL.md`; launcher
`code/scripts/run-timing-revalidation.sh`; evaluation `code/scripts/evaluate-timing-revalidation.py`
(`results/derived/timing-revalidation/evaluation.json`). Instrumented client (`phases_ms`).

Incidents:
- 2 Nov 10:00Z, first launch through WSL `bash.exe` for 33 s: environment variables did not reach
  the Windows Node process, so the runners opened the 29 October run directories (default
  `OVC_RUN_DIR`). No transaction was sent (all 2,310 journal operations equal the export); launch
  counters, `run-state.json` and two `transactions.csv` were rewritten and have been restored
  byte-identical from the pre-move copy. Relaunched with Git Bash after a 130-s pause.
- 2 Nov 13:11Z, Sepolia `rackstack_hinge:orca/featureProcessChunk[10]` reverted out of gas
  (limit 6,717,943 = gas used; tx 0x34ce90be...3583, block 12,048,364): a lagging backend
  estimated it below the previous chunks (7.15 M limit). Journal backed up
  (`sepolia/consumer.journal.before-revert-repair.json`), the entry kept as `...[10]~reverted-1`
  (status 0), the operation re-sent on 3 Nov. Runner change from that launch on: the gas limit is
  never below 1.05x the largest gas used by the same operation in the run (no effect on timing).

Results (criteria C1 duration in 95 % interval, C2 regime 0.8-1.25x, C3 gas within 0.1 %):

| Validation run | Measured | Predicted [95 %] | C1 | C2 | C3 (gas error) |
|---|---:|---:|---|---|---|
| arbitrumSepolia-enclosure | 1.09 h | 1.00 h [0.99, 1.01] | fail | fail | pass (+0.000 %) |
| megaethTestnet-31872-benchy-a | 4.15 h | 2.64 h [2.54, 2.74] | fail | fail | pass (-0.010 %) |
| megaethTestnet-31872-benchy-b | 3.90 h | 2.64 h [2.54, 2.74] | fail | fail | pass (-0.010 %) |
| sepolia-enclosure | 10.79 h | 10.61 h [10.42, 10.81] | pass | fail | pass (+0.098 %) |

MegaETH: the Identity sweep step is 20-21 s in both Benchy runs against 2.3 s in the hinge run
(x8.8-9.2), while submission-to-receipt stays ~1 s and the recorded client phases ~2 s; the
difference is retry back-off after transient endpoint errors on these 121-Mgas calls (477 in the
first 150 sweep steps of benchy-a). On 29 October the hinge run itself had 21.9-s sweep steps.
Arbitrum: 8.5 % longer; the bootstrap interval (±1 %) does not cover between-run variation.

Sepolia finished on 4 Nov 02:57Z (electronics_enclosure: 2,589 receipts, one relaunch, no gap
over 120 s excluded). Its steps and submission-to-receipt times match the model run per chunk
operation (x0.99-1.08); C2 fails only on client phases, all but one faster in the validation run
(estimate, nonce, populate, balance, broadcast x0.58-0.79, sign and save at 0.4-8 ms). By the
protocol it is still reported as a different regime, not as a validation.

Gas pairing (C3): the evaluation predicts each run's gas with ratios from the same network's
hinge run of this campaign. The first evaluation used the paper's Ethereum ratios (mainnet fork),
which gave -52.5 % against Sepolia's Glamsterdam schedule; that pairing compares two gas
schedules, not the model. With Sepolia ratios the error is +0.098 %; per operation it is within
0.005 % for the deposits and +0.02 % / +0.99 % / +1.31 % for the Identity / Feature / Conformance
sweeps, whose per-transaction Sepolia/local ratio varies (1.00-2.07 for the Feature sweep).

Outcome: by the pre-registered criteria none of the four validation runs counts as a validation
of the duration model. Gas transfers to every network (C3 passes on all four). Durations hold on
Sepolia (C1, -1.7 %) but not on Arbitrum Sepolia (+9 %, interval too narrow for run-to-run
variation) or MegaETH (+48-57 %, endpoint retry back-off on the Identity sweep).

Post-hoc analysis (owner, 4 Nov; not pre-registered): steps whose transaction logged a transient
RPC retry excluded from model and validation alike (`testnet_model.REGULAR_ONLY`; second block of
`evaluation.json`).

| Validation run | Steps kept | Measured | Predicted [95 %] | Error |
|---|---:|---:|---:|---:|
| sepolia-enclosure | 1,328 / 2,577 (model: 839 excluded) | 5.48 h | 5.39 h [5.25, 5.55] | -1.7 % |
| arbitrumSepolia-enclosure | 1,347 / 1,347 (no retries) | 1.09 h | 1.00 h [0.99, 1.01] | -8.6 % |
| megaethTestnet-31872-benchy-a | 1,968 / 2,301 (model: 12) | 1.95 h | 1.17 h [1.13, 1.21] | -40.1 % |
| megaethTestnet-31872-benchy-b | 1,903 / 2,301 (model: 12) | 1.23 h | 1.14 h [1.10, 1.18] | -6.8 % |

Retries are not exceptional on Sepolia (half the steps of both model and validation runs), and
on MegaETH Benchy-a the deposit steps stay 2-4x slower without any logged retry (submission to
receipt 2.18 s against 0.78 s). The exclusion therefore does not isolate a regular regime;
run-to-run variation of the public endpoints remains.

## 4 November 2026 — Duration model on all timing-campaign runs (owner decision)

The testnets are not mainnet, so durations are reported as what the protocol took on them, not as
a validated prediction. `testnet_model.py` now draws steps from every run of the timing campaign
on the chain's testnet (Sepolia: hinge, accept, enclosure; Arbitrum Sepolia: same; MegaETH:
hinge, accept, Benchy a and b) by a two-level bootstrap: each replicate draws one run (the
conditions of one execution), then each operation's steps in blocks of 10 from that run (pooled
when the run has fewer than 20). Gas is unchanged (29 October runs; Ethereum mainnet fork).
Per-operation step mean, median and 5-95 % range are in `results/derived/testnet-model/model.json`.

Leave-one-run-out (each corpus-file run predicted from the chain's other runs):

| Run | Measured | Predicted [95 %] | Error |
|---|---:|---:|---:|
| sepolia-enclosure | 10.79 h | 10.51 h [10.24, 10.77] | -2.6 % |
| arbitrumSepolia-enclosure | 1.09 h | 0.99 h [0.99, 1.00] | -9.0 % |
| megaethTestnet-31872-benchy-a | 4.15 h | 3.83 h [2.57, 4.05] | -7.6 % |
| megaethTestnet-31872-benchy-b | 3.90 h | 4.06 h [2.57, 4.31] | +4.2 % |

Benchy (Prusa) with the new model, median [95 %]: undisputed Ethereum 12.1 h [11.2, 12.9],
Arbitrum 1.1 h [1.0, 1.1], MegaETH 0.2 h [0.2, 0.3]; all four disputes Ethereum 60.5 h
[58.9, 61.6], Arbitrum 6.1 h [5.7, 6.4], MegaETH 3.8 h [2.4, 4.1]. Tables regenerated (copy of
the previous ones in the session scratchpad); manuscript text not yet updated.
