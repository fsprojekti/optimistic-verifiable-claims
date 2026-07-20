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
| 14 KB      |        14.854.866 |            1036.19 | eth_estimateGas |
| 15 KB      |        15.909.074 |            1035.75 | eth_estimateGas |
| 80 KB      |        84.432.594 |            1030.67 | eth_estimateGas |
| 88 KB      |        92.866.258 |            1030.56 | eth_estimateGas |

Table R3b-C: Total adjudication gas - OVC-Conformance (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 14 KB          | 1.099(N=74) |
| 15 KB          | 1.098(N=69) |
| 80 KB          | 1.098(N=13) |
| 88 KB          | 1.114(N=12) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
