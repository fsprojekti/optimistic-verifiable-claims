"""Evaluate the timing revalidation campaign against its pre-registered criteria.

Usage: python code/scripts/evaluate-timing-revalidation.py
Protocol: results/raw-data/timing-revalidation-2026-11-02/PROTOCOL.md
Output:   results/derived/timing-revalidation/evaluation.json

The model for each network is fitted to that network's hinge full-path run of this campaign only;
each validation run is predicted from its file's local transactions, as in testnet_model.validate().

A second analysis, decided after the pre-registered one (owner, 4 November 2026), excludes from
model and validation alike every step whose transaction logged a transient RPC retry: the back-off
measures the public endpoint, not OVC. Its validation is predicted for the regular steps measured.
"""
import json
import statistics
from collections import defaultdict
from pathlib import Path

import testnet_model as tm

CAMPAIGN = tm.RAW / 'timing-revalidation-2026-11-02'
LADDER = tm.RAW / 'corpus-ladder-batched-2026-10-26'
# chain, model run, validation run, artifact, local transactions of that artifact at the run's chunk
VALIDATIONS = [
    ('Ethereum', 'sepolia', 'sepolia-enclosure', 'electronics_enclosure:prusa',
     LADDER / 'chunk-4160/electronics_enclosure-prusa/corpus-ladder-batched-transactions.csv'),
    ('Arbitrum', 'arbitrumSepolia', 'arbitrumSepolia-enclosure', 'electronics_enclosure:prusa',
     tm.RAW / 'corpus-ladder-2026-10-22/chunk-8000/electronics_enclosure-prusa/corpus-ladder-transactions.csv'),
    ('MegaETH', 'megaethTestnet-31872', 'megaethTestnet-31872-benchy-a', 'benchy:prusa',
     tm.RAW / 'corpus-ladder-megaeth-2026-10-29/chunk-31872/benchy-prusa/corpus-ladder-batched-transactions.csv'),
    ('MegaETH', 'megaethTestnet-31872', 'megaethTestnet-31872-benchy-b', 'benchy:prusa',
     tm.RAW / 'corpus-ladder-megaeth-2026-10-29/chunk-31872/benchy-prusa/corpus-ladder-batched-transactions.csv'),
]
PHASES = ['estimate', 'nonce', 'populate', 'balance', 'sign', 'save', 'broadcast']
REGIME = (0.8, 1.25)


def run_rows(run):
    return sorted((r for r in tm._rows(CAMPAIGN / run / 'journal-transactions.csv') if r['artifact_key'] != 'setup'),
                  key=lambda r: tm._t(r['receipt_at_utc']))


def profile(rows, skip=frozenset()):
    """Per chunk operation: steps, network times and phases; plus active time, excluded gaps and the
    transactions of the steps kept (a step whose transaction label is in skip is left out)."""
    out = defaultdict(lambda: {'step': [], 'network': [], **{p: [] for p in PHASES}})
    active, gaps, kept = 0.0, [], []
    for prev, r in zip(rows, rows[1:]):
        if tm.op_key(r) in skip:
            continue
        kept.append(r)
        prep = tm._t(r['submitted_at_utc']) - tm._t(prev['receipt_at_utc'])
        net = tm._t(r['receipt_at_utc']) - tm._t(r['submitted_at_utc'])
        if prep > tm.OUTAGE_S:
            gaps.append(prep)
            prep = 0.0
        active += prep + net
        if r['operation'] in tm.CHUNK_OPS:
            o = out[r['operation']]
            o['step'].append(prep + net)
            o['network'].append(net)
            for p in PHASES:
                if r.get(f'{p}_ms'):
                    o[p].append(float(r[f'{p}_ms']))
    return out, active, gaps, kept


def evaluate(regular):
    tm.REGULAR_ONLY = regular
    results = []
    for chain, model_run, run, key, local_csv in VALIDATIONS:
        if not (CAMPAIGN / run / 'journal-transactions.csv').exists():
            results.append({'run': run, 'status': 'not finished'})
            continue
        # Fit on this campaign's hinge run: point the model's step source at the campaign directory.
        # Gas is predicted for the network that was measured, so the ratios also come from that
        # run (the paper's Ethereum ratios come from a mainnet fork, not from Sepolia's schedule).
        tm.RUN = CAMPAIGN
        tm.GAS_RUN[chain] = CAMPAIGN / model_run
        tm.ACCEPT_RUN[chain] = CAMPAIGN / f'{model_run}-accept'
        tm._ratios.pop(chain, None)
        pub = [r for r in run_rows(run) if r['artifact_key'] == key]
        local = [r for r in tm._rows(local_csv) if r['artifact_key'] == key]
        ops = sorted({r['operation'] for r in pub})
        model_prof, _, _, _ = profile(run_rows(model_run), tm.retried(model_run) if regular else frozenset())
        val_prof, active, gaps, kept = profile(pub, tm.retried(run) if regular else frozenset())
        med, lo, hi = tm.rows_duration(kept if regular else local, ops, chain, runs=[model_run])
        regime = {}
        for op, v in sorted(val_prof.items()):
            m = model_prof.get(op)
            if not m:
                continue
            regime[op] = {}
            for metric in ['step', 'network'] + PHASES:
                if v[metric] and m[metric]:
                    a, b = statistics.median(v[metric]), statistics.median(m[metric])
                    regime[op][metric] = {'validation': a, 'model': b, 'ratio': a / b if b else None}
        failed = [f'{op}.{metric}' for op, d in regime.items() for metric, x in d.items()
                  if x['ratio'] is None or not REGIME[0] <= x['ratio'] <= REGIME[1]]
        measured_gas = sum(int(r['gas_used']) for r in pub)
        predicted_gas = tm.net_gas(local, ops, chain)
        results.append({
            'chain': chain, 'run': run, 'artifact': key, 'model_run': model_run, 'transactions': len(pub),
            'steps_kept': len(kept), 'model_steps_retried_excluded': tm.steps(chain, [model_run])['retried_excluded'],
            'measured_active_s': active, 'outages_excluded_s': gaps,
            'predicted_median_s': med, 'predicted_95_s': [lo, hi],
            'time_error_percent': 100 * (med - active) / active,
            'criterion_1_duration_in_interval': lo <= active <= hi,
            'criterion_2_regime_same': not failed, 'regime_failures': failed,
            'measured_gas': measured_gas, 'predicted_gas': predicted_gas,
            'gas_error_percent': 100 * (predicted_gas - measured_gas) / measured_gas,
            'criterion_3_gas': abs(predicted_gas - measured_gas) / measured_gas <= 0.001,
            'regime': regime,
        })
    return results


def report(r):
    if 'chain' not in r:
        print(f"{r['run']}: {r['status']}")
        return
    print(f"{r['run']}: steps {r['steps_kept']}/{r['transactions'] - 1} (model excluded {r['model_steps_retried_excluded']}); "
          f"measured {r['measured_active_s'] / 3600:.2f} h, predicted {r['predicted_median_s'] / 3600:.2f} h "
          f"[{r['predicted_95_s'][0] / 3600:.2f}, {r['predicted_95_s'][1] / 3600:.2f}] ({r['time_error_percent']:+.1f}%); "
          f"C1 {r['criterion_1_duration_in_interval']}, C2 {r['criterion_2_regime_same']}, "
          f"C3 {r['criterion_3_gas']} (gas {r['gas_error_percent']:+.3f}%); gaps {len(r['outages_excluded_s'])}")
    for f in r['regime_failures']:
        op, metric = f.split('.')
        x = r['regime'][op][metric]
        ratio = f"x{x['ratio']:.2f}" if x['ratio'] is not None else 'n/a'
        print(f"    {f}: validation {x['validation']:.2f} vs model {x['model']:.2f} ({ratio})")


def main():
    out = {'pre_registered': evaluate(False), 'regular_steps': evaluate(True)}
    dest = tm.STAGE / 'results/derived/timing-revalidation'
    dest.mkdir(parents=True, exist_ok=True)
    (dest / 'evaluation.json').write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')
    for analysis, results in out.items():
        print(f'== {analysis}')
        for r in results:
            report(r)


if __name__ == '__main__':
    main()
