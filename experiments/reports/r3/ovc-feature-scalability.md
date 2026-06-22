# R3-F Monolithic Summary

Source script: tests\r3\ovc-feature-scalability.js

```text

===============================================================================================
R3-F Monolithic — OVC-Feature single-tx adjudication | Node: localhost
===============================================================================================
| G-code size | revealWitness gas    | gas/byte | Status |
|-------------|----------------------|----------|--------|
| 1 KB        |              572.742 |   559.32 | OK     |
| 4 KB        |            2.184.594 |   533.35 | OK     |
| 16 KB       |            8.621.816 |   526.23 | OK     |
| 64 KB       |           34.387.008 |   524.70 | OK     |
| 256 KB      |          137.545.209 |   524.69 | OK     |
| 512 KB      |          275.318.853 |   525.13 | OK     |
| 1 MB        |          551.647.300 |   526.09 | OK     |
| 5 MB        |        2.800.034.158 |   534.06 | OK     |
| 10 MB       |        5.704.892.207 |   544.06 | OK     |
| 25 MB       |       15.048.606.693 |   574.06 | OK     |
| 50 MB       |       32.718.619.665 |   624.06 | OK     |
===============================================================================================
Monolithic baseline: entire G-code submitted in a single revealWitness tx.
Compare diagonal (N=1) of R3-F segmented matrix for segmentation overhead.
===============================================================================================
```
