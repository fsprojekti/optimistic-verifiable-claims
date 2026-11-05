# Timing revalidation, 2 November 2026 (pre-registered)

Written before any transaction of this campaign was sent.

## Why

The 29 October MegaETH Benchy run took 32 % longer than the hinge-only model predicted. Only
the preparation of the 32 KB deposits slowed (0.7 s to 2-4 s); submission-to-receipt did not.
The client's and the endpoint's shares of that preparation were not recorded, and the journal
was written to a OneDrive-synced folder (one EPERM lock during the run). The run therefore
tested the difference between two regimes, not the model, and is not counted as a validation.

## What changed

- The project is no longer under OneDrive (`C:\Users\marko\Documents`, not redirected; OneDrive
  syncs only `D:\OneDrive - Univerza v Ljubljani`).
- The client records each preparation phase per transaction (`phases_ms`: estimate, nonce,
  populate, balance, sign, save, broadcast) in the journal.

## Runs

All under this directory, one sequential runner per network, networks in parallel (as on
29 October). Same signer, contracts, fixtures, 250-ms receipt poll.

| Network | Chunk | Model runs (fit) | Validation runs (out of sample) |
|---|---:|---|---|
| sepolia | 4,160 | `sepolia` (3 hinge, full path), `sepolia-accept` | `sepolia-enclosure` (electronics_enclosure Prusa, 1.77 MB) |
| arbitrumSepolia | 8,000 | `arbitrumSepolia`, `arbitrumSepolia-accept` | `arbitrumSepolia-enclosure` (same file) |
| megaethTestnet | 31,872 | `megaethTestnet-31872`, `megaethTestnet-31872-accept` | `megaethTestnet-31872-benchy-a`, `-benchy-b` (Benchy Prusa, 12.1 MB, started at least 8 h apart) |

## Prediction

`code/scripts/testnet_model.py`: the validation file's local transactions at the network's
chunk, each operation's step drawn by block bootstrap (block 10, 2,000 replicates, seed
20261029) from the steps of the network's hinge full-path run of this campaign only. Steps
with preparation > 120 s (client relaunch) are excluded from both model and measurement and
reported.

## Criteria (fixed now)

1. **Duration (primary).** The validation is passed when the measured active duration lies in
   the predicted 95 % interval. Reported: measured, predicted median, interval, error in %.
2. **Regime check.** For every chunk operation, the median step of the validation run is
   within 0.8-1.25x the median step of the model run, and so is the median of each preparation
   phase. A run that fails this check is reported as a different regime, with the phase that
   differs, and is not counted as a validation, whether or not criterion 1 holds.
3. **Gas.** Predicted gas within 0.1 % of measured (gas is deterministic; a larger error is a
   pairing or code fault).

Whatever the outcome, all runs are archived and reported; none is repeated or dropped because
of its result. If the model runs differ from those of 29 October, the paper uses this
campaign's model (same client for model and validation).
