# Focused 128 KB chunk measurement.
#
# Measures ONLY the 128 KB chunk for R1 binding + R3 adjudication (all three
# G-code instances). Outputs go to *-128 subdirs so the existing full-spectrum
# CSVs and reports are preserved — nothing is overwritten.
#
# Prerequisite: Anvil running on localhost:8545 (start once in WSL):
#   anvil --host 0.0.0.0 --port 8545 --gas-limit 300000000000 --no-request-size-limit
#
# Run from the project root:
#   powershell -ExecutionPolicy Bypass -File tests/run-128.ps1
#
# After it finishes, read the "128 KB" gas values from the console (or from
# experiments/reports/r1-128 and experiments/reports/r3-128) and add the 128 KB
# row to RESULTS.md and the R4 tables in README.md.

$ErrorActionPreference = 'Continue'

# Always run from the project root (parent of this script's tests/ folder), so the
# tests/... paths resolve and Hardhat finds hardhat.config.js regardless of CWD.
Set-Location (Split-Path $PSScriptRoot -Parent)

$env:NODE_OPTIONS = '--max-old-space-size=16384'

# Single chunk = 128 KB. Minimal G-code spectrum (1 MB) keeps the derived
# matrix tiny — we only need the per-chunk gas, not the full matrix.
$env:R1_CHUNK_SPECTRUM_KB = '128'
$env:R1_GCODE_SPECTRUM_KB = '1024'
$env:R3_CHUNK_SPECTRUM_KB = '128'
$env:R3_GCODE_SPECTRUM_KB = '1024'

Write-Host "`n=== R1 binding - 128 KB depositChunk ===" -ForegroundColor Cyan
$env:OVC_OUTPUT_SUBDIR = 'r1-128'
npx hardhat test tests/r1/ovc-identity-binding-scalability.js --network localhost

Write-Host "`n=== R3 identity - 128 KB processChunk ===" -ForegroundColor Cyan
$env:OVC_OUTPUT_SUBDIR = 'r3-128'
npx hardhat test tests/r3/ovc-identity-scalability-segmented.js --network localhost

Write-Host "`n=== R3 conformance - 128 KB processChunk ===" -ForegroundColor Cyan
npx hardhat test tests/r3/ovc-conformance-scalability-segmented.js --network localhost

Write-Host "`n=== R3 feature - 128 KB processChunk ===" -ForegroundColor Cyan
npx hardhat test tests/r3/ovc-feature-scalability-segmented.js --network localhost

Write-Host "`nDone. 128 KB results written to:" -ForegroundColor Green
Write-Host "  experiments/reports/r1-128/   (binding depositChunk gas)"
Write-Host "  experiments/reports/r3-128/   (adjudication processChunk gas)"
Write-Host "  experiments/raw-data/r1-128/ and r3-128/   (raw CSVs)"
