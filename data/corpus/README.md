# OpenGCode MultiSlicer Corpus

**Canonical dataset name:** OpenGCode MultiSlicer Corpus

**Public repository:** <https://github.com/fsprojekti/opengcode-multislicer-corpus>

**Frozen public release:** <https://github.com/fsprojekti/opengcode-multislicer-corpus/releases/tag/v1.0.0>

**Release archive SHA-256:** `3b2cd14c13f765638bb59e4d8f4c9dac31abd6bd03b37d0f249b8971e2747a0a`

This directory contains the source models, provenance records, and generated Research Stage 02
dataset. The empirical corpus contains genuine, unmodified ASCII G-code emitted by
frozen slicer versions. The G-code files are generated from these archived meshes; they are not
hand-written, padded, concatenated, or altered after slicing.

## Corpus design

The frozen design is a paired `20 geometries x 3 slicers = 60 G-code files` matrix. No geometry
contributes more than three files. The sources deliberately combine:

- four benchmarks and fit/tolerance artifacts;
- four functional mechanical parts;
- four enclosures or structural components;
- four curved links or ergonomic shells; and
- four parts with compliant, multipart, vented, or complex internal features.

Each stratum contains four distinct source geometries. Slicer outputs from the same geometry are
paired repeated measurements, not additional independent models.

The frozen slicers are PrusaSlicer 2.9.6, UltiMaker Cura 5.13.0, and OrcaSlicer 2.4.2. All use a common virtual
Original Prusa XL single-tool definition, stock 0.4 mm nozzle, generic 1.75 mm PLA, and 0.10 mm
nominal layers. Infill densities of 10%, 20%, 40%, and 80% are balanced within every geometry
stratum and held constant for a given geometry across slicers. The common profile uses gyroid infill,
two walls, 0.8 mm top/bottom shells, and build-plate-only supports at a 50-degree threshold.
`slicing-plan.csv` freezes the model-level assignments. Executable hashes and resolved configurations
are recorded under `generated/`. A file entered the generated corpus only after its slicer metadata,
source hash, output hash, size, and command statistics were recorded. Independent commanded-extrusion
reference values will be added during the parser-oracle experiment; they are not inferred from slicer
header comments.

All 60 files must be generated through a version-controlled PowerShell workflow that invokes the
three slicer command-line executables directly. The workflow supplies repository-local printer,
process, and filament configurations explicitly and cannot depend on GUI clicks or hidden user-profile
presets. GUI-only operation disqualifies a slicer from the final matrix.

## Directory policy

- `source-models/` contains byte-preserved upstream meshes with descriptive local filenames.
- `licenses/` contains upstream license texts where a repository license applies.
- `ATTRIBUTION.md` records required credit and public-domain acknowledgements.
- `source-models.csv` records the exact upstream source, revision, license, and SHA-256 hash.
- `slicing-plan.csv` records each model's predeclared infill assignment and within-stratum coverage rank.
- `generated/gcode/` contains the 60 untouched slicer outputs.
- `generated/gcode-manifest.csv` records per-file hashes, sizes, structure counts, and generation times.
- `generated/toolchain-observed.csv` records the observed slicer versions and executable hashes.
- `generated/resolved-profiles/` contains the complete PrusaSlicer and OrcaSlicer configurations used.
- `../../code/slicing/` contains the headless generator, frozen profile overrides, and corpus tests.

The source meshes are inputs, not empirical observations. The emitted G-code files are the real
manufacturing artifacts evaluated by OVC.

## Acceptance checks completed

All twenty meshes load in PrusaSlicer 2.9.6 and are manifold according to its mesh inspection.
The archived models require no mesh repair or unit correction. Connected-part counts, dimensions,
byte sizes, and SHA-256 hashes are recorded in `source-models.csv`.

The full headless run generated 60 non-empty ASCII G-code files: 20 each from PrusaSlicer,
CuraEngine, and OrcaSlicer. The corpus contains 1,661,638,853 bytes (1.548 GiB), 54,365,352 lines,
38,647,145 motion commands, and 33,612,248 extrusion-motion commands. File sizes range from
264,386 to 260,511,001 bytes. The observed bands are 3 files below 1 MiB, 22 from 1 MiB to below
10 MiB, and 35 at or above 10 MiB; 20 files use `M82` and 40 use `M83`.

The independent publication check completed on 5 August 2026 with **671 passed and 0 failed**.
It rechecked model provenance, licenses, frozen assignments, executable hashes, ASCII encoding,
motion and extrusion structure, expected filenames, manifest statistics, and every output SHA-256.
One Cura log contains the engine diagnostic `Reversing even wall line...`; Cura returned success and
the resulting enclosure artifact passed every structural, size, and hash check. The diagnostic is
retained verbatim rather than suppressed.

## Sources

- NIST Additive Manufacturing Test Artifact:
  <https://www.nist.gov/el/intelligent-systems-division-73500/production-systems-group/nist-additive-manufacturing-test>
- Autodesk/Kickstarter FDM Printer Assessment:
  <https://github.com/kickstarter/kickstarter-autodesk-3d>
- 3DBenchy file and CC0 record:
  <https://commons.wikimedia.org/wiki/File:3DBenchy.stl>
- NASA ISS printable wrench and public-domain record:
  <https://commons.wikimedia.org/wiki/File:NASA_wrench.stl>
- CC0 OpenSCAD electronics enclosure:
  <https://github.com/astromikemerri/OpenSCAD-Enclosure>
- Apache-2.0 AlohaMini robot hardware:
  <https://github.com/liyiteng/AlohaMini>
- MIT-licensed rackstack printable rack system:
  <https://github.com/jazwa/rackstack>
- CC BY 4.0 Amazing Hand mechanical models:
  <https://github.com/pollen-robotics/AmazingHand>
- MIT-licensed BCN3D Moveo robotic arm:
  <https://github.com/BCN3D/BCN3D-Moveo>
- Apache-2.0 SO-ARM100 models:
  <https://github.com/TheRobotStudio/SO-ARM100>
