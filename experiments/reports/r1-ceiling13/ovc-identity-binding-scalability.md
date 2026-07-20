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

Table R1b.1: OVC-Identity per-deposit-chunk gas vs chunk size
commitClaim O(1) = 164.285 gas   |   acceptClaim O(1) = 35.428 gas
--------------------------------------------------------------------------------
| Chunk size | Per-chunk gas      | Effective gas/byte | Method          |
|------------|--------------------|--------------------|-----------------|
| 13 KB      |          9.547.464 |             717.21 | eth_estimateGas |

Table R1b.2: OVC-Identity total binding gas vs chunk × G-code
Derived: total = commitClaim + ⌈G-code/chunk⌉ × per_chunk + acceptClaim
Values shown in gigagas (Ggas, ×10^9)
--------------------------------------------------------------------------------------------------------------
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 13 KB          | 0.754(N=79) |
================================================================================
Bold diagonal (chunk = G-code) is the monolithic boundary — single tx.
Top rows (small chunks) reveal the per-tx ~21 K overhead penalty.
================================================================================
```
