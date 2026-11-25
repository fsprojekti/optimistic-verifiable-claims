# D7 — OVC-Conformance checks a machine profile, not a marker

**Date:** 25 November 2026. **Status:** implemented and tested in Stage 08 (owner decision of
25 November 2026, after the *Computers in Industry* desk rejection; height bound added at the
owner's request).

## Defect

The Stage 05–07 Conformance predicate accepted a file as soon as any chunk contained the bytes
`G0` or `G1`. It ignored the grammar, accepted a marker inside a comment, and said nothing a
Provider could price. The CiI handling editor named it: the checks were "selected markers rather
than the complete grammar", and the study did not show that they "resist strategically
misleading but predicate-compliant designs".

## Change

The claim is now: *G is a program for machine profile M, prints within the declared material
window, and deposits no material above the declared height H.*

- **Machine profile M** (travel envelope; command list, each command with numeric words or free
  text). Registered once by anyone under the hash of its contents; shared by all Demands that
  target the machine.
- **Declaration D** = (M, H, nozzle window, bed window). Made by the Consumer for the plaintext
  commitment hG before bidding, and immutable. Adjudication looks it up by (claimant, hG); an
  undeclared claim cannot start adjudication and resolves as Withheld.

The predicate accepts iff (1) every line parses under the line grammar, (2) every command is in
M, (3) every motion endpoint and every arc lies in M's envelope (arcs exactly, with integer
cross products and squares and no trigonometry), (4) every extruding move starts and ends at
Z ≤ H, (5) no nozzle/bed setpoint exceeds the declared maximum and the highest reaches the
declared minimum, (6) at least one move extrudes. The grammar and machine model are stated in
`code/tests/lib/conformance-reference.js`. The contract mirrors it step for step.

Demand, BindingPhase and the other three instances are unchanged. The declaration lives in the
Conformance contract, so posting and binding keep their measured gas.

## Design choices

- **Peak rule for temperatures, not a per-extrusion rule.** Six of the 20 Cura files
  (including the measured hinge, distal shell, Benchy, autodesk and wrench outputs) set the
  nozzle to 9.9–21.9 °C during the print and keep extruding. Cura lowers the target ahead of time
  and relies on thermal inertia. A rule that every extrusion happens at a setpoint inside the
  window rejects these genuine files (634–19,089 extrusions each). The peak rule still rejects
  "declared PLA, printed at 280 °C" and "declared PETG, printed at 215 °C". The per-extrusion
  count is kept as a diagnostic in T8.
- **Height counts every extruding move, priming included.** Cura's stock start G-code primes
  at Z = 15 mm, so a Cura file of a 10 mm part declares H ≥ 15 mm (hinge: Cura 15, Orca/Prusa 10).
- **Envelope.** Taken from the slicers' printer definition (bed 0–360 × 0–360, height 360). Y is
  extended to −10 mm because the stock XL start G-code draws its purge line at Y = −8.
- **Exact arcs instead of full circles.** A full-circle test rejected all 40 Orca and Prusa
  files, because arc fitting emits near-straight arcs with radii above 200 mm.
- **No `viaIR`.** Compiler settings are unchanged, so every other contract keeps identical
  executable bytecode (T0).

## Not covered

Print time, infill and wall settings, and the physical result. The claim covers the commands,
not the thermal state they produce. The free-text commands (M115, M486, M862.3) and the
commands without semantics in the model (for example M142, the heat-break setpoint) are
accepted when M lists them.

## Consequences

The Conformance sweep now parses every byte. Probe on the hinge outputs: 1.20× the Feature
sweep, at most 8.4 M gas per transaction at 4,160 B and 16.0 M at 8,000 B. Identity therefore
still sets c* on Ethereum and Arbitrum, and the deposit still sets it on MegaETH, so c* is
unchanged. Only the Conformance dispute is re-measured (T9–T11). The contested service costs
more than in Stage 07.
