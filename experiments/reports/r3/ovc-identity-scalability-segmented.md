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
| 1 KB       |         1.646.787 |            1608.19 | eth_estimateGas |
| 4 KB       |         6.289.665 |            1535.56 | eth_estimateGas |
| 16 KB      |        24.862.617 |            1517.49 | eth_estimateGas |
| 64 KB      |        99.177.465 |            1513.33 | eth_estimateGas |
| 256 KB     |       396.805.497 |            1513.69 | eth_estimateGas |
| 512 KB     |       794.560.377 |            1515.50 | eth_estimateGas |
| 1 MB       |     1.593.215.865 |            1519.41 | eth_estimateGas |
| 5 MB       |     8.133.454.713 |            1551.33 | eth_estimateGas |
| 10 MB      |    16.686.240.633 |            1591.32 | eth_estimateGas |
| 25 MB      |    44.861.180.793 |            1711.32 | eth_estimateGas |
| 50 MB      |   100.208.022.393 |            1911.32 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 1 KB           | 0.106(N=64) |0.422(N=256) |1.686(N=1024) |8.432(N=5120) |16.863(N=10240) |42.158(N=25600) |84.316(N=51200) |
| 4 KB           | 0.101(N=16) | 0.403(N=64) |1.610(N=256) |8.051(N=1280) |16.102(N=2560) |40.254(N=6400) |80.508(N=12800) |
| 16 KB          |  0.100(N=4) | 0.398(N=16) | 1.591(N=64) |7.956(N=320) |15.912(N=640) |39.780(N=1600) |79.561(N=3200) |
| 64 KB          |  0.099(N=1) |  0.397(N=4) | 1.587(N=16) | 7.934(N=80) |15.869(N=160) |39.671(N=400) |79.342(N=800) |
| 256 KB         |           - |  0.397(N=1) |  1.587(N=4) | 7.936(N=20) |15.872(N=40) |39.681(N=100) |79.361(N=200) |
| 512 KB         |           - |           - |  1.589(N=2) | 7.946(N=10) |15.891(N=20) |39.728(N=50) |79.456(N=100) |
| 1 MB           |           - |           - |  1.593(N=1) |  7.966(N=5) |15.932(N=10) |39.831(N=25) |79.661(N=50) |
| 5 MB           |           - |           - |           - |  8.134(N=1) | 16.267(N=2) | 40.667(N=5) |81.335(N=10) |
| 10 MB          |           - |           - |           - |           - | 16.686(N=1) | 50.059(N=3) | 83.431(N=5) |
| 25 MB          |           - |           - |           - |           - |           - | 44.861(N=1) | 89.722(N=2) |
| 50 MB          |           - |           - |           - |           - |           - |           - |100.208(N=1) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> depositChunk(C) -> dispute -> revealKey -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
