# R3-I Summary

Source script: tests\r3\ovc-identity-scalability-segmented.js

```text

========================================================================================
R3-I — OVC-Identity adjudication chunk-size spectrum
========================================================================================
Measured O(1) adjudication overheads: revealKey=53.757 | startAdjudication=34.996 | finalizeAdjudication=39.454
C is posted to the Demand at bidding and read cross-contract. The derived matrix covers adjudication txs only: revealKey + startAdjudication + N * processChunk + finalizeAdjudication.

Table R3a-I: OVC-Identity per-process-chunk gas vs chunk size
----------------------------------------------------------------------------------------
| Chunk size | Per-process gas   | Effective gas/byte | Method          |
|------------|-------------------|--------------------|-----------------|
| 1 KB       |           919.621 |             898.07 | eth_estimateGas |
| 4 KB       |         3.356.821 |             819.54 | eth_estimateGas |
| 8 KB       |         6.607.541 |             806.58 | eth_estimateGas |
| 12 KB      |         9.859.541 |             802.37 | eth_estimateGas |
| 16 KB      |        13.112.821 |             800.34 | eth_estimateGas |
| 64 KB      |        52.252.021 |             797.30 | eth_estimateGas |
| 128 KB     |       104.724.341 |             798.98 | eth_estimateGas |
| 256 KB     |       210.652.021 |             803.57 | eth_estimateGas |
| 512 KB     |       426.439.541 |             813.37 | eth_estimateGas |
| 1 MB       |       873.743.221 |             833.27 | eth_estimateGas |
| 5 MB       |     5.207.147.381 |             993.18 | eth_estimateGas |
| 10 MB      |    12.511.339.381 |            1193.17 | eth_estimateGas |
| 25 MB      |    47.006.827.381 |            1793.17 | eth_estimateGas |
| 50 MB      |   146.442.347.381 |            2793.17 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 1 KB           | 0.059(N=64) |0.236(N=256) |0.942(N=1024) |4.709(N=5120) |9.417(N=10240) |23.542(N=25600) |47.085(N=51200) |
| 4 KB           | 0.054(N=16) | 0.215(N=64) |0.859(N=256) |4.297(N=1280) |8.594(N=2560) |21.484(N=6400) |42.967(N=12800) |
| 8 KB           |  0.053(N=8) | 0.212(N=32) |0.846(N=128) |4.229(N=640) |8.458(N=1280) |21.144(N=3200) |42.288(N=6400) |
| 12 KB          |  0.059(N=6) | 0.217(N=22) | 0.848(N=86) |4.210(N=427) |8.420(N=854) |21.040(N=2134) |42.071(N=4267) |
| 16 KB          |  0.053(N=4) | 0.210(N=16) | 0.839(N=64) |4.196(N=320) |8.392(N=640) |20.981(N=1600) |41.961(N=3200) |
| 64 KB          |  0.052(N=1) |  0.209(N=4) | 0.836(N=16) | 4.180(N=80) |8.360(N=160) |20.901(N=400) |41.802(N=800) |
| 128 KB         |           - |  0.210(N=2) |  0.838(N=8) | 4.189(N=40) | 8.378(N=80) |20.945(N=200) |41.890(N=400) |
| 256 KB         |           - |  0.211(N=1) |  0.843(N=4) | 4.213(N=20) | 8.426(N=40) |21.065(N=100) |42.131(N=200) |
| 512 KB         |           - |           - |  0.853(N=2) | 4.265(N=10) | 8.529(N=20) |21.322(N=50) |42.644(N=100) |
| 1 MB           |           - |           - |  0.874(N=1) |  4.369(N=5) | 8.738(N=10) |21.844(N=25) |43.687(N=50) |
| 5 MB           |           - |           - |           - |  5.207(N=1) | 10.414(N=2) | 26.036(N=5) |52.072(N=10) |
| 10 MB          |           - |           - |           - |           - | 12.511(N=1) | 37.534(N=3) | 62.557(N=5) |
| 25 MB          |           - |           - |           - |           - |           - | 47.007(N=1) | 94.014(N=2) |
| 50 MB          |           - |           - |           - |           - |           - |           - |146.442(N=1) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after bidding (Demand.postDemand -> depositCiphertextChunk -> seal) then binding (commitClaim -> setDemand -> dispute -> revealKey -> startAdjudication). processChunk reads C cross-contract from the Demand. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
