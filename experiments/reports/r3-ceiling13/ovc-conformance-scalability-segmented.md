# R3-C Summary

Source script: tests\r3\ovc-conformance-scalability-segmented.js

```text

========================================================================================
R3-C — OVC-Conformance adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: startAdjudication=37.283 | finalizeAdjudication=37.291
G is deposited only after dispute. The derived matrix covers adjudication txs only: startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-C: OVC-Conformance per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 13 KB      |        13.800.658 |            1036.71 | eth_estimateGas |

Table R3b-C: Total adjudication gas - OVC-Conformance (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 13 KB          | 1.090(N=79) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
