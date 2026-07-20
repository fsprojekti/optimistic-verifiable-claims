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
| 13 KB      |        20.219.163 |            1518.87 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 13 KB          | 1.597(N=79) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> depositChunk(C) -> dispute -> revealKey -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
