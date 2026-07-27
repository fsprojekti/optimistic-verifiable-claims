# R3-I Summary

Source script: tests\r3\ovc-identity-scalability-segmented.js

```text

========================================================================================
R3-I — OVC-Identity adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: revealKey=53.757 | startAdjudication=34.996 | finalizeAdjudication=39.454
C is posted to the Demand at bidding and read cross-contract. The derived matrix covers adjudication txs only: revealKey + startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-I: OVC-Identity per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 14 KB      |        11.486.021 |             801.20 | eth_estimateGas |
| 15 KB      |        12.299.381 |             800.74 | eth_estimateGas |
| 80 KB      |        65.339.381 |             797.60 | eth_estimateGas |
| 88 KB      |        71.890.741 |             797.79 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 14 KB          |  0.058(N=5) | 0.218(N=19) | 0.850(N=74) |4.204(N=366) |8.408(N=732) |21.008(N=1829) |42.016(N=3658) |
| 15 KB          |  0.062(N=5) | 0.222(N=18) | 0.849(N=69) |4.207(N=342) |8.401(N=683) |20.995(N=1707) |41.990(N=3414) |
| 80 KB          |           - |  0.261(N=4) | 0.850(N=13) | 4.182(N=64) |8.364(N=128) |20.909(N=320) |41.817(N=640) |
| 88 KB          |           - |  0.216(N=3) | 0.863(N=12) | 4.242(N=59) |8.411(N=117) |20.920(N=291) |41.841(N=582) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after bidding (Demand.postDemand -> depositCiphertextChunk -> seal) then binding (commitClaim -> setDemand -> dispute -> revealKey -> startAdjudication). processChunk reads C cross-contract from the Demand. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
