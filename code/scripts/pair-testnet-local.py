"""Pair every public-testnet receipt with its local Anvil counterpart and report gas ratios.

Usage:
  python code/scripts/pair-testnet-local.py <testnet transactions.csv> [<local transactions.csv> ...]

Pairs on (artifact, operation, chunk index). The local files default to the R1 sweep run at
the testnet's chunk size. Output: per-operation gas ratio (testnet / local), JSON next to the
testnet CSV (gas-pairing.json).
"""
import csv
import json
import sys
from collections import defaultdict
from pathlib import Path

STAGE = Path(__file__).resolve().parents[2]
SWEEP = STAGE / 'results/raw-data/r1-chunk-sweep-2026-10-22'


def rel(p):
    try:
        return p.resolve().relative_to(STAGE).as_posix()
    except ValueError:
        return str(p)


def rows(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def main():
    public_path = Path(sys.argv[1])
    public = [r for r in rows(public_path) if r['artifact_key'] != 'setup']
    chunk = public[0]['chunk_size_bytes']
    local_paths = [Path(p) for p in sys.argv[2:]] or [SWEEP / f'chunk-{chunk}/corpus-ladder-transactions.csv']
    local = {}
    for p in local_paths:
        for r in rows(p):
            if r['artifact_key'] != 'setup' and r['chunk_size_bytes'] == chunk:
                local[(r['artifact_key'], r['operation'], r['chunk_index'])] = int(r['gas_used'])
    by_op = defaultdict(lambda: [0, 0, 0, None, None])  # public gas, local gas, n, min ratio, max ratio
    unpaired = []
    for r in public:
        k = (r['artifact_key'], r['operation'], r['chunk_index'])
        if k not in local:
            unpaired.append(k)
            continue
        g, l = int(r['gas_used']), local[k]
        s = by_op[r['operation']]
        s[0] += g
        s[1] += l
        s[2] += 1
        ratio = g / l
        s[3] = ratio if s[3] is None else min(s[3], ratio)
        s[4] = ratio if s[4] is None else max(s[4], ratio)
    out = {'testnet_csv': rel(public_path), 'local_csv': [rel(p) for p in local_paths],
           'chunk_size_bytes': int(chunk), 'paired': sum(s[2] for s in by_op.values()), 'unpaired': len(unpaired),
           'operations': {op: {'transactions': s[2], 'public_gas': s[0], 'local_gas': s[1], 'ratio': s[0] / s[1],
                               'min_ratio': s[3], 'max_ratio': s[4]} for op, s in by_op.items()}}
    (public_path.parent / 'gas-pairing.json').write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    print(f"{out['paired']} paired, {out['unpaired']} unpaired; chunk {chunk}")
    for op, s in out['operations'].items():
        print(f"{op:32s} n={s['transactions']:4d} ratio {s['ratio']:.5f} [{s['min_ratio']:.5f}, {s['max_ratio']:.5f}]")
    if unpaired:
        print('first unpaired:', unpaired[:5])


if __name__ == '__main__':
    main()
