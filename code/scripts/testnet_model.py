"""Network gas and duration model from the public-testnet full-path campaign.

Gas. Every public receipt is paired with its local Anvil counterpart (same artifact, operation
and chunk index; same fixtures and code). The per-operation ratio public/local is then applied
to the local receipts of every corpus artifact, so a network's gas for an artifact is
sum_r gas_local(r) * ratio(net, op(r)).

Time. The protocol is strictly sequential, so its duration is the sum of per-transaction steps:
client preparation (previous receipt to next submission: estimation, signing, RPC retries) and
network time (submission to observed receipt). The steps are those of every run of the timing
campaign on the chain's public testnet (TIMING_RUNS). A duration is drawn by a two-level bootstrap:
each replicate first draws one run, which stands for the conditions of one execution (endpoint
load, time of day), then each operation's steps as blocks of consecutive transactions from that
run (from all runs pooled when the run has fewer than MIN_STEPS of them). This gives the median
and a 95% interval that cover the variation between runs as well as within one. Preparation gaps
above OUTAGE_S (relaunches after client stops) are excluded and reported. With REGULAR_ONLY, so
are the steps of transactions whose RPC calls met a transient endpoint error (a retry in the run's
log): their back-off measures the public endpoint, not the protocol or the chain.
"""
import csv
import json
import math
import re
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE / 'results/raw-data'
RUN = RAW / 'timing-revalidation-2026-11-02'
GAS_CAMPAIGN = RAW / 'testnet-fullpath-2026-10-29'
LOCAL_SWEEPS = [RAW / 'r1-chunk-sweep-2026-10-22', RAW / 'r1-megaeth-chunk-2026-10-29', RAW / 'r1-megaeth-bracket-2026-10-29']
LOCAL_CSV = 'corpus-ladder-transactions.csv'
# Deployment chain -> public testnet whose transaction steps represent it, and its timing runs
# (hinge full path, undisputed path, out-of-sample files; PROTOCOL.md in RUN).
TESTNET = {'Ethereum': 'sepolia', 'Arbitrum': 'arbitrumSepolia', 'MegaETH': 'megaethTestnet-31872'}
TIMING_RUNS = {'Ethereum': ['sepolia', 'sepolia-accept', 'sepolia-enclosure'],
               'Arbitrum': ['arbitrumSepolia', 'arbitrumSepolia-accept', 'arbitrumSepolia-enclosure'],
               'MegaETH': ['megaethTestnet-31872', 'megaethTestnet-31872-accept',
                           'megaethTestnet-31872-benchy-a', 'megaethTestnet-31872-benchy-b']}
# Deployment chain -> run whose receipts give its gas schedule. Ethereum's is a fork of mainnet
# (current rules) rather than Sepolia, which already runs the later Glamsterdam schedule.
GAS_RUN = {'Ethereum': RAW / 'mainnet-fork-2026-10-30/full-path',
           'Arbitrum': GAS_CAMPAIGN / 'arbitrumSepolia', 'MegaETH': GAS_CAMPAIGN / 'megaethTestnet-31872'}
ACCEPT_RUN = {'Ethereum': RAW / 'mainnet-fork-2026-10-30/accept',
              'Arbitrum': GAS_CAMPAIGN / 'arbitrumSepolia-accept',
              'MegaETH': GAS_CAMPAIGN / 'megaethTestnet-31872-accept'}
CHUNK_OPS = {'depositCiphertextChunk', 'processChunk', 'conformanceDepositChunk', 'conformanceProcessChunk',
             'featureDepositChunk', 'featureProcessChunk'}
OUTAGE_S = 120.0
REGULAR_ONLY = False
POLL_MS = 250
BLOCK = 10
MIN_STEPS = 2 * BLOCK
REPS = 2000
SEED = 20261029


def _rows(path):
    with open(path, newline='', encoding='utf-8') as f:
        return list(csv.DictReader(f))


def _t(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00')).timestamp()


def public_rows(chain):
    rows = [r for r in _rows(GAS_RUN[chain] / 'journal-transactions.csv') if r['artifact_key'] != 'setup']
    assert all(r['status'] == '1' for r in rows)
    return rows


def _local(chunk):
    for sweep in LOCAL_SWEEPS:
        p = sweep / f'chunk-{chunk}' / LOCAL_CSV
        if p.exists():
            return {(r['artifact_key'], r['operation'], r['chunk_index']): int(r['gas_used']) for r in _rows(p)
                    if r['artifact_key'] != 'setup'}
    raise FileNotFoundError(f'no local sweep at chunk {chunk}')


_ratios = {}


def ratios(chain):
    """Per-operation gas ratio public/local, with the per-transaction range and count."""
    if chain not in _ratios:
        pub = public_rows(chain)
        local = _local(pub[0]['chunk_size_bytes'])
        acc = defaultdict(lambda: [0, 0, 0, math.inf, 0.0])
        for r in pub:
            l = local[(r['artifact_key'], r['operation'], r['chunk_index'])]
            g = int(r['gas_used'])
            a = acc[r['operation']]
            a[0] += g
            a[1] += l
            a[2] += 1
            a[3] = min(a[3], g / l)
            a[4] = max(a[4], g / l)
        # The Provider's acceptance (R3) comes from the undisputed-path run, paired with the local
        # undisputed path of the same artifact (a fixed-size call: the chunk size does not enter).
        accept = ACCEPT_RUN[chain] / 'journal-transactions.csv'
        if accept.exists():
            for r in _rows(accept):
                if r['operation'] != 'acceptBinding':
                    continue
                model, slicer = r['artifact_key'].split(':')
                local_rows = _rows(RAW / 'r3-accept-2026-10-22' / f'{model}-{slicer}' / LOCAL_CSV)
                l = next(int(x['gas_used']) for x in local_rows if x['operation'] == 'acceptBinding')
                g = int(r['gas_used'])
                a = acc['acceptBinding']
                a[0] += g
                a[1] += l
                a[2] += 1
                a[3] = min(a[3], g / l)
                a[4] = max(a[4], g / l)
        _ratios[chain] = {op: {'ratio': a[0] / a[1], 'min': a[3], 'max': a[4], 'n': a[2], 'public_gas': a[0],
                               'local_gas': a[1]} for op, a in acc.items()}
    return _ratios[chain]


def net_gas(rows, ops, chain):
    r = ratios(chain)
    wanted = set(ops)
    return sum(int(x['gas_used']) * r[x['operation']]['ratio'] for x in rows if x['operation'] in wanted)


_steps = {}
_retried = {}


def op_key(r):
    """The runner's label of a transaction, as in its journal and log."""
    return f"{r['artifact_key']}/{r['operation']}" + (f"[{r['chunk_index']}]" if r['chunk_index'] else '')


def retried(run):
    """Labels of the run's transactions that logged a transient RPC retry (log beside the run directory)."""
    if (RUN, run) not in _retried:
        log = RUN / f'{run}.log'
        text = log.read_text(encoding='utf-8', errors='replace') if log.exists() else ''
        _retried[(RUN, run)] = set(re.findall(r'^(\S+): transient RPC error', text, re.M))
    return _retried[(RUN, run)]


def timing_runs(chain):
    """Every measured run of the chain's testnet (full path, undisputed path, out-of-sample files)."""
    return [run for run in TIMING_RUNS[chain] if (RUN / run / 'journal-transactions.csv').exists()]


def steps(chain, runs=None):
    """Measured per-transaction steps (seconds) by class, in execution order, and the outages."""
    runs = tuple(runs or timing_runs(chain))
    if (chain, runs, RUN, REGULAR_ONLY) not in _steps:
        out = {'chunk': [], 'fixed': [], 'outages': [], 'network_s': [], 'prep_s': [], 'runs': list(runs),
               'by_op': defaultdict(list), 'retried_excluded': 0,
               'per_run': {run: defaultdict(list) for run in runs}}
        pairs = []
        for run in runs:  # steps are consecutive within a run, never across runs
            rows = sorted((r for r in _rows(RUN / run / 'journal-transactions.csv') if r['artifact_key'] != 'setup'),
                          key=lambda r: _t(r['receipt_at_utc']))
            skip = retried(run) if REGULAR_ONLY else set()
            pairs += [(run, prev, r, op_key(r) in skip) for prev, r in zip(rows, rows[1:])]
        for run, prev, r, irregular in pairs:
            if irregular:
                out['retried_excluded'] += 1
                continue
            # Steps observed with the coarse 2-s receipt polling of the first launches are not timed.
            if r.get('poll_ms', '2000') != str(POLL_MS) or prev.get('poll_ms', '2000') != str(POLL_MS):
                continue
            prep = _t(r['submitted_at_utc']) - _t(prev['receipt_at_utc'])
            net = _t(r['receipt_at_utc']) - _t(r['submitted_at_utc'])
            if prep > OUTAGE_S:
                out['outages'].append({'before': f"{r['artifact_key']}/{r['operation']}[{r['chunk_index']}]",
                                       'gap_s': prep})
                prep = 0.0  # the relaunch gap is excluded; the transaction's own network time is kept
            out['prep_s'].append(prep)
            out['network_s'].append(net)
            out['chunk' if r['operation'] in CHUNK_OPS else 'fixed'].append(prep + net)
            if r['operation'] in CHUNK_OPS:  # chunk steps differ by operation (estimation of a heavy sweep)
                out['by_op'][r['operation']].append(prep + net)
            out['per_run'][run][r['operation'] if r['operation'] in CHUNK_OPS else 'fixed'].append(prep + net)
        _steps[(chain, runs, RUN, REGULAR_ONLY)] = out
    return _steps[(chain, runs, RUN, REGULAR_ONLY)]


def _block_sums(pool, n, rng, reps=REPS):
    """reps bootstrap totals of n steps drawn as blocks of BLOCK consecutive steps."""
    pool = np.asarray(pool)
    if n == 0:
        return np.zeros(reps)
    starts_max = max(1, len(pool) - BLOCK + 1)
    full, rest = divmod(n, BLOCK)
    csum = np.concatenate([[0.0], np.cumsum(pool)])
    starts = rng.integers(0, starts_max, size=(reps, full + (1 if rest else 0)))
    lengths = np.full(starts.shape, BLOCK)
    if rest:
        lengths[:, -1] = rest
    ends = np.minimum(starts + lengths, len(pool))
    return (csum[ends] - csum[starts]).sum(axis=1)


_dur = {}


def duration(chain, counts, runs=None):
    """Median and 95% interval (seconds) of a sequential run with counts[op] chunk transactions of each
    chunk operation and counts['fixed'] fixed calls; each operation is drawn from its own steps."""
    key = (chain, tuple(sorted(counts.items())), tuple(runs or ()), RUN, REGULAR_ONLY)
    if key not in _dur:
        s = steps(chain, runs)
        rng = np.random.default_rng([SEED, list(TESTNET).index(chain), *[n for _, n in key[1]]])
        names = list(s['per_run'])
        pick = rng.integers(0, len(names), size=REPS)  # the run whose conditions each replicate shares
        tot = np.zeros(REPS)
        for op, n in key[1]:
            pooled = s['fixed'] if op == 'fixed' else s['by_op'][op]
            for i, name in enumerate(names):
                chosen = pick == i
                if chosen.any():
                    own = s['per_run'][name][op]
                    tot[chosen] += _block_sums(own if len(own) >= MIN_STEPS else pooled, n, rng, int(chosen.sum()))
        _dur[key] = tuple(float(x) for x in np.percentile(tot, [50, 2.5, 97.5]))
    return _dur[key]


def rows_duration(rows, ops, chain, runs=None):
    wanted = set(ops)
    counts = defaultdict(int)
    for r in rows:
        if r['operation'] in wanted:
            counts[r['operation'] if r['operation'] in CHUNK_OPS else 'fixed'] += 1
    return duration(chain, dict(counts), runs)


def _dist(v):
    return {'n': len(v), 'mean_s': float(np.mean(v)), 'median_s': float(np.median(v)),
            'p5_s': float(np.percentile(v, 5)), 'p95_s': float(np.percentile(v, 95)), 'max_s': float(np.max(v))}


def summary():
    out = {}
    for chain, net in TESTNET.items():
        s = steps(chain)
        out[chain] = {
            'testnet': net, 'chunk_size_bytes': int(public_rows(chain)[0]['chunk_size_bytes']),
            'paired_transactions': len(public_rows(chain)),
            'ratios': ratios(chain),
            'steps': {k: {'n': len(s[k]), 'median_s': float(np.median(s[k])), 'mean_s': float(np.mean(s[k])),
                          'p95_s': float(np.percentile(s[k], 95)), 'max_s': float(np.max(s[k]))}
                      for k in ('chunk', 'fixed', 'network_s', 'prep_s') if s[k]},
            'steps_by_operation': {op: _dist(v) for op, v in sorted({**s['by_op'], 'fixed': s['fixed']}.items())},
            'steps_by_run': {run: {op: _dist(v) for op, v in sorted(d.items())} for run, d in s['per_run'].items()},
            'timing_runs': s['runs'],
            'outages_excluded': s['outages'], 'outage_threshold_s': OUTAGE_S,
            'bootstrap': {'block': BLOCK, 'reps': REPS, 'seed': SEED},
        }
    return out


# Leave-one-run-out check: each corpus-file run is predicted from the chain's other runs, for its
# own transactions (the steps measured), and compared with its measured active duration.
HOLDOUT = {'Ethereum': ['sepolia-enclosure'], 'Arbitrum': ['arbitrumSepolia-enclosure'],
           'MegaETH': ['megaethTestnet-31872-benchy-a', 'megaethTestnet-31872-benchy-b']}


def validate():
    out = []
    for chain, held in HOLDOUT.items():
        for run in held:
            if run not in timing_runs(chain):
                continue
            rows = sorted((r for r in _rows(RUN / run / 'journal-transactions.csv') if r['artifact_key'] != 'setup'),
                          key=lambda r: _t(r['receipt_at_utc']))
            measured = steps(chain, [run])
            elapsed = sum(measured['chunk']) + sum(measured['fixed'])
            others = [x for x in timing_runs(chain) if x != run]
            med, lo, hi = rows_duration(rows[1:], sorted({r['operation'] for r in rows}), chain, runs=others)
            out.append({'chain': chain, 'run': run, 'model_runs': others, 'steps': len(rows) - 1,
                        'measured_active_s': elapsed, 'outages_excluded_s': [g['gap_s'] for g in measured['outages']],
                        'predicted_median_s': med, 'predicted_95_s': [lo, hi],
                        'time_error_percent': 100 * (med - elapsed) / elapsed, 'in_interval': lo <= elapsed <= hi})
    return out


if __name__ == '__main__':
    out = summary()
    out['validation'] = validate()
    dest = STAGE / 'results/derived/testnet-model'
    dest.mkdir(parents=True, exist_ok=True)
    (dest / 'model.json').write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    for v in out['validation']:
        print(f"leave-one-run-out {v['chain']} {v['run']}: {v['measured_active_s'] / 3600:.2f} h measured vs "
              f"{v['predicted_median_s'] / 3600:.2f} h [{v['predicted_95_s'][0] / 3600:.2f}, "
              f"{v['predicted_95_s'][1] / 3600:.2f}] ({v['time_error_percent']:+.1f}%)")
    out.pop('validation')
    for chain, d in out.items():
        st = d['steps']
        print(f"{chain} ({d['testnet']}, {d['chunk_size_bytes']} B): {d['paired_transactions']} paired; "
              f"chunk step median {st['chunk']['median_s']:.2f} s mean {st['chunk']['mean_s']:.2f} s; "
              f"fixed median {st['fixed']['median_s']:.2f} s; outages {len(d['outages_excluded'])}")
