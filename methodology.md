# Methodology

## Scope

The evaluation design of Stage 01 is retained: R1 chunk selection, R2 Demand publication,
R3 binding and R4 dispute adjudication, reported as gas, settlement cost $C_{real}$ and
duration $T(n)$ on Ethereum, Arbitrum One and opBNB. Changes are limited to those listed in
the stage README.

## Protocol version

The D5 implementation inherited from Stage 04 (contracts byte-identical, verified on
22 October 2026): Demand posting of $h_G$, $h_C$, $f_{claim}$, nonce, length and chunk size;
ciphertext upload after Provider selection, sealed against $h_C$; atomic four-claim
binding with an RSA-OAEP key envelope; ChaCha20 artifact encryption; canonical
domain-separated segmented commitments. Solidity 0.8.20, optimizer enabled (200 runs),
Paris target.

## Deployment chains (owner decision 29 October 2026; supersedes the 22 October set)

Ethereum, Arbitrum One and MegaETH (replaces opBNB). Mainnet parameters from
`code/scripts/snapshot-mainnets.js` (`results/raw-data/chain-params-2026-10-29/`): limits and
mean block times over the latest 1,024 blocks; gas price = twelve-month median of base fees
sampled from block headers (4 per day) plus the recent median priority fee. ETH price:
twelve-month CoinGecko daily series (`results/raw-data/token-prices-2026-10-29/`), range
$1,566-$3,905, representative midpoint $2,700 (the Stage 01 method).

| Chain | Testnet | Per-transaction limit | Block time | Gas price | Cost rate |
|---|---|---|---|---|---|
| Ethereum | Sepolia (steps); gas on a mainnet fork (owner decision 30 October) | 16,777,216 (EIP-7825) | 12.07 s | 0.12 gwei | $324/Ggas |
| Arbitrum One | Arbitrum Sepolia | 32,000,000 (execution) | 0.28 s | 0.020 gwei | $54/Ggas |
| MegaETH | MegaETH testnet | 200 M compute; 1,000 new storage slots | 1 s | 0.001 gwei | $2.70/Ggas |

## Network gas and duration model

`code/scripts/testnet_model.py`. Public runs (`run-testnet-fullpath.js`, journaled, 250-ms
receipt poll) of the complete four-claim path for the three hinge outputs at each chain's
operating chunk, plus one undisputed path. Each public receipt is paired with its local
counterpart (artifact, operation, chunk index); network gas of any corpus file = local gas
scaled per operation by the measured ratio. Ethereum gas (owner decision 30 October 2026) is
measured instead on a local Anvil fork of mainnet (block 26,303,908, Fusaka rules), because
Sepolia runs Glamsterdam (EIP-8037); Sepolia still supplies Ethereum's steps. Gas comes from
the 29 October runs. Steps (owner decision 4 November 2026) come from every run of the timing
campaign of 2-4 November (`results/raw-data/timing-revalidation-2026-11-02/PROTOCOL.md`;
instrumented client): per chain the hinge full path, the undisputed path and one larger file
(electronics_enclosure Prusa on Sepolia and Arbitrum Sepolia; Benchy Prusa twice, 8 h apart, on
MegaETH). Durations: two-level bootstrap (2,000 replicates, fixed seed) of measured steps
(previous receipt to own receipt): each replicate draws one run, then blocks of 10 consecutive
steps per chunk operation and for fixed calls from that run (pooled when the run has fewer than
20); gaps > 120 s (client relaunches) excluded. The testnets are not mainnet: durations are
reported as what the protocol took there, not as a validated prediction. Pre-registered check
(hinge-only model): gas within 0.1 % on all four larger-file runs, time not (+2 %, +9 %,
+48-57 %; endpoint retries on MegaETH); leave-one-run-out with the pooled model: within 2.6 %,
9.0 %, 7.6 %. `code/scripts/evaluate-timing-revalidation.py`.

## Chunk selection

$c^* = \max\{z : \max_i g_i^{max}(z) \le \phi\,G_{limit}\}$ with $\phi = 0.95$, evaluated on a
64-byte grid around the boundary, over every size-dependent operation of the complete
four-claim path on the three `rackstack_hinge` outputs. Ethereum: 4,160 B (Stage 04 R1).
Arbitrum and opBNB: campaign `r1-chain-brackets-2026-10-22`.

## Corpus ladder

Synthetic witnesses are replaced by genuine files from OpenGCode MultiSlicer Corpus v1.0.0,
selected to cover the Stage 01 ladder with all three slicers per geometry where possible:

| Stage 01 class | Corpus files |
|---|---|
| 256 KB | rackstack_hinge ×3 (0.26–0.32 MB) |
| 1 MB | electronics_enclosure ×3 (1.57–1.82 MB) |
| 5 MB | amazing_distal_shell ×3 (3.73–4.43 MB) |
| 3DBenchy / 10 MB | benchy ×3 (10.9–12.1 MB) |
| 25 MB | autodesk_fdm ×3 (20.8–28.1 MB) |
| 50 MB | aloha_under_arm (Cura), moveo_articulation (Orca), nasa_wrench (Prusa) (40.0–43.7 MB) |

Each file is executed completely (all chunks, all four disputes) at each chain's $c^*$ on a
fresh local Anvil. Files are verified by size and SHA-256 against the frozen manifest.
Projections beyond the executed sizes are labelled as such; files above 50 MB are executed
only if needed to support a reported value.

## Duration

$T(n)$ follows Stage 01 (transaction count × β × mean block time, with the congestion band),
computed from the measured transaction counts. Testnet wall times from Stage 04 are
reported only as supplementary observations.
