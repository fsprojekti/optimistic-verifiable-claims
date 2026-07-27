# R2 Summary

Source script: tests\r2\ovcGas.test.js

```text

========================================================
R2 — Optimistic path: Provider acceptClaim gas
========================================================
| Instance         | acceptClaim  |
|------------------|--------------|
| OVC-Access       |        30791 |
| OVC-Identity     |        45008 |
| OVC-Conformance  |        30956 |
| OVC-Feature      |        30978 |
========================================================
All values are O(1) — independent of G-code size.
Consumer commitClaim cost is covered in R1.
========================================================
```
