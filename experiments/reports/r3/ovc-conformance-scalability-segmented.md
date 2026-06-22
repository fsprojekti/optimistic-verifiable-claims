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
| 1 KB       |         1.150.162 |            1123.21 | eth_estimateGas |
| 4 KB       |         4.312.786 |            1052.93 | eth_estimateGas |
| 16 KB      |        16.963.282 |            1035.36 | eth_estimateGas |
| 64 KB      |        67.565.266 |            1030.96 | eth_estimateGas |
| 256 KB     |       269.973.202 |            1029.87 | eth_estimateGas |
| 512 KB     |       539.850.450 |            1029.68 | eth_estimateGas |
| 1 MB       |     1.079.604.946 |            1029.59 | eth_estimateGas |
| 5 MB       |     5.397.640.914 |            1029.52 | eth_estimateGas |
| 10 MB      |    10.795.185.874 |            1029.51 | eth_estimateGas |
| 25 MB      |    26.987.820.754 |            1029.50 | eth_estimateGas |
| 50 MB      |    53.975.545.554 |            1029.50 | eth_estimateGas |

Table R3b-C: Total adjudication gas - OVC-Conformance (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 1 KB           | 0.074(N=64) |0.295(N=256) |1.178(N=1024) |5.889(N=5120) |11.778(N=10240) |29.444(N=25600) |58.888(N=51200) |
| 4 KB           | 0.069(N=16) | 0.276(N=64) |1.104(N=256) |5.520(N=1280) |11.041(N=2560) |27.602(N=6400) |55.204(N=12800) |
| 16 KB          |  0.068(N=4) | 0.271(N=16) | 1.086(N=64) |5.428(N=320) |10.857(N=640) |27.141(N=1600) |54.283(N=3200) |
| 64 KB          |  0.068(N=1) |  0.270(N=4) | 1.081(N=16) | 5.405(N=80) |10.811(N=160) |27.026(N=400) |54.052(N=800) |
| 256 KB         |           - |  0.270(N=1) |  1.080(N=4) | 5.400(N=20) |10.799(N=40) |26.997(N=100) |53.995(N=200) |
| 512 KB         |           - |           - |  1.080(N=2) | 5.399(N=10) |10.797(N=20) |26.993(N=50) |53.985(N=100) |
| 1 MB           |           - |           - |  1.080(N=1) |  5.398(N=5) |10.796(N=10) |26.990(N=25) |53.980(N=50) |
| 5 MB           |           - |           - |           - |  5.398(N=1) | 10.795(N=2) | 26.988(N=5) |53.976(N=10) |
| 10 MB          |           - |           - |           - |           - | 10.795(N=1) | 32.386(N=3) | 53.976(N=5) |
| 25 MB          |           - |           - |           - |           - |           - | 26.988(N=1) | 53.976(N=2) |
| 50 MB          |           - |           - |           - |           - |           - |           - | 53.976(N=1) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
