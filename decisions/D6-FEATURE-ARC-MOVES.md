# D6 — OVC-Feature counts arc moves (G2/G3)

**Date:** 22 October 2026. **Status:** implemented and tested in Stage 05.

## Defect

The Feature machine model (on-chain `OVCFeatureSegmented._processLine`, `OVCBase._feedLine` and
the off-chain reference `tests/lib/gcode-reference.js`) accumulated extrusion only on G0/G1.
OrcaSlicer 2.4.2 and PrusaSlicer 2.9.6 corpus outputs use arc fitting and extrude on G2/G3.
Because $f_{claim}$ was computed with the same model, disputes returned Valid while omitting
a large share of the commanded extrusion. Cura outputs contain no arcs.

Corpus Benchy (sum of E increments; slicer header `filament used [mm]`):

| Slicer | G0/G1 only | G2/G3 | G0–G3 | Header |
|---|---|---|---|---|
| Orca | 3,514.58 | 2,755.73 | 6,270.31 | 6,271.11 |
| Prusa | 3,739.73 | 1,362.51 | 5,102.24 | 5,103.04 |

All selected Orca and Prusa ladder files contain G2/G3 commands (175 to 530,374 per file).
Stage 04 measurements on `rackstack_hinge` (Orca 175, Prusa 240 arcs) used the defective model.

## Change

Motion codes 0–3 extrude; G92 re-datums; all other G codes are ignored. Applied identically in
both contracts and the reference. New test `tests/feature-arcs.test.js`: arc-containing G-code
split across 16-byte chunks returns Valid for the G0–G3 total and Incorrect for the G0/G1-only total.
Full suite: 55 passing.

## Consequences

Only `OVCFeatureSegmented` executable code changes; `BindingPhase` and `OVCAccess` differ only in
compiler metadata (identical code excluding the CBOR trailer). Access and Identity evidence from
Stage 04 therefore remains valid. All Feature measurements are re-run in Stage 05 with the
corrected model: the R1 chunk sweep (`r1-chunk-sweep-2026-10-22`) and the corpus ladder.
