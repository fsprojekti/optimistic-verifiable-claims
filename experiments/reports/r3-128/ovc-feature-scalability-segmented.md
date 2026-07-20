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
| 128 KB     |       291.385.894 |            2223.10 | eth_estimateGas |

Table R3b-F: Total adjudication gas - OVC-Feature (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 128 KB         |  2.331(N=8) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
