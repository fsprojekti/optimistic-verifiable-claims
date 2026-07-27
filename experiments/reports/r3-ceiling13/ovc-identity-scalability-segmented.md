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
| 13 KB      |        10.672.741 |             801.74 | eth_estimateGas |

Table R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)
| Chunk \ G-code |        64 KB |       256 KB |         1 MB |         5 MB |        10 MB |        25 MB |        50 MB |
|----------------|--------------|--------------|--------------|--------------|--------------|--------------|--------------|
| 13 KB          |  0.053(N=5) | 0.214(N=20) | 0.843(N=79) |4.205(N=394) |8.410(N=788) |21.025(N=1970) |42.040(N=3939) |

========================================================================================
Methodology: processChunk gas measured via eth_estimateGas after bidding (Demand.postDemand -> depositCiphertextChunk -> seal) then binding (commitClaim -> setDemand -> dispute -> revealKey -> startAdjudication). processChunk reads C cross-contract from the Demand. Finalize gas measured from a real tx on a 1 KB baseline claim.
========================================================================================
```
