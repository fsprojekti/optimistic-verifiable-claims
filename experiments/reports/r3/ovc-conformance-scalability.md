# R3-C Monolithic Summary

Source script: r3\ovc-conformance-scalability.js

```text

==========================================================================================
R3-C Monolithic — OVC-Conformance single-tx adjudication | Node: localhost
==========================================================================================
| G-code size | revealWitness gas    | gas/byte | Status |
|-------------|----------------------|----------|--------|
| 1 KB        |              518.576 |   506.42 | OK     |
| 4 KB        |            1.963.600 |   479.39 | OK     |
| 16 KB       |            7.744.056 |   472.66 | OK     |
| 64 KB       |           30.871.638 |   471.06 | OK     |
| 256 KB      |          123.474.126 |   471.02 | OK     |
| 512 KB      |          247.173.486 |   471.45 | OK     |
| 1 MB        |          495.358.638 |   472.41 | OK     |
| 5 MB        |        2.518.588.590 |   480.38 | OK     |
| 10 MB       |        5.141.997.870 |   490.38 | OK     |
| 25 MB       |       13.641.371.322 |   520.38 | OK     |
| 50 MB       |       29.904.145.722 |   570.38 | OK     |
==========================================================================================
Monolithic baseline: entire G-code submitted in a single revealWitness tx.
Compare diagonal (N=1) of R3-C segmented matrix for segmentation overhead.
==========================================================================================
```
