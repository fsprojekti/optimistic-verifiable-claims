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
| 8 KB       |         8.529.618 |            1041.21 | eth_estimateGas |
| 12 KB      |        12.746.450 |            1037.31 | eth_estimateGas |

Table R3b-C: Total adjudication gas - OVC-Conformance (gigagas, x10^9)
| Chunk \ G-code |         1 MB |
|----------------|--------------|
| 8 KB           |1.092(N=128) |
| 12 KB          | 1.096(N=86) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
