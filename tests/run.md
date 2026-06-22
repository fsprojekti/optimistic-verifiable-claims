# Anvil node

Start once in a WSL terminal before running any test:

```bash
anvil --host 0.0.0.0 --port 8545 --gas-limit 300000000000 --no-request-size-limit
```

---

# Scenario tests

Run from the **project root**.

## OVC-access

```powershell
npx hardhat test tests/scenarios/ovc-access.js --network localhost
```

## OVC-identity

```powershell
npx hardhat test tests/scenarios/ovc-identity.js --network localhost
```

## OVC-conformance

```powershell
npx hardhat test tests/scenarios/ovc-conformance.js --network localhost
```

## OVC-feature

```powershell
npx hardhat test tests/scenarios/ovc-feature.js --network localhost
```

---

# R1 — Binding phase

Run from the **project root** (16 GB heap).

## Binding phase chunk-size spectrum

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r1/ovc-identity-binding-scalability.js --network localhost
```

## Binding coordinator benchmark

```powershell
npx hardhat test tests/r1/binding-phase.js --network localhost
```

---

# R2 — Optimistic path gas

Run from the **project root** (16 GB heap).

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r2/ovcGas.test.js --network localhost
```

---

# R3 — Scalability tests

Run from the **project root** (16 GB heap).

## Monolithic baselines

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-identity-scalability.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-conformance-scalability.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-feature-scalability.js --network localhost
```

## Segmented chunk-size spectrum

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-identity-scalability-segmented.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js --network localhost
$env:NODE_OPTIONS='--max-old-space-size=16384'; npx hardhat test tests/r3/ovc-feature-scalability-segmented.js --network localhost
```

## Custom chunk/G-code spectrum (env override)

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'
$env:R3_CHUNK_SPECTRUM_KB='1,4,16,64,128,256,512,1024,5120,10240,25600,51200'
$env:R3_GCODE_SPECTRUM_KB='64,256,1024,5120,10240,25600,51200'
npx hardhat test tests/r3/ovc-identity-scalability-segmented.js --network localhost
npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js --network localhost
npx hardhat test tests/r3/ovc-feature-scalability-segmented.js --network localhost
```

For focused validation probes, set a smaller ladder:

```powershell
$env:NODE_OPTIONS='--max-old-space-size=16384'
$env:R3_CHUNK_SPECTRUM_KB='256'
$env:R3_GCODE_SPECTRUM_KB='256,1024'
npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js --network localhost
```

---

# Focused single-chunk run (128 KB)

Measures only the 128 KB chunk for R1 + all three R3 segmented instances, writing to
`*-128` output subdirs so the full-spectrum results are **not** overwritten. Use this to
fill in a missing chunk point without re-running the whole spectrum.

```powershell
powershell -ExecutionPolicy Bypass -File tests/run-128.ps1
```

Outputs: `experiments/reports/r1-128/`, `experiments/reports/r3-128/`,
`experiments/raw-data/r1-128/`, `experiments/raw-data/r3-128/`.

The runner sets `OVC_OUTPUT_SUBDIR` (output folder), `R1_CHUNK_SPECTRUM_KB` /
`R3_CHUNK_SPECTRUM_KB` = `128`, and a minimal G-code spectrum. The same env vars work
for any single-chunk probe — change `128` to another size and adjust the subdir.
