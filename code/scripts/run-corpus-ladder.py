"""Run a Stage 05 local measurement campaign with a fresh Anvil instance per case.

Usage:
  python scripts/run-corpus-ladder.py <campaign>

Campaigns are defined in CAMPAIGNS below. Each case executes the complete four-claim
path of tests/pilot/corpus-ladder.js for its artifacts at one chunk size. Every receipt
is re-fetched from the node and archived before it stops. Completed cases are verified
and skipped on restart; incomplete evidence is never overwritten. No public RPC is used.
"""
import csv
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

STAGE = Path(__file__).resolve().parents[2]
CODE = STAGE / 'code'
RAW = STAGE / 'results/raw-data'
ANVIL = Path(os.environ['USERPROFILE']) / '.foundry/bin/anvil.exe'
PORT = 19545
DRIVER = 'tests/pilot/corpus-ladder.js'
HINGE = ['rackstack_hinge:cura', 'rackstack_hinge:orca', 'rackstack_hinge:prusa']
LADDER = [
    'electronics_enclosure:cura', 'electronics_enclosure:orca', 'electronics_enclosure:prusa',
    'amazing_distal_shell:cura', 'amazing_distal_shell:orca', 'amazing_distal_shell:prusa',
    'benchy:cura', 'benchy:orca', 'benchy:prusa',
    'autodesk_fdm:cura', 'autodesk_fdm:orca', 'autodesk_fdm:prusa',
    'aloha_under_arm:cura', 'moveo_articulation:orca', 'nasa_wrench:prusa',
]


def ladder_cases(chunks):
    return [{'name': f'chunk-{z}/{key.replace(":", "-")}', 'chunk': z, 'artifacts': [key]}
            for z in chunks for key in LADDER]


# R1 sweep: the Stage 04 grid plus 64-byte brackets around the Arbitrum One (0.95 x 32 M) and
# opBNB (0.95 x 100 M) boundaries, and one whole-file chunk per artifact. Chain operating chunks
# c* are derived from it before the ladder runs (Ethereum: 0.95 x 2^24, EIP-7825).
R1_SIZES = [1024, 2048, 3072, 4096, 4160, 4224, 5120, 6144, 7936, 8000, 8064, 8192,
            16384, 24896, 24960, 25024, 32768, 65536, 131072, 'whole']
CAMPAIGNS = {
    'r1-chunk-sweep-2026-10-22': [
        {'name': 'whole-file' if z == 'whole' else f'chunk-{z}', 'chunk': z, 'artifacts': HINGE}
        for z in R1_SIZES],
    'corpus-ladder-2026-10-22': ladder_cases(json.loads(os.environ.get('OVC_LADDER_CHUNKS', '[]'))),
    # R3: undisputed path (binding followed by the Provider's acceptance) across size classes.
    'r3-accept-2026-10-22': [
        {'name': key.replace(':', '-'), 'chunk': 24960, 'artifacts': [key]}
        for key in HINGE + LADDER[:6]],
    # R1 monolithic profile: every process as one whole-artifact transaction.
    'monolithic-ladder-2026-10-22': [
        {'name': key.replace(':', '-'), 'chunk': 'whole', 'artifacts': [key]} for key in LADDER],
    # Remainder of the corpus ladder after 28 per-transaction-block cases: the same cases with
    # batched sweeps (validated per transaction against chunk-24960/benchy-cura).
    'corpus-ladder-batched-2026-10-26': [
        {'name': 'chunk-8000/nasa_wrench-prusa', 'chunk': 8000, 'artifacts': ['nasa_wrench:prusa']}]
        + ladder_cases([4160]),
    # MegaETH replaces opBNB: 64-byte brackets around its compute boundary (0.95 x 200 M gas),
    # then the corpus ladder at the operating chunk (batched sweeps). The binding limit is the
    # deposit's, measured on the network (probe-megaeth-chunk.js): 31,872 B.
    'r1-megaeth-bracket-2026-10-29': [
        {'name': f'chunk-{z}', 'chunk': z, 'artifacts': HINGE} for z in range(49536, 49985, 64)],
    'r1-megaeth-chunk-2026-10-29': [{'name': 'chunk-31872', 'chunk': 31872, 'artifacts': HINGE}],
    'corpus-ladder-megaeth-2026-10-29': ladder_cases(json.loads(os.environ.get('OVC_LADDER_CHUNKS', '[]'))),
}

BATCHED = 'tests/pilot/corpus-ladder-batched.js'
# Campaign-specific settings; defaults reproduce the R1 sweep and the corpus ladder.
SETTINGS = {
    'r3-accept-2026-10-22': {'outcome': 'Accepted', 'env': {'OVC_ACCEPT_PATH': '1'}},
    'monolithic-ladder-2026-10-22': {'block_gas_limit': 2_000_000_000_000,
                                     'node_flags': ['--no-request-size-limit'],
                                     'env': {'OVC_KERNEL_GAS_LIMIT': '1900000000000'}},
    'corpus-ladder-batched-2026-10-26': {'driver': BATCHED, 'block_gas_limit': 1_000_000_000_000,
                                         'env': {'OVC_BATCH': '100'}},
    'corpus-ladder-megaeth-2026-10-29': {'driver': BATCHED, 'block_gas_limit': 1_000_000_000_000,
                                         'env': {'OVC_BATCH': '100'}},
}


def now():
    return datetime.now(timezone.utc).isoformat()


def save(path, data):
    path.write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def rpc(payload):
    request = Request(f'http://127.0.0.1:{PORT}', data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json'})
    with urlopen(request, timeout=300) as reply:
        return json.load(reply)


def last_line(path):
    with path.open('rb') as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 4096))
        lines = f.read().splitlines()
    return json.loads(lines[-1]) if lines else None


def source_hashes():
    paths = sorted((CODE / 'contracts').glob('*.sol')) + [
        CODE / 'hardhat.config.js', CODE / DRIVER, CODE / BATCHED, Path(__file__),
        CODE / 'tests/lib/chacha20.js', CODE / 'tests/lib/segmented-commitment.js',
        CODE / 'tests/lib/gcode-reference.js', CODE / 'tests/lib/access-envelope.js',
        STAGE / 'data/corpus/generated/gcode-manifest.csv']
    return {p.relative_to(STAGE).as_posix(): sha256(p) for p in paths}


def start_node(block_gas_limit=10_000_000_000, extra_flags=()):
    flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
    node = subprocess.Popen([str(ANVIL), '--host', '127.0.0.1', '--port', str(PORT), '--chain-id', '31337',
                             '--hardfork', 'cancun', '--gas-limit', str(block_gas_limit), '--balance', '100000000',
                             '--prune-history', '1', '--silent', *extra_flags],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
    for _ in range(40):
        if node.poll() is not None:
            raise RuntimeError('Anvil exited; check port ownership')
        try:
            if 'anvil' in rpc({'jsonrpc': '2.0', 'id': 1, 'method': 'web3_clientVersion', 'params': []}).get('result', '').lower():
                return node
        except OSError:
            pass
        time.sleep(0.25)
    node.terminate()
    raise RuntimeError('Local node did not start')


def audit(directory, expected_outcomes, outcome='Valid', prefix='corpus-ladder'):
    with (directory / f'{prefix}-predicates.csv').open() as f:
        outcomes = list(csv.DictReader(f))
    assert len(outcomes) == expected_outcomes and all(r['outcome'] == outcome for r in outcomes)
    with (directory / f'{prefix}-transactions.csv').open() as f:
        rows = list(csv.DictReader(f))
    receipts = {}
    for offset in range(0, len(rows), 100):
        group = rows[offset:offset + 100]
        reply = rpc([{'jsonrpc': '2.0', 'id': i, 'method': 'eth_getTransactionReceipt', 'params': [r['tx_hash']]}
                     for i, r in enumerate(group)])
        for item in reply:
            row, receipt = group[item['id']], item['result']
            assert receipt['transactionHash'] == row['tx_hash'] and int(receipt['status'], 16) == 1
            assert int(receipt['gasUsed'], 16) == int(row['gas_used'])
            assert int(receipt['blockNumber'], 16) == int(row['block_number'])
            assert row['tx_hash'] not in receipts
            receipts[row['tx_hash']] = receipt
    archive = directory / 'rpc-receipts.json.gz'
    archive.write_bytes(gzip.compress(json.dumps(receipts, sort_keys=True).encode(), mtime=0))
    return len(receipts), sha256(archive)


def main():
    name = sys.argv[1]
    cases = CAMPAIGNS[name]
    settings = SETTINGS.get(name, {})
    outcome = settings.get('outcome', 'Valid')
    block_gas_limit = settings.get('block_gas_limit', 10_000_000_000)
    driver = settings.get('driver', DRIVER)
    prefix = Path(driver).stem
    assert cases, f'{name} has no cases (set OVC_LADDER_CHUNKS for the ladder)'
    out = RAW / name
    out.mkdir(parents=True, exist_ok=True)
    manifest_path = out / 'campaign.json'
    hashes = source_hashes()
    if manifest_path.exists():
        manifest = json.loads(manifest_path.read_text())
        if manifest['source_sha256'] != hashes:
            raise RuntimeError('Source changed since campaign start')
        assert [c['name'] for c in manifest['planned_cases']] == [c['name'] for c in cases], 'Case plan changed'
    else:
        build_info = []
        for p in sorted((CODE / 'artifacts/build-info').glob('*.json')):
            data = json.loads(p.read_text(encoding='utf-8'))
            build_info.append({'sha256': sha256(p), 'solc_version': data['solcVersion'],
                               'settings': data['input']['settings']})
        manifest = {'started_at': now(), 'status': 'running', 'source_sha256': hashes,
                    'build_info': build_info, 'anvil_sha256': sha256(ANVIL),
                    'node': {'client': 'Anvil 1.7.1', 'hardfork': 'cancun', 'block_gas_limit': block_gas_limit,
                             'prune_history': 1, 'fresh_instance_per_case': True},
                    'reference_budget': 16777216, 'fill_factor': 0.95,
                    'settings': settings, 'planned_cases': cases, 'cases': {}}
        save(manifest_path, manifest)

    for case in cases:
        directory = out / case['name']
        expected = 4 * len(case['artifacts'])
        audit_path = directory / 'rpc-audit.json'
        if audit_path.exists():
            manifest['cases'][case['name']]['status'] = 'complete'
            print(f'{now()} {case["name"]}: verified existing complete case', flush=True)
            continue
        if (directory / 'receipts.jsonl').exists():
            raise RuntimeError(f'Incomplete evidence in {directory}; preserve and inspect before retry')
        directory.mkdir(parents=True, exist_ok=True)
        manifest['cases'][case['name']] = {'status': 'running', 'started_at': now()}
        save(manifest_path, manifest)
        print(f'{now()} START {case["name"]} ({", ".join(case["artifacts"])})', flush=True)
        node = start_node(block_gas_limit, settings.get('node_flags', ()))
        try:
            env = os.environ.copy()
            env.update(OVC_LADDER_ENABLED='1', LOCALHOST_RPC_URL=f'http://127.0.0.1:{PORT}',
                       OVC_ARTIFACT_KEYS=','.join(case['artifacts']),
                       OVC_PILOT_CHUNK_BYTES=str(4096 if case['chunk'] == 'whole' else case['chunk']),
                       OVC_R1_WHOLE_FILE='1' if case['chunk'] == 'whole' else '0',
                       OVC_PILOT_OUTPUT_SUBDIR=f'{name}/{case["name"]}')
            env.update(settings.get('env', {}))
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            with (directory / 'runner.log').open('w', encoding='utf-8') as log:
                proc = subprocess.Popen(['node', '--max-old-space-size=8192', 'node_modules/hardhat/internal/cli/cli.js',
                                         'test', driver, '--network', 'localhost', '--no-compile'],
                                        cwd=CODE, env=env, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
                while proc.poll() is None:
                    time.sleep(30)
                    receipts = directory / 'receipts.jsonl'
                    if receipts.exists():
                        r = last_line(receipts)
                        if r:
                            print(f'{now()} {case["name"]}: {r["operation"]} {r["chunk_index"]}', flush=True)
            if proc.returncode != 0:
                manifest['cases'][case['name']].update(status='failed', exit_code=proc.returncode)
                save(manifest_path, manifest)
                raise RuntimeError(f'{case["name"]} failed; see {directory / "runner.log"}')
            count, archive_hash = audit(directory, expected, outcome, prefix)
            meta = json.loads((directory / 'run-metadata.json').read_text())
            save(audit_path, {'verified_at': now(), 'verified_receipts': count,
                              'receipt_archive_sha256': archive_hash, 'outcome': outcome, 'outcomes': expected})
            manifest['cases'][case['name']].update(status='complete', completed_at=meta['completed_at'],
                                                   receipts=count, rpc_audited=True)
            save(manifest_path, manifest)
            print(f'{now()} COMPLETE {case["name"]}: {expected} {outcome} outcomes; {count} audited receipts', flush=True)
        finally:
            node.terminate()
            node.wait(timeout=60)

    assert source_hashes() == hashes, 'Source changed during campaign'
    manifest.update(status='complete', completed_at=now())
    save(manifest_path, manifest)
    print(f'{name} complete; all receipts archived and verified.', flush=True)


if __name__ == '__main__':
    main()
