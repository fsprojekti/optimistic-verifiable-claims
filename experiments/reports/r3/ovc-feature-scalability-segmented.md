# R3-F Summary

Source script: tests\r3\ovc-feature-scalability-segmented.js

```text

========================================================================================
R3-F — OVC-Feature adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: startAdjudication=37.173 | finalizeAdjudication=39.114
G is deposited only after dispute. The derived matrix covers adjudication txs only: startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-F: OVC-Feature per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 1 KB       |         1.204.274 |            1176.05 | eth_estimateGas |
| 4 KB       |         4.542.338 |            1108.97 | eth_estimateGas |
| 16 KB      |        17.889.946 |            1091.92 | eth_estimateGas |
| 64 KB      |        71.275.730 |            1087.58 | eth_estimateGas |
| 256 KB     |       284.818.866 |            1086.50 | eth_estimateGas |
| 512 KB     |       569.541.498 |            1086.31 | eth_estimateGas |
| 1 MB       |     1.138.986.762 |            1086.22 | eth_estimateGas |
| 5 MB       |     5.694.553.522 |            1086.15 | eth_estimateGas |
| 10 MB      |    11.389.010.810 |            1086.14 | eth_estimateGas |
| 25 MB      |    28.472.382.674 |            1086.14 | eth_estimateGas |
| 50 MB      |    56.944.669.114 |            1086.13 | eth_estimateGas |

Table R3b-F: Total adjudication gas - OVC-Feature (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 1 KB           | 0.077(N=64) |0.308(N=256) |1.233(N=1024) |6.166(N=5120) |12.332(N=10240) |30.829(N=25600) |61.659(N=51200) |
| 4 KB           | 0.073(N=16) | 0.291(N=64) |1.163(N=256) |5.814(N=1280) |11.628(N=2560) |29.071(N=6400) |58.142(N=12800) |
| 16 KB          |  0.072(N=4) | 0.286(N=16) | 1.145(N=64) |5.725(N=320) |11.450(N=640) |28.624(N=1600) |57.248(N=3200) |
| 64 KB          |  0.071(N=1) |  0.285(N=4) | 1.140(N=16) | 5.702(N=80) |11.404(N=160) |28.510(N=400) |57.021(N=800) |
| 256 KB         |           - |  0.285(N=1) |  1.139(N=4) | 5.696(N=20) |11.393(N=40) |28.482(N=100) |56.964(N=200) |
| 512 KB         |           - |           - |  1.139(N=2) | 5.695(N=10) |11.391(N=20) |28.477(N=50) |56.954(N=100) |
| 1 MB           |           - |           - |  1.139(N=1) |  5.695(N=5) |11.390(N=10) |28.475(N=25) |56.949(N=50) |
| 5 MB           |           - |           - |           - |  5.695(N=1) | 11.389(N=2) | 28.473(N=5) |56.946(N=10) |
| 10 MB          |           - |           - |           - |           - | 11.389(N=1) | 34.167(N=3) | 56.945(N=5) |
| 25 MB          |           - |           - |           - |           - |           - | 28.472(N=1) | 56.945(N=2) |
| 50 MB          |           - |           - |           - |           - |           - |           - | 56.945(N=1) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
