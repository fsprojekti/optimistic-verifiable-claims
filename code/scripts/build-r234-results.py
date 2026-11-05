"""Restore the Stage 01 phase/claim presentation using audited Stage 04 receipts."""
import csv
import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Patch

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE / 'results/raw-data/r1-selection-2026-10-15'
PAPER = STAGE / 'paper/latex'
SLICERS = ['cura', 'orca', 'prusa']
CLAIMS = ['Access', 'Identity', 'Conformance', 'Feature']
NETWORKS = ['sepolia', 'arbitrumSepolia', 'megaethTestnet']


def read(path):
    with path.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def generate(table):
    audit = json.loads((RAW / 'audit.json').read_text())
    files = ['r1-chunk-selection-transactions.csv', 'r1-chunk-selection-predicates.csv',
             'r1-chunk-selection-summary.csv']
    for name in files:
        rel = 'chunk-3072/' + name
        assert hashlib.sha256((RAW / rel).read_bytes()).hexdigest() == audit['evidence_sha256'][rel]
    tx, predicates, summaries = [read(RAW / 'chunk-3072' / f) for f in files]
    assert all(int(r['status']) == 1 for r in tx)
    assert len({r['tx_hash'] for r in tx}) == len(tx)
    assert len(predicates) == 12 and all(r['outcome'] == 'Valid' for r in predicates)
    by_claim = {(r['artifact_key'].split(':')[1], r['predicate']): r for r in predicates}
    source = {r['slicer']: r for r in summaries}
    public = read(STAGE / 'results/raw-data/duration-campaigns/d5-recovery-2026-10-12/analysis/full-artifact-comparison.csv')
    public_access = json.loads((STAGE / 'results/access-testnets/2026-10-14/rpc-audit.json').read_text())
    pub = {(r['network'], r['slicer']): r for r in public}
    acc = {(n['network'], j['slicer']): j for n in public_access['networks'] for j in n['jobs']}
    million = lambda n: f'{int(n)/1e6:.3f}'
    rows = []
    for s in SLICERS:
        for phase, key in [('Posting', 'post_demand_gas'), ('Ciphertext upload', 'ciphertext_upload_gas')]:
            rows.append([s.title(), phase, *[million(pub[n, s][key]) for n in NETWORKS]])
    table('demand-publication.tex',
          'R2 measured Demand posting and ciphertext upload at 3 KiB per chunk. Gas is in millions (M).',
          'tab:r2-publication', 'llrrr', ['Slicer', 'Operation', 'Sepolia', 'Arb. Sep.', 'MegaETH'], rows,
          'Each value sums the named operation only. Upload occurs after Provider selection; preparation and sealing are separate calls. These are public direct-Identity campaign receipts, not mainnet fee or duration projections.')
    for filename, caption, label, field, note in [
        ('binding-cost.tex', 'R3 final four-claim binding gas on the three public testnets (M).',
         'tab:r3-binding', 'binding_gas',
         'One coordinator transaction per job; nine successful bindings in total. Excludes deployment, initialization, Provider-key registration, earlier ciphertext publication and later acceptance or disputes. The revised Access campaign reused sealed Demand ciphertext.'),
        ('access-dispute.tex', 'R4 OVC-Access dispute increment on the three public testnets (M).',
         'tab:r4-access', 'access_dispute_gas',
         'Two transactions per job: challenge and key/seed reveal with RSA-OAEP verification. All nine outcomes were Valid. Publication, binding and deployments are excluded.')]:
        table(filename, caption, label, 'lrrr', ['Slicer', 'Sepolia', 'Arb. Sep.', 'MegaETH'],
              [[s.title(), *[million(acc[n, s][field]) for n in NETWORKS]] for s in SLICERS], note)

    operations = {
        'Access': ['accessDisputeClaim', 'accessRevealWitness'],
        'Identity': ['disputeClaim', 'revealKey', 'startAdjudication', 'processChunk', 'finalizeAdjudication'],
        'Conformance': ['conformanceDisputeClaim', 'conformanceDepositChunk', 'conformanceStartAdjudication',
                        'conformanceProcessChunk', 'conformanceFinalizeAdjudication'],
        'Feature': ['featureDisputeClaim', 'featureDepositChunk', 'featureStartAdjudication',
                    'featureProcessChunk', 'featureFinalizeAdjudication']}
    phase_ops = {'posting': ['postDemand'],
                 'publication': ['prepareBinding', 'depositCiphertextChunk', 'sealCiphertext'],
                 'binding': ['bindProvider']}
    known = [op for ops in [*operations.values(), *phase_ops.values()] for op in ops]
    assert len(known) == len(set(known))
    result = {'scope': 'Local 15 October current four-claim coordinator, 3,072 bytes per chunk; deployments and shared initialization excluded.',
              'artifacts': {}}
    table_rows = []
    for s in SLICERS:
        these = [r for r in tx if r['slicer'] == s]
        assert all(r['operation'] in known for r in these)
        def cost(ops):
            subset = [r for r in these if r['operation'] in ops]
            return {'gas': sum(int(r['gas_used']) for r in subset), 'transactions': len(subset)}
        m = int(source[s]['chunk_count'])
        data = {'bytes': int(source[s]['size_bytes']), 'chunks': m, 'claims': {},
                'phases': {p: cost(ops) for p, ops in phase_ops.items()}}
        for claim in CLAIMS:
            r = by_claim[s, claim]
            c = cost(operations[claim])
            assert c['gas'] == int(r['adjudication_gas'])
            assert c['transactions'] == (2 if claim == 'Access' else m+4 if claim == 'Identity' else 2*m+3)
            c.update(deposit_gas=int(r['deposit_gas']), processing_gas=int(r['process_gas']))
            c['fixed_gas'] = c['gas'] - c['deposit_gas'] - c['processing_gas']
            assert c['fixed_gas'] >= 0
            data['claims'][claim] = c
            table_rows.append([s.title(), claim, *[million(c[k]) for k in ['deposit_gas', 'processing_gas', 'fixed_gas', 'gas']]])
        data['phases']['dispute'] = {k: sum(c[k] for c in data['claims'].values()) for k in ['gas', 'transactions']}
        data['total'] = {k: sum(p[k] for p in data['phases'].values()) for k in ['gas', 'transactions']}
        assert data['total'] == cost(known)
        assert data['phases']['dispute']['transactions'] == 5*m+12
        assert data['total']['transactions'] == 6*m+16
        # The runner's legacy lifecycle column covers Identity only, not all four claims.
        assert int(source[s]['lifecycle_gas']) == sum(data['phases'][p]['gas'] for p in phase_ops) + data['claims']['Identity']['gas']
        result['artifacts'][s] = data
    assert sum(d['total']['transactions'] for d in result['artifacts'].values()) + len([r for r in tx if r['artifact_key']=='setup']) == len(tx)
    table('local-predicates.tex',
          'R4 per-claim dispute increments on the three complete paired inputs, measured locally at 3 KiB per chunk with the current coordinator (15 October). Gas is in millions.',
          'tab:local', 'llrrrr', ['Slicer', 'Claim', 'Deposit', 'Process', 'Fixed', 'Total'], table_rows,
          'All 12 outcomes were Valid. Total includes every dispute transaction. Fixed covers challenge and other non-sweep calls; Access process is its RSA-OAEP reveal/check. Identity reuses Demand ciphertext. Conformance and Feature each deposit plaintext. Earlier publication, binding and shared setup are excluded.')
    phase_rows = []
    for label, phase in [('Demand posting', 'posting'), ('Publication preparation + upload + seal', 'publication'),
                         ('Final four-claim binding', 'binding'), ('All four disputes', 'dispute')]:
        phase_rows.append([label, *[million(result['artifacts'][s]['phases'][phase]['gas']) for s in SLICERS]])
    phase_rows += [
        ['Full protocol gas (M)', *[million(result['artifacts'][s]['total']['gas']) for s in SLICERS]],
        ['Dispute transactions', *[result['artifacts'][s]['phases']['dispute']['transactions'] for s in SLICERS]],
        ['Full protocol transactions', *[result['artifacts'][s]['total']['transactions'] for s in SLICERS]]]
    table('full-protocol-local.tex', 'R4 full local protocol cost with all four claims disputed, at 3 KiB per chunk. Phase gas is in millions (M).',
          'tab:r4-full', 'lrrr', ['Phase or count', 'Cura', 'Orca', 'Prusa'], phase_rows,
          'Each column is one actual complete job from the same 15 October run. The total sums disjoint receipt sets; it excludes six shared contract deployments, Provider-key registration and four coordinator-initialization calls. No acceptance transaction is included. This is a local measurement, not an estimated public four-claim job.')

    # Preserve the original graph's deposit/sweep decomposition, substituting the
    # three real paired inputs for the former synthetic-versus-3DBenchy comparison.
    fig, ax = plt.subplots(figsize=(7.1, 3.35), layout='constrained')
    labels = ['Identity', 'Conformance', 'Feature', 'All four']
    x = np.arange(4); width = .24
    hatches = ['', '///', '...']
    for i, s in enumerate(SLICERS):
        claims = result['artifacts'][s]['claims']
        deposits = [claims[c]['deposit_gas'] for c in labels[:3]] + [sum(c['deposit_gas'] for c in claims.values())]
        totals = [claims[c]['gas'] for c in labels[:3]] + [sum(c['gas'] for c in claims.values())]
        dep, total = np.array(deposits)/1e9, np.array(totals)/1e9
        pos = x+(i-1)*width
        ax.bar(pos, dep, width, color='#a0a0a0', hatch=hatches[i], edgecolor='white', linewidth=.6)
        ax.bar(pos, total-dep, width, bottom=dep, color='#0072b2', hatch=hatches[i], edgecolor='white', linewidth=.6)
        for xx, yy in zip(pos, total):
            ax.text(xx, yy+.025, f'{yy:.3f}', ha='center', va='bottom', fontsize=7)
    ax.set(xticks=x, xticklabels=labels, ylabel='Dispute increment (billion gas)', ylim=(0, 2.85))
    ax.set_axisbelow(True); ax.grid(axis='y', linestyle=':', alpha=.4)
    ax.legend(handles=[Patch(facecolor='#a0a0a0', label='Plaintext deposit'), Patch(facecolor='#0072b2', label='Processing + fixed dispute calls')],
              loc='upper left', fontsize=7.5, frameon=False)
    fig.legend(handles=[Patch(facecolor='white', edgecolor='#555555', hatch=h, label=s.title()) for s,h in zip(SLICERS,hatches)],
               loc='outside lower center', ncol=3, fontsize=8, frameon=False)
    fig.savefig(PAPER/'img/r4-dispute-composition.pdf'); plt.close(fig)
    target = STAGE/'results/derived/paper/r234-phase-summary.json'
    target.write_text(json.dumps(result, indent=2)+'\n', encoding='utf-8')
    return {'r234_local_baseline_chunk_bytes':3072,
            'r4_local_full_dispute_gas': {s: d['phases']['dispute']['gas'] for s,d in result['artifacts'].items()},
            'r4_local_full_protocol_gas': {s: d['total']['gas'] for s,d in result['artifacts'].items()},
            'r4_local_full_protocol_transactions': {s: d['total']['transactions'] for s,d in result['artifacts'].items()}}
