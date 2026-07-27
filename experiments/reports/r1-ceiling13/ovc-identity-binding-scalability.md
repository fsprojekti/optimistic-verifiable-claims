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
| 13 KB      |          9.512.775 |             714.60 | eth_estimateGas |

Table R1b.2: OVC-Identity total demand+bind gas vs chunk × G-code
Derived: total = ⌈G-code/chunk⌉ × per_chunk (bidding) + commitClaim + setDemand + acceptClaim (binding)
Values shown in gigagas (Ggas, ×10^9)
--------------------------------------------------------------------------------------------------------------
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 13 KB          |  0.048(N=5) | 0.191(N=20) | 0.752(N=79) |3.748(N=394) |7.496(N=788) |18.740(N=1970) |37.471(N=3939) |
================================================================================
Bold diagonal (chunk = G-code) is the monolithic boundary — single tx.
Top rows (small chunks) reveal the per-tx ~21 K overhead penalty.
================================================================================
```
