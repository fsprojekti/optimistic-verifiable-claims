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
| 1 KB       |         2.397.443 |            2341.25 | eth_estimateGas |
| 4 KB       |         9.225.014 |            2252.20 | eth_estimateGas |
| 16 KB      |        36.529.744 |            2229.60 | eth_estimateGas |
| 64 KB      |       145.748.509 |            2223.95 | eth_estimateGas |
| 128 KB     |       291.385.894 |            2223.10 | eth_estimateGas |
| 256 KB     |       582.709.816 |            2222.86 | eth_estimateGas |
| 512 KB     |     1.165.560.181 |            2223.13 | eth_estimateGas |
| 1 MB       |     2.332.053.006 |            2224.02 | eth_estimateGas |
| 5 MB       |    11.701.699.288 |            2231.92 | eth_estimateGas |
| 10 MB      |    23.508.134.581 |            2241.91 | eth_estimateGas |
| 25 MB      |    59.556.591.973 |            2271.90 | eth_estimateGas |
| 50 MB      |   121.734.496.438 |            2321.90 | eth_estimateGas |

Table R3b-F: Total adjudication gas - OVC-Feature (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 1 KB           | 0.154(N=64) |0.614(N=256) |2.455(N=1024) |12.275(N=5120) |24.550(N=10240) |61.375(N=25600) |122.749(N=51200) |
| 4 KB           | 0.148(N=16) | 0.590(N=64) |2.362(N=256) |11.808(N=1280) |23.616(N=2560) |59.040(N=6400) |118.080(N=12800) |
| 16 KB          |  0.146(N=4) | 0.585(N=16) | 2.338(N=64) |11.690(N=320) |23.379(N=640) |58.448(N=1600) |116.895(N=3200) |
| 64 KB          |  0.146(N=1) |  0.583(N=4) | 2.332(N=16) |11.660(N=80) |23.320(N=160) |58.299(N=400) |116.599(N=800) |
| 128 KB         |           - |  0.583(N=2) |  2.331(N=8) |11.656(N=40) |23.311(N=80) |58.277(N=200) |116.554(N=400) |
| 256 KB         |           - |  0.583(N=1) |  2.331(N=4) |11.654(N=20) |23.308(N=40) |58.271(N=100) |116.542(N=200) |
| 512 KB         |           - |           - |  2.331(N=2) |11.656(N=10) |23.311(N=20) |58.278(N=50) |116.556(N=100) |
| 1 MB           |           - |           - |  2.332(N=1) | 11.660(N=5) |23.321(N=10) |58.301(N=25) |116.603(N=50) |
| 5 MB           |           - |           - |           - | 11.702(N=1) | 23.403(N=2) | 58.509(N=5) |117.017(N=10) |
| 10 MB          |           - |           - |           - |           - | 23.508(N=1) | 70.524(N=3) |117.541(N=5) |
| 25 MB          |           - |           - |           - |           - |           - | 59.557(N=1) |119.113(N=2) |
| 50 MB          |           - |           - |           - |           - |           - |           - |121.735(N=1) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
