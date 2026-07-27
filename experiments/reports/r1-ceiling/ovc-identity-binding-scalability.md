# R1 Summary

Source script: tests\r1\ovc-identity-binding-scalability.js

```text

================================================================================
R1 — BINDING PHASE GAS COST (chain-agnostic EVM measurements)
================================================================================

Table R1a: Binding gas for O(1) instances (Access, Conformance, Feature)
--------------------------------------------------------------------------------
| OVC Instance     | commitClaim    | acceptClaim    |
|------------------|----------------|----------------|
| OVC-Access       |        184.604 |         30.791 |
| OVC-Conformance  |        143.979 |         30.956 |
| OVC-Feature      |        144.001 |         30.978 |

Table R1b.1: bidding-phase per-ciphertext-chunk upload gas vs chunk size (Demand.depositCiphertextChunk)
Binding O(1): commitClaim = 164.263 | setDemand = 78.374 | acceptClaim = 45.008 gas
--------------------------------------------------------------------------------
| Chunk size | Per-chunk gas      | Effective gas/byte | Method          |
|------------|--------------------|--------------------|-----------------|
| 14 KB      |         10.239.806 |             714.27 | eth_estimateGas |
| 15 KB      |         10.966.841 |             713.99 | eth_estimateGas |
| 80 KB      |         58.232.700 |             710.85 | eth_estimateGas |
| 88 KB      |         64.051.203 |             710.80 | eth_estimateGas |

Table R1b.2: OVC-Identity total demand+bind gas vs chunk × G-code
Derived: total = ⌈G-code/chunk⌉ × per_chunk (bidding) + commitClaim + setDemand + acceptClaim (binding)
Values shown in gigagas (Ggas, ×10^9)
--------------------------------------------------------------------------------------------------------------
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 14 KB          |  0.051(N=5) | 0.195(N=19) | 0.758(N=74) |3.748(N=366) |7.496(N=732) |18.729(N=1829) |37.457(N=3658) |
| 15 KB          |  0.055(N=5) | 0.198(N=18) | 0.757(N=69) |3.751(N=342) |7.491(N=683) |18.721(N=1707) |37.441(N=3414) |
| 80 KB          |           — |  0.233(N=4) | 0.757(N=13) | 3.727(N=64) |7.454(N=128) |18.635(N=320) |37.269(N=640) |
| 88 KB          |           — |  0.192(N=3) | 0.769(N=12) | 3.779(N=59) |7.494(N=117) |18.639(N=291) |37.278(N=582) |
================================================================================
Bold diagonal (chunk = G-code) is the monolithic boundary — single tx.
Top rows (small chunks) reveal the per-tx ~21 K overhead penalty.
================================================================================
```
