"""Export the transaction journals of a public-testnet run to one CSV.

Usage:
  python code/scripts/export-testnet-journals.py <run directory> [...]

The journals (consumer.journal.json, provider.journal.json) are the authoritative record:
every operation is signed into them before broadcast and completed with its receipt. The
export lists every confirmed operation once, across all launches of the run, in submission
order. Output: <run directory>/journal-transactions.csv
"""
import csv
import json
import re
import sys
from datetime import datetime
from pathlib import Path

STAGE = Path(__file__).resolve().parents[2]
MANIFEST = STAGE / 'data/corpus/generated/gcode-manifest.csv'
HEADERS = ['network', 'artifact_key', 'size_bytes', 'chunk_size_bytes', 'chunk_index', 'operation', 'signer',
           'gas_limit', 'gas_used', 'fee_wei', 'tx_hash', 'block_number', 'nonce', 'submitted_at_utc',
           'receipt_at_utc', 'submission_to_receipt_ms', 'status', 'poll_ms']
# Client-side preparation phases (instrumented runs from 30 October 2026; empty before).
PHASES = ['estimate', 'nonce', 'populate', 'balance', 'sign', 'save', 'broadcast']
HEADERS += [f'{p}_ms' for p in PHASES]
OP = re.compile(r'^(?P<key>[^/]+:[^/]+)/(?P<op>[A-Za-z]+)(?:\[(?P<i>\d+)\])?$')


def ms(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp() * 1000


def export(run):
    state = json.loads((run / 'run-state.json').read_text(encoding='utf-8'))
    with MANIFEST.open(newline='', encoding='utf-8-sig') as f:
        sizes = {f"{r['model_id']}:{r['slicer']}": r['size_bytes'] for r in csv.DictReader(f)}
    rows = []
    for signer in ('consumer', 'provider'):
        journal = json.loads((run / f'{signer}.journal.json').read_text(encoding='utf-8'))
        for name, e in journal['operations'].items():
            if e.get('status') != 1:
                continue  # signed but not (yet) confirmed
            m = OP.match(name)
            key, op, index = (m['key'], m['op'], m['i'] or '') if m else ('setup', name, '')
            rows.append({'network': state['network'], 'artifact_key': key, 'size_bytes': sizes.get(key, ''),
                         'chunk_size_bytes': state['chunk_bytes'], 'chunk_index': index, 'operation': op,
                         'signer': signer, 'gas_limit': e['gas_limit'], 'gas_used': e['gas_used'],
                         'fee_wei': e.get('fee_wei', ''), 'tx_hash': e['hash'], 'block_number': e['block_number'],
                         'nonce': e['nonce'], 'submitted_at_utc': e['submitted_at_utc'],
                         'receipt_at_utc': e['receipt_at_utc'],
                         'submission_to_receipt_ms': round(ms(e['receipt_at_utc']) - ms(e['submitted_at_utc'])),
                         'status': 1, 'poll_ms': e.get('poll_ms', 2000),
                         **{f'{p}_ms': (e.get('phases_ms') or {}).get(p, '') for p in PHASES}})
    rows.sort(key=lambda r: ms(r['submitted_at_utc']))
    assert len({r['tx_hash'] for r in rows}) == len(rows)
    with (run / 'journal-transactions.csv').open('w', newline='', encoding='utf-8') as f:
        w = csv.DictWriter(f, HEADERS)
        w.writeheader()
        w.writerows(rows)
    done = {k: v.get('outcome') for k, v in state.get('artifacts', {}).items()}
    print(f"{run.name}: {len(rows)} confirmed transactions; artifacts {done}")


if __name__ == '__main__':
    for arg in sys.argv[1:]:
        export(Path(arg))
