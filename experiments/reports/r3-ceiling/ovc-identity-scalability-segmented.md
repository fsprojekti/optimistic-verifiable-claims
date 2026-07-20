# R3-I Summary

Source script: tests\r3\ovc-identity-scalability-segmented.js

```text

========================================================================================
R3-I — OVC-Identity adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: revealKey=53.757 | startAdjudication=34.974 | finalizeAdjudication=39.472
C is deposited during binding. The derived matrix covers adjudication txs only: revealKey + startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-I: OVC-Identity per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 14 KB      |        21.766.965 |            1518.34 | eth_estimateGas |
| 15 KB      |        23.314.783 |            1517.89 | eth_estimateGas |
| 80 KB      |       123.957.273 |            1513.15 | eth_estimateGas |
| 88 KB      |       136.348.713 |            1513.10 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 14 KB          | 1.611(N=74) |
| 15 KB          | 1.609(N=69) |
| 80 KB          | 1.612(N=13) |
| 88 KB          | 1.636(N=12) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> depositChunk(C) -> dispute -> revealKey -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
