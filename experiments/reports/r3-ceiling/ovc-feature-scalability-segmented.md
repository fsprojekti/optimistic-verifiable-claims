# R3-F Summary

Source script: tests\r3\ovc-feature-scalability-segmented.js

```text

========================================================================================
R3-F — OVC-Feature adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: startAdjudication=37.173 | finalizeAdjudication=39.157
G is deposited only after dispute. The derived matrix covers adjudication txs only: startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-F: OVC-Feature per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 14 KB      |        31.977.930 |            2230.60 | eth_estimateGas |
| 15 KB      |        34.253.835 |            2230.07 | eth_estimateGas |
| 80 KB      |       182.154.841 |            2223.57 | eth_estimateGas |
| 88 KB      |       200.358.391 |            2223.44 | eth_estimateGas |

Table R3b-F: Total adjudication gas - OVC-Feature (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 14 KB          | 2.366(N=74) |
| 15 KB          | 2.364(N=69) |
| 80 KB          | 2.368(N=13) |
| 88 KB          | 2.404(N=12) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
