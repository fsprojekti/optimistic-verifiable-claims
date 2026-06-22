# R3-I Monolithic Summary

Source script: tests\r3\ovc-identity-scalability.js

```text

==========================================================================================
R3-I Monolithic — OVC-Identity single-tx adjudication | Node: localhost
==========================================================================================
| G-code size | revealWitness gas    | gas/byte | Status |
|-------------|----------------------|----------|--------|
| 1 KB        |            1.428.918 |  1395.43 | OK     |
| 4 KB        |            5.595.443 |  1366.07 | OK     |
| 16 KB       |           22.262.981 |  1358.82 | OK     |
| 64 KB       |           88.956.173 |  1357.36 | OK     |
| 256 KB      |          356.097.581 |  1358.40 | OK     |
| 512 KB      |          713.203.629 |  1360.33 | OK     |
| 1 MB        |        1.430.561.453 |  1364.29 | OK     |
| 5 MB        |        7.320.418.989 |  1396.26 | OK     |
| 10 MB       |       15.060.228.281 |  1436.26 | OK     |
| 25 MB       |       40.796.238.521 |  1556.25 | OK     |
| 50 MB       |       92.078.196.921 |  1756.25 | OK     |
==========================================================================================
Monolithic baseline: C uploaded and adjudicated in single transactions.
Compare diagonal (N=1) of R3-I segmented matrix for segmentation overhead.
==========================================================================================
```
