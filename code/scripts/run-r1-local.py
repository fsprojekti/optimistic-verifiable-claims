"""Run the R1 measurement matrix against the isolated, already-running local Anvil.

No public RPC or wallet is used. Finished evidence is never overwritten.
"""
import csv
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
from datetime import datetime, timezone

STAGE = Path(__file__).resolve().parents[2]
PROJECT = STAGE.parents[1]
CODE = STAGE / 'code'
OUT = STAGE / 'results/raw-data/r1-selection-2026-10-15'
SIZES = [4096, 4160, 4224, 5120, 6144, 8192, 16384, 32768, 65536, 131072, 'whole', 3072, 2048, 1024]

def now():
    return datetime.now(timezone.utc).isoformat()

def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    source_paths = sorted((CODE / 'contracts').glob('*.sol')) + [
        CODE / 'hardhat.config.js', CODE / 'tests/pilot/r1-chunk-selection.js',
        Path(__file__), CODE / 'tests/lib/chacha20.js', CODE / 'tests/lib/segmented-commitment.js',
        CODE / 'tests/lib/gcode-reference.js', CODE / 'tests/lib/access-envelope.js']
    hashes = {p.relative_to(STAGE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths}
    manifest_path = OUT / 'campaign.json'
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['source_sha256'] != hashes:
            raise RuntimeError('Source changed since campaign start')
    else:
        build_info = []
        for p in sorted((CODE / 'artifacts/build-info').glob('*.json')):
            data = json.loads(p.read_text(encoding='utf-8'))
            build_info.append({'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                               'solc_version': data['solcVersion'], 'settings': data['input']['settings']})
        manifest = {'started_at': now(), 'status': 'running', 'source_sha256': hashes,
                    'build_info': build_info, 'candidate_chunk_bytes': SIZES,
                    'reference_budget': 16777216, 'fill_factor': 0.95,
                    'boundary_grid_bytes': 64, 'cases': {}}
        save(manifest_path, manifest)
    for size in SIZES:
        name = 'whole-file' if size == 'whole' else f'chunk-{size}'
        directory = OUT / name
        result = directory / 'r1-chunk-selection-predicates.csv'
        metadata_path = directory / 'run-metadata.json'
        if result.exists() and metadata_path.exists():
            meta = json.loads(metadata_path.read_text())
            rows = list(csv.DictReader(result.open()))
            if meta.get('completed_at') and len(rows) == 12 and all(r['outcome'] == 'Valid' for r in rows):
                manifest['cases'][name] = {'status': 'complete', 'completed_at': meta['completed_at'], 'receipts': meta['successful_receipts']}
                save(manifest_path, manifest)
                print(f'{now()} {name}: verified existing complete case', flush=True)
                continue
        if (directory / 'receipts.jsonl').exists():
            raise RuntimeError(f'Incomplete evidence in {directory}; preserve and inspect before retry')
        directory.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env.update(OVC_R1_ENABLED='1', LOCALHOST_RPC_URL='http://127.0.0.1:19545',
                   OVC_CORPUS_ROOT=str(PROJECT / '_local-tools/ovc-d5-canonical-corpus'),
                   OVC_PILOT_FILES='3', OVC_PILOT_CHUNK_BYTES=str(size if size != 'whole' else 4096),
                   OVC_R1_WHOLE_FILE='1' if size == 'whole' else '0',
                   OVC_PILOT_OUTPUT_SUBDIR=f'r1-selection-2026-10-15/{name}')
        manifest['cases'][name] = {'status': 'running', 'started_at': now()}
        save(manifest_path, manifest)
        print(f'{now()} START {name}', flush=True)
        with (directory / 'runner.log').open('w', encoding='utf-8') as log:
            proc = subprocess.Popen(['node', 'node_modules/hardhat/internal/cli/cli.js', 'test',
                                     'tests/pilot/r1-chunk-selection.js', '--network', 'localhost', '--no-compile'],
                                    cwd=CODE, env=env, stdout=log, stderr=subprocess.STDOUT)
            while proc.poll() is None:
                time.sleep(10)
                receipt_file = directory / 'receipts.jsonl'
                if receipt_file.exists():
                    lines = receipt_file.read_text().splitlines()
                    if lines:
                        last = json.loads(lines[-1])
                        print(f'{now()} {name}: {len(lines)} receipts; {last["slicer"]} {last["operation"]} {last["chunk_index"]}', flush=True)
        if proc.returncode != 0 or not result.exists():
            manifest['cases'][name].update(status='failed', exit_code=proc.returncode)
            save(manifest_path, manifest)
            raise RuntimeError(f'{name} failed; see {directory / "runner.log"}')
        rows = list(csv.DictReader(result.open()))
        assert len(rows) == 12 and all(r['outcome'] == 'Valid' for r in rows)
        meta = json.loads(metadata_path.read_text())
        manifest['cases'][name].update(status='complete', completed_at=meta['completed_at'], receipts=meta['successful_receipts'])
        save(manifest_path, manifest)
        print(f'{now()} COMPLETE {name}: 12 Valid outcomes', flush=True)
    assert hashes == {p.relative_to(STAGE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest() for p in source_paths}
    manifest.update(status='complete', completed_at=now())
    save(manifest_path, manifest)
    print('R1 measurement matrix complete.', flush=True)

if __name__ == '__main__':
    main()
