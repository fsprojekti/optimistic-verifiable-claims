# Conformance testnet campaign, 25 November 2026 (pre-registered)

Written before any transaction of this campaign was sent. Owner decision (25 November 2026):
the new Conformance sweep is measured on the public testnets instead of borrowing the Feature
sweep's network gas ratio and steps (T12 proxy).

## Why

D7 replaced OVC-Conformance's marker scan with the machine-profile predicate. T0′ shows that no
other contract changed, so the Stage 05 testnet runs still describe every other operation. The
new sweep parses every line and allocates memory per move; its network gas and its steps (which
include the client's gas estimation of a heavy call) were not measured on any public network.

## Runs

`code/scripts/run-testnet-fullpath.js` with `OVC_CONFORMANCE_ONLY=1`: deploy
`OVCConformanceSegmented`, register the Prusa XL profile, then per file the declaration (PLA
window, H = highest extruding Z), claim set-up, dispute, deposit sweep, start, adjudication sweep
and finalization, in the order and under the operation names of `tests/pilot/conformance-ladder.js`.
Same signer, journals, 250-ms receipt poll and retry rules as the 2 November campaign. Corpus:
`_local-tools/ovc-stage08-canonical-corpus` (exact frozen hashes, checked per file). Launcher:
`code/scripts/run-conformance-testnet.sh <net>`, networks in parallel, runs within a network
sequential.

| Network | Chunk | Runs | Local pairing |
|---|---:|---|---|
| sepolia | 4,160 | `sepolia` (3 hinge outputs) | `conformance-r1-2026-11-25/chunk-4160` |
| arbitrumSepolia | 8,000 | `arbitrumSepolia` (3 hinge outputs) | `conformance-r1-2026-11-25/chunk-8000` |
| megaethTestnet | 31,872 | `megaethTestnet-31872` (3 hinge outputs), then `megaethTestnet-31872-benchy` (Benchy Prusa) | `conformance-r1-2026-11-25/chunk-31872`, `conformance-ladder-2026-11-25/chunk-31872/benchy-prusa` |
| Ethereum gas | 4,160 | `mainnet-fork` (3 hinge outputs; local Anvil fork of mainnet, as on 30 October) | `conformance-r1-2026-11-25/chunk-4160` |

A local Anvil dry run (25 November, before this file) paired all 441 receipts with
`conformance-r1-2026-11-25/chunk-4160` at identical gas; it was deleted and is not evidence.

## Use in the paper (fixed now)

1. **Gas.** Every Conformance operation (registration, declaration, claim set-up, the five
   dispute operations) takes the per-operation ratio public/local measured here: Arbitrum from
   `arbitrumSepolia`, MegaETH from `megaethTestnet-31872` and `-benchy` pooled, Ethereum from
   `mainnet-fork`. This replaces the T12 proxy (Feature sweep ratio, postDemand ratio). Sepolia
   gas is reported but not used (Glamsterdam schedule, as in Stage 05).
2. **Steps.** The two Conformance chunk operations (`conformanceDepositChunk`,
   `conformanceProcessChunk`) draw their steps from this campaign's runs of the chain's testnet,
   by the same two-level bootstrap (run first, then blocks of 10 consecutive steps; a run with
   fewer than 20 steps of the operation draws from this campaign's pooled steps). Every other
   operation, including all fixed calls, keeps the steps of the 2 November campaign, so the
   undisputed path is unchanged.
3. **Exclusions.** Only the existing rules: preparation gaps above 120 s (relaunches) are
   excluded and reported; steps timed with the 2-s poll are not used.

## Checks (reported, whatever the outcome)

- Every file ends Conformance Valid; every receipt has status 1.
- Every public receipt pairs with exactly one local receipt (artifact, operation, chunk index).
- Per-operation ratio and its per-transaction range; median step of the new sweep against the
  Feature sweep's median step on the same network (the proxy it replaces).
- Benchy Conformance dispute on MegaETH: measured active duration and the duration the model
  gives for it from the hinge run alone (not a validation criterion; no threshold is set).

No run is repeated or dropped because of its result. A run stopped by a non-retryable error is
reported with the error.
