"""Generate the Stage 05 result tables and figures from archived local receipts.

Usage (repository root or anywhere):
  .venv/Scripts/python.exe research/stage-05-ovc-arxiv-revision/code/scripts/build-stage05-results.py

Inputs are the transaction CSVs of the Stage 05 campaigns under results/raw-data. Every
reported gas value is a sum of measured local receipts scaled per operation by the gas ratio
measured on the network's public testnet (testnet_model.py); costs apply the chain parameters
of Table tab:economics (Section 3.6) and Equation eq:real_cost, durations the bootstrap of the
transaction steps measured on the testnets. Outputs: paper/latex/tables/*.tex, paper/latex/img/*.pdf
and results/derived/paper/source-map.json with SHA-256 digests of all inputs and outputs.
"""
import csv
import gzip
import hashlib
import json
from collections import defaultdict
from pathlib import Path

import matplotlib
import numpy as np
matplotlib.use('Agg')
matplotlib.rcParams['pdf.fonttype'] = 42  # embed TrueType, not Type 3 (publisher font checks)
import matplotlib.pyplot as plt

import testnet_model as tm

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE / 'results/raw-data'
PAPER = STAGE / 'paper/latex'
TABLES = PAPER / 'tables'
IMG = PAPER / 'img'
DERIVED = STAGE / 'results/derived/paper'
SWEEP = RAW / 'r1-chunk-sweep-2026-10-22'
SWEEPS = [SWEEP, RAW / 'r1-megaeth-chunk-2026-10-29', RAW / 'r1-megaeth-bracket-2026-10-29']
LADDER = RAW / 'corpus-ladder-2026-10-22'
LADDER_BATCHED = RAW / 'corpus-ladder-batched-2026-10-26'
LADDER_MEGAETH = RAW / 'corpus-ladder-megaeth-2026-10-29'
MEGAETH_PROBE = RAW / 'megaeth-chunk-probe-2026-10-29/probe.json'
CHAIN_PARAMS = RAW / 'chain-params-2026-10-29/chain-params.json'
ETH_PRICES = RAW / 'token-prices-2026-10-29/eth-usd-365d-coingecko.json'
BATCHED_CSV = 'corpus-ladder-batched-transactions.csv'
MONO = RAW / 'monolithic-ladder-2026-10-22'
ACCEPT = RAW / 'r3-accept-2026-10-22'
CSV_NAME = 'corpus-ladder-transactions.csv'

PHI = 0.95
# Representative prices (results/raw-data/chain-params-2026-10-29, token-prices-2026-10-29):
# ETH ranged $1,566-$3,905 over the twelve months to 29 October 2026 (midpoint $2,736); gas is
# the twelve-month median of sampled base fees plus the recent median priority fee.
ETH_USD = 2700
# name, per-transaction limit, USD per Ggas (gas price x token)
CHAINS = [
    ('Ethereum', 16_777_216, 0.12 * ETH_USD),
    ('Arbitrum', 32_000_000, 0.02 * ETH_USD),
    ('MegaETH', 200_000_000, 0.001 * ETH_USD),
]
# MegaEVM also bounds each transaction to 1,000 new storage slots; the largest deposit chunk it
# admits was measured on the testnet by bisection (probe-megaeth-chunk.js).
STATE_LIMIT = {'MegaETH': json.loads(MEGAETH_PROBE.read_text())}
SLICERS = ['cura', 'orca', 'prusa']
SLICER_LABEL = {'cura': 'Cura', 'orca': 'Orca', 'prusa': 'Prusa'}
HINGE = [f'rackstack_hinge:{s}' for s in SLICERS]
LADDER_KEYS = HINGE + [
    f'{m}:{s}' for m in ('electronics_enclosure', 'amazing_distal_shell', 'benchy', 'autodesk_fdm')
    for s in SLICERS] + ['aloha_under_arm:cura', 'moveo_articulation:orca', 'nasa_wrench:prusa']
BENCHY = 'benchy:prusa'

POST = ['postDemand']
PUB = ['prepareBinding', 'depositCiphertextChunk', 'sealCiphertext']
BIND = ['bindProvider']
ACCEPT_OPS = ['acceptBinding']
IDENTITY = ['disputeClaim', 'revealKey', 'startAdjudication', 'processChunk', 'finalizeAdjudication']
ACCESS = ['accessDisputeClaim', 'accessRevealWitness']


def plaintext_ops(prefix):
    return [prefix + op for op in ('DisputeClaim', 'DepositChunk', 'StartAdjudication',
                                   'ProcessChunk', 'FinalizeAdjudication')]


CONFORMANCE = plaintext_ops('conformance')
FEATURE = plaintext_ops('feature')
ALL_FOUR = IDENTITY + ACCESS + CONFORMANCE + FEATURE
INPUTS = []


def read_rows(path):
    if not path.exists():  # large campaigns keep the transaction CSV gzip-compressed in Git
        path = path.with_name(path.name + '.gz')
    INPUTS.append(path)
    with (gzip.open(path, 'rt', newline='') if path.suffix == '.gz' else path.open(newline='')) as f:
        rows = list(csv.DictReader(f))
    assert all(r['status'] == '1' for r in rows), path
    assert len({r['tx_hash'] for r in rows}) == len(rows), path
    return rows


def audited(case_dir):
    return (case_dir / 'rpc-audit.json').exists()


_cache = {}


def artifact_rows(key, chunk):
    """Receipts of one artifact at one chunk size ('whole' for a single whole-file chunk)."""
    model, slicer = key.split(':')
    if key in HINGE:
        name = 'whole-file' if chunk == 'whole' else f'chunk-{chunk}'
        case = next((s / name for s in SWEEPS if audited(s / name)), SWEEP / name)
    elif chunk == 'whole':
        case = MONO / f'{model}-{slicer}'
    else:
        case = LADDER / f'chunk-{chunk}' / f'{model}-{slicer}'
        for batched in (LADDER_BATCHED, LADDER_MEGAETH):  # batched sweeps (identical per-tx gas)
            if not audited(case):
                case = batched / f'chunk-{chunk}' / f'{model}-{slicer}'
    if not audited(case):
        return None
    if case not in _cache:
        batched = LADDER_BATCHED in case.parents or LADDER_MEGAETH in case.parents
        _cache[case] = read_rows(case / (BATCHED_CSV if batched else CSV_NAME))
    return [r for r in _cache[case] if r['artifact_key'] == key]


def gas(rows, ops):
    wanted = set(ops)
    return sum(int(r['gas_used']) for r in rows if r['operation'] in wanted)


def count(rows, ops):
    wanted = set(ops)
    return sum(1 for r in rows if r['operation'] in wanted)


def max_gas(rows, op):
    return max((int(r['gas_used']) for r in rows if r['operation'] == op), default=0)


def size_of(key):
    rows = artifact_rows(key, 4160) or artifact_rows(key, 'whole')
    return int(rows[0]['size_bytes'])


# ---- formatting ---------------------------------------------------------------------------

def tex_int(v):
    return f'{v:,}'.replace(',', '{,}')


def usd(v):
    if v >= 1000:
        return '\\$' + tex_int(round(v))
    if v >= 1:
        return f'\\${v:.2f}'
    if v >= 0.001:
        return f'\\${v:.4f}'
    return f'\\${v:.1g}'


def dur(seconds):
    if seconds < 60:
        return f'{seconds:.0f}~s'
    if seconds < 3600:
        return f'{seconds / 60:.1f}~min'
    return f'{seconds / 3600:.1f}~h'


def dur_rows(rows, ops, chain):
    """Median duration of the selected transactions, from the testnet step bootstrap."""
    return dur(tm.rows_duration(rows, ops, chain[0])[0])


def net(rows, ops, chain):
    """Gas of the selected local receipts on the chain (per-operation testnet ratios)."""
    return tm.net_gas(rows, ops, chain[0])


def cost(g, chain):
    return g / 1e9 * chain[2]


def fee_spread():
    """Per chain, the 5th and 95th percentiles of the daily USD price of gas over the twelve months
    to 29 October 2026 (that day's gas price times that day's ETH price), as multiples of the
    representative price used for every cost in the paper."""
    eth = [p for _, p in json.loads(ETH_PRICES.read_text())['prices']][::-1]  # newest first, as `day`
    rep = {name: usd for name, _, usd in CHAINS}
    out = {}
    for c in json.loads(CHAIN_PARAMS.read_text()):
        name = c['network'].split()[0]
        usd = np.array([d['gwei'] * eth[d['day']] for d in c['daily'] if 'gwei' in d])
        lo, med, hi = np.percentile(usd, [5, 50, 95])
        out[name] = {'days': len(usd), 'p5': lo / rep[name], 'median': med / rep[name], 'p95': hi / rep[name]}
    return out


def label(key):
    model, slicer = key.split(':')
    return f'{model.replace("_", chr(92) + "_")} ({SLICER_LABEL[slicer]})'


def write(name, text):
    TABLES.mkdir(parents=True, exist_ok=True)
    (TABLES / name).write_text(text, encoding='utf-8')


# ---- R1: chunk sweep ----------------------------------------------------------------------

SWEEP_OPS = [('Deposit / upload', 'depositCiphertextChunk'), ('OVC-Identity', 'processChunk'),
             ('OVC-Conformance', 'conformanceProcessChunk'), ('OVC-Feature', 'featureProcessChunk')]


def sweep_sizes():
    sizes = set()
    for sweep in SWEEPS:
        for d in sweep.glob('chunk-*'):
            if audited(d):
                sizes.add(int(d.name.split('-')[1]))
    return sorted(sizes)


def sweep_case(z):
    rows = []
    for key in HINGE:
        rows += artifact_rows(key, z)
    return rows


def operating_chunks(sizes):
    result = []
    for chain in CHAINS:
        budget = PHI * chain[1]
        feasible = [z for z in sizes if max(max_gas(sweep_case(z), op) for _, op in SWEEP_OPS) <= budget]
        state = STATE_LIMIT.get(chain[0])
        if state and max(feasible) > state['largest_fitting_chunk_bytes']:
            # The deposit's state growth binds before compute: the chunk is the measured bound.
            z = state['largest_fitting_chunk_bytes']
            rows = sweep_case(z)
            result.append({'chain': chain, 'z': z, 'limiting': 'Deposit (state growth)',
                           'gas': max(max_gas(rows, op) for _, op in SWEEP_OPS),
                           'next': state['smallest_failing_chunk_bytes'], 'next_gas': None})
            continue
        z = max(feasible)
        above = [s for s in sizes if s > z]
        rows = sweep_case(z)
        limiting_label, limiting_op = max(SWEEP_OPS, key=lambda p: max_gas(rows, p[1]))
        result.append({'chain': chain, 'z': z, 'limiting': limiting_label, 'gas': max_gas(rows, limiting_op),
                       'next': above[0] if above else None,
                       'next_gas': max(max_gas(sweep_case(above[0]), op) for _, op in SWEEP_OPS) if above else None})
    return result


def r1_tables(sizes, cstar):
    grid = [z for z in sizes if z in (1024, 2048, 3072, 4096, 8192, 16384, 32768, 65536, 131072)
            or z in {c['z'] for c in cstar}]
    lines = []
    for z in grid:
        rows = sweep_case(z)
        cells = ' & '.join(f'{max_gas(rows, op) / 1e6:.2f}~M' for _, op in SWEEP_OPS)
        star = '$^{*}$' if z in {c['z'] for c in cstar} else ''
        lines.append(f'{tex_int(z)}~B{star} & {cells} \\\\')
    write('chunk-gas.tex', '\n'.join(lines) + '\n')

    # Per-process bounds: largest chunk whose transaction fits phi * limit, by linear
    # interpolation between measured sizes (extrapolated beyond the largest, marked).
    out = []
    for name, op in SWEEP_OPS:
        pts = [(z, max_gas(sweep_case(z), op)) for z in sizes]
        cells = []
        for chain in CHAINS:
            budget = PHI * chain[1]
            bound, mark = None, ''
            for (z0, g0), (z1, g1) in zip(pts, pts[1:]):
                if g0 <= budget < g1:
                    bound = z0 + (budget - g0) * (z1 - z0) / (g1 - g0)
            if bound is None and pts[-1][1] > pts[-2][1]:
                (z0, g0), (z1, g1) = pts[-2], pts[-1]
                bound, mark = z0 + (budget - g0) * (z1 - z0) / (g1 - g0), '$^{\\dagger}$'
            state = STATE_LIMIT.get(chain[0])
            if state and name == 'Deposit / upload' and bound and bound > state['largest_fitting_chunk_bytes']:
                # MegaEVM's state-growth limit binds the deposit before its compute budget does.
                bound, mark = state['largest_fitting_chunk_bytes'], '$^{\\ddagger}$'
            # A process whose per-chunk gas does not grow with the chunk is not bounded here.
            cells.append(f'{bound / 1024:.1f}~KiB{mark}' if bound else f'$>${pts[-1][0] // 1024}~KiB')
        out.append(f'{name} & ' + ' & '.join(cells) + ' \\\\')
    write('chunk-bounds.tex', '\n'.join(out) + '\n')

    out = []
    for c in cstar:
        name, limit = c['chain'][0], c['chain'][1]
        nxt = (f'{tex_int(c["next"])}~B: rejected' if c['next_gas'] is None
               else f'{tex_int(c["next"])}~B: {c["next_gas"] / 1e6:.2f}~M')
        out.append(f'{name} ({limit / 1e6:.2f}~M) & {tex_int(c["z"])}~B & {c["limiting"]} & '
                   f'{c["gas"] / 1e6:.2f}~M & {100 * c["gas"] / limit:.1f}\\% & {nxt} \\\\')
    write('chunk-select.tex', '\n'.join(out) + '\n')

    # Figure: specific cost against chunk size.
    fig, ax = plt.subplots(figsize=(7.0, 3.4), layout='constrained')
    total_bytes = sum(size_of(k) for k in HINGE)
    for (name, op), marker in zip(SWEEP_OPS, 'osD^'):
        ys = [sum(int(r['gas_used']) for r in sweep_case(z) if r['operation'] == op) / total_bytes for z in sizes]
        ax.plot([z / 1024 for z in sizes], ys, marker=marker, ms=4, lw=1.2, label=name)
    for c in cstar:
        ax.axvline(c['z'] / 1024, color='#888888', ls=':', lw=.8)
    ax.set(xscale='log', xlabel='Chunk size (KiB)', ylabel=r'Specific cost $\nabla G$ (gas/byte)')
    ax.grid(True, which='both', ls=':', alpha=.4)
    ax.legend(fontsize=8, ncol=2)
    IMG.mkdir(parents=True, exist_ok=True)
    fig.savefig(IMG / 'r1-chunk-cost.pdf')
    plt.close(fig)


def r1_monolithic():
    rows_out, points = [], defaultdict(list)
    for key in LADDER_KEYS:
        rows = artifact_rows(key, 'whole')
        if rows is None:
            continue
        n = int(rows[0]['size_bytes'])
        vals = [max_gas(rows, 'depositCiphertextChunk'), max_gas(rows, 'processChunk'),
                max_gas(rows, 'conformanceProcessChunk'), max_gas(rows, 'featureProcessChunk'),
                gas(rows, ['accessRevealWitness'])]
        rows_out.append((n, key, vals))
        for (name, _), v in zip(SWEEP_OPS, vals):
            if name != 'OVC-Conformance':  # short-circuits on the first motion command
                points[name].append((n, v / n))
    rows_out.sort()
    write('monolithic.tex', '\n'.join(
        f'{label(k)} & {tex_int(n)} & ' + ' & '.join(tex_int(v) for v in vals) + ' \\\\'
        for n, k, vals in rows_out) + '\n')
    fig, ax = plt.subplots(figsize=(7.0, 3.4), layout='constrained')
    for (name, pts), marker in zip(points.items(), 'osD^'):
        pts.sort()
        ax.plot([p[0] / 1e6 for p in pts], [p[1] for p in pts], marker=marker, ms=4, lw=1.0, label=name)
    ax.set(xscale='log', yscale='log', xlabel='Artifact size (MB)', ylabel=r'Specific cost $\nabla G$ (gas/byte)')
    ax.grid(True, which='both', ls=':', alpha=.4)
    ax.legend(fontsize=8, ncol=2)
    fig.savefig(IMG / 'r1-specific-cost.pdf')
    plt.close(fig)
    return rows_out


def mono_gas_figure(mono):
    """Figure: gas of one whole-artifact transaction against artifact size, with the chains'
    per-transaction limits; a dotted line of linear growth from OVC-Identity's smallest file
    shows its memory-expansion curvature."""
    from matplotlib.ticker import FixedFormatter, FixedLocator, NullLocator
    ink, muted, grid = '#0b0b0b', '#52514e', '#e4e3df'
    # Validated all-pairs (CVD, normal vision, 3:1 contrast), distinct from the chain colors;
    # marker shape as secondary encoding. Indices into the monolithic row values.
    procs = [('Deposit / upload', 0, '#c2417a', 'o'), ('OVC-Identity', 1, '#7b4fd6', 's'),
             ('OVC-Feature', 3, '#a86d00', '^')]
    with plt.rc_context({'font.size': 10, 'axes.edgecolor': muted, 'axes.labelcolor': ink,
                         'xtick.color': muted, 'ytick.color': muted,
                         'axes.spines.top': False, 'axes.spines.right': False}):
        fig, ax = plt.subplots(figsize=(6.4, 3.6), layout='constrained')
        for name, limit, _ in CHAINS:
            ax.axhline(limit, color=muted, lw=.8, ls='--', zorder=1)
            ax.annotate(f'{name} limit', (55, limit), xytext=(0, -2 if name == 'Ethereum' else 2),
                        textcoords='offset points', ha='right', va='top' if name == 'Ethereum' else 'bottom',
                        fontsize=8.5, color=muted)
        x = [n / 1e6 for n, _, _ in mono]
        for name, i, color, marker in procs:
            ax.plot(x, [v[i] for _, _, v in mono], color=color, marker=marker, ms=4, lw=1.2,
                    markeredgecolor='white', markeredgewidth=.6, label=name)
        n0, _, v0 = mono[0]
        ax.plot([x[0], x[-1]], [v0[1], v0[1] * mono[-1][0] / n0], color=muted, lw=.9, ls=':',
                label='OVC-Identity if linear')
        ax.set(xscale='log', yscale='log', xlim=(0.2, 60), ylim=(8e6, 4e12))
        ax.xaxis.set_major_locator(FixedLocator([0.3, 1, 3, 10, 30]))
        ax.xaxis.set_major_formatter(FixedFormatter(['0.3', '1', '3', '10', '30']))
        ax.yaxis.set_major_locator(FixedLocator([1e7, 1e8, 1e9, 1e10, 1e11, 1e12]))
        ax.yaxis.set_major_formatter(FixedFormatter(['10 M', '100 M', '1 G', '10 G', '100 G', '1 T']))
        for axis in (ax.xaxis, ax.yaxis):
            axis.set_minor_locator(NullLocator())
        ax.grid(True, color=grid, lw=.6)
        ax.set_axisbelow(True)
        ax.set_xlabel('G-code size (MB)')
        ax.set_ylabel('Gas of one transaction')
        ax.legend(fontsize=9, frameon=False, loc='upper left')
        fig.savefig(IMG / 'r1-mono-gas.pdf')
        plt.close(fig)


# ---- R2-R4: ladder tables -----------------------------------------------------------------

def summary_keys():
    """The smallest corpus file, the 3DBenchy and the largest: the rows of the summary tables."""
    return [min(LADDER_KEYS, key=size_of), BENCHY, max(LADDER_KEYS, key=size_of)]


def stage_table(name, ops, scale, digits, include_posting=False, keys=None):
    lines = []
    for key in keys or LADDER_KEYS:
        per_chain = [artifact_rows(key, c['z']) for c in CSTAR]
        if any(r is None for r in per_chain):
            continue
        g_eth = net(per_chain[0], ops, CSTAR[0]['chain'])
        cells = [f'{g_eth / scale:,.{digits}f}'.replace(',', '{,}')]
        for rows, c in zip(per_chain, CSTAR):
            cells += [usd(cost(net(rows, ops, c['chain']), c['chain'])), dur_rows(rows, ops, c['chain'])]
        bold = key == BENCHY
        name_cell = f'{label(key)}, {size_of(key) / 1e6:.3g}~MB' if keys else label(key)
        text = ' & '.join([name_cell] + cells)
        if bold:
            text = ' & '.join('\\textbf{' + x + '}' for x in [name_cell] + cells)
        lines.append(text + ' \\\\')
    write(name, '\n'.join(lines) + '\n')


def r3_table():
    rows = []
    for d in sorted(ACCEPT.glob('*')) if ACCEPT.exists() else []:
        if audited(d):
            rows += read_rows(d / CSV_NAME)
    if not rows:
        return None
    keys = sorted({r['artifact_key'] for r in rows if r['artifact_key'] != 'setup'})
    totals = {k: gas([r for r in rows if r['artifact_key'] == k], BIND + ACCEPT_OPS) for k in keys}
    network = {c[0]: {k: net([r for r in rows if r['artifact_key'] == k], BIND + ACCEPT_OPS, c) for k in keys}
               for c in CHAINS}
    g = max(network['Ethereum'].values())
    cells = [f'{g / 1e6:.2f}']
    for c in CHAINS:
        cells += [usd(max(network[c[0]].values()) / 1e9 * c[2]), dur(tm.duration(c[0], {'fixed': 2})[0])]
    write('binding.tex', 'Binding & ' + ' & '.join(cells) + ' \\\\\n')
    return {'local_gas_by_artifact': totals, 'network_gas_by_artifact': network,
            'min': min(network['Ethereum'].values()), 'max': g,
            'sizes': {k: int(next(r['size_bytes'] for r in rows if r['artifact_key'] == k)) for k in keys}}


def span(values, fmt):
    """A range over the corpus as LaTeX text; one value when both ends print alike."""
    lo, hi = fmt.format(min(values)), fmt.format(max(values))
    return (lo if lo == hi else f'{lo}--{hi}').replace(',', '{,}')


def rate_table():
    """R4 summary: each process's gas per artifact byte and its ratio to publication, as the
    range over the corpus files, at each chain's operating chunk."""
    procs = [('Publication (reference)', PUB), ('OVC-Identity', IDENTITY), ('OVC-Conformance', CONFORMANCE),
             ('OVC-Feature', FEATURE), ('All four', ALL_FOUR)]
    lines = []
    for name, ops in procs:
        cells = []
        for c in CSTAR:
            rates, ratios = [], []
            for key in LADDER_KEYS:
                rows = artifact_rows(key, c['z'])
                if rows is None:
                    continue
                g = net(rows, ops, c['chain'])
                rates.append(g / int(rows[0]['size_bytes']))
                ratios.append(g / net(rows, PUB, c['chain']))
            cells += [span(rates, '{:,.0f}'), span(ratios, '{:.2f}')]
        lines.append(('\\midrule\n' if name == 'All four' else '') + ' & '.join([name] + cells) + ' \\\\')
    write('dispute-rates.tex', '\n'.join(lines) + '\n')


def instance_table():
    per_chain = [artifact_rows(BENCHY, c['z']) for c in CSTAR]
    if any(r is None for r in per_chain):
        write('instance-cost.tex', r'\multicolumn{6}{c}{\emph{pending corpus-ladder measurements}} \\' + '\n')
        return None
    total = net(per_chain[0], ALL_FOUR, CSTAR[0]['chain'])
    lines, summary = [], {}
    for name, ops in [('OVC-Access', ACCESS), ('OVC-Identity', IDENTITY),
                      ('OVC-Conformance', CONFORMANCE), ('OVC-Feature', FEATURE)]:
        g = net(per_chain[0], ops, CSTAR[0]['chain'])
        share = 100 * g / total
        share_txt = '$<$0.1\\%' if share < 0.1 else f'{share:.1f}\\%'
        costs = [usd(cost(net(rows, ops, c['chain']), c['chain'])) for rows, c in zip(per_chain, CSTAR)]
        lines.append(f'{name} & {g / 1e9:.3f} & {share_txt} & ' + ' & '.join(costs) + ' \\\\')
        summary[name] = g
    costs = [usd(cost(net(rows, ALL_FOUR, c['chain']), c['chain'])) for rows, c in zip(per_chain, CSTAR)]
    lines.append('\\midrule\n\\textbf{Total} & \\textbf{' + f'{total / 1e9:.2f}' + '} & \\textbf{100\\%} & '
                 + ' & '.join('\\textbf{' + x + '}' for x in costs) + ' \\\\')
    write('instance-cost.tex', '\n'.join(lines) + '\n')
    return summary


def summary_json(mono, r3, inst):
    out = {'operating_chunks': [{'chain': c['chain'][0], 'chunk': c['z'], 'limiting': c['limiting'],
                                 'gas': c['gas'], 'next': c['next'], 'next_gas': c['next_gas']} for c in CSTAR],
           'binding': r3, 'benchy_instances': inst, 'fee_spread': fee_spread(), 'artifacts': {}}
    for key in LADDER_KEYS:
        entry = {}
        for c in CSTAR:
            rows = artifact_rows(key, c['z'])
            if rows is None:
                continue
            stages = {'post': POST, 'publish': PUB, 'bind': BIND, 'identity': IDENTITY, 'access': ACCESS,
                      'conformance': CONFORMANCE, 'feature': FEATURE, 'all_four': ALL_FOUR}
            entry[c['chain'][0]] = {k: {'gas': net(rows, ops, c['chain']), 'local_gas': gas(rows, ops),
                                        'tx': count(rows, ops), 'usd': cost(net(rows, ops, c['chain']), c['chain']),
                                        'duration_s': tm.rows_duration(rows, ops, c['chain'][0])}
                                    for k, ops in stages.items()}
            entry['size_bytes'] = int(rows[0]['size_bytes'])
        out['artifacts'][key] = entry
    out['monolithic'] = [{'artifact': k, 'bytes': n, 'deposit': v[0], 'identity': v[1], 'conformance': v[2],
                          'feature': v[3], 'access': v[4]} for n, k, v in mono]
    DERIVED.mkdir(parents=True, exist_ok=True)
    (DERIVED / 'stage05-results.json').write_text(json.dumps(out, indent=2) + '\n', encoding='utf-8')


def pct(a, b):
    if not b:
        return '??'
    share = 100 * a / b
    return f'{share:.1f}\\%' if share >= 1 else f'{share:.2g}\\%'


def numbers(r3):
    """Measured values quoted in the prose, as LaTeX macros ('??' until the data exist)."""
    n = {}
    hinge = artifact_rows('rackstack_hinge:cura', CSTAR[0]['z'])
    benchy = artifact_rows(BENCHY, CSTAR[0]['z'])
    bind = r3['max'] if r3 else None
    n['BINDSHAREHINGE'] = pct(bind, net(hinge, POST + PUB, CSTAR[0]['chain'])) if bind and hinge else '??'
    n['BINDSHAREBENCHY'] = pct(bind, net(benchy, POST + PUB, CSTAR[0]['chain'])) if bind and benchy else '??'
    lines = [f'\\newcommand{{\\{k}}}{{{v}}}' for k, v in sorted(n.items())]
    write('numbers.tex', '% Generated by build-stage05-results.py\n' + '\n'.join(lines) + '\n')


def source_map():
    outputs = sorted(TABLES.glob('*.tex')) + sorted(IMG.glob('r[124]-*.pdf')) + [DERIVED / 'stage05-results.json']
    digest = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
    data = {'generator': Path(__file__).relative_to(STAGE).as_posix(), 'generator_sha256': digest(Path(__file__)),
            'inputs': {p.relative_to(STAGE).as_posix(): digest(p) for p in sorted(set(INPUTS))},
            'outputs': {p.relative_to(STAGE).as_posix(): digest(p) for p in outputs}}
    (DERIVED / 'source-map.json').write_text(json.dumps(data, indent=2) + '\n', encoding='utf-8')


def cost_time_figures():
    """Two figures against artifact size, undisputed and fully contested, one line per chain:
    settlement cost with the daily-fee range as a band, and duration as the bootstrap median
    with its 95% interval as a band."""
    from matplotlib.ticker import FixedFormatter, FixedLocator, NullLocator
    stages = [('No dispute', POST + PUB + BIND), ('Fully contested', POST + PUB + BIND + ALL_FOUR)]
    # Categorical slots validated all-pairs (CVD and normal vision); marker shape as secondary
    # encoding, since the third slot is below 3:1 contrast on white.
    style = {'Ethereum': ('#2a78d6', 'o'), 'Arbitrum': ('#eb6834', 's'), 'MegaETH': ('#1baf7a', '^')}
    ink, muted, grid = '#0b0b0b', '#52514e', '#e4e3df'
    fees = fee_spread()
    pts = defaultdict(list)
    for key in LADDER_KEYS:
        for c in CSTAR:
            rows = artifact_rows(key, c['z'])
            if rows is None:
                continue
            mb = int(rows[0]['size_bytes']) / 1e6
            for stage, ops in stages:
                med, lo, hi = tm.rows_duration(rows, ops, c['chain'][0])
                pts[(stage, c['chain'][0])].append(
                    (mb, cost(net(rows, ops, c['chain']), c['chain']), med / 3600, lo / 3600, hi / 3600))

    def band(chain, p, kind):
        if kind == 'cost':
            f = fees[chain]
            return [q[1] * f['p5'] for q in p], [q[1] for q in p], [q[1] * f['p95'] for q in p]
        return [q[3] for q in p], [q[2] for q in p], [q[4] for q in p]

    figures = [('cost', 'r2-r4-cost.pdf', (0.4, 1e6), [1, 10, 100, 1e3, 1e4, 1e5, 1e6],
                ['$1', '$10', '$100', '$1k', '$10k', '$100k', '$1M'], 'Cost (USD, 5-95% of daily fees)'),
               ('duration', 'r2-r4-duration.pdf', (8 / 3600, 600), [10 / 3600, 1 / 60, 10 / 60, 1, 24, 240],
                ['10 s', '1 min', '10 min', '1 h', '1 day', '10 days'], 'Duration (median, 95% interval)')]
    benchy = size_of(BENCHY) / 1e6
    with plt.rc_context({'font.size': 10, 'axes.edgecolor': muted, 'axes.labelcolor': ink,
                         'xtick.color': muted, 'ytick.color': muted,
                         'axes.spines.top': False, 'axes.spines.right': False}):
        for kind, name, ylim, ticks, labels, ylabel in figures:
            fig, axes = plt.subplots(1, 2, figsize=(6.4, 3.0), sharey=True, layout='constrained')
            for ax, (stage, _) in zip(axes, stages):
                ax.set_title(stage, fontsize=11, color=ink, loc='left')
                for chain, (color, marker) in style.items():
                    p = sorted(pts[(stage, chain)])
                    x = [q[0] for q in p]
                    lo, mid, hi = band(chain, p, kind)
                    ax.fill_between(x, lo, hi, color=color, alpha=.18, lw=0)
                    ax.plot(x, mid, color=color, lw=1.2, marker=marker, ms=4,
                            markeredgecolor='white', markeredgewidth=.6, label=chain)
                ax.set(xscale='log', yscale='log', xlim=(0.2, 60), ylim=ylim)
                ax.xaxis.set_major_locator(FixedLocator([0.3, 1, 3, 10, 30]))
                ax.xaxis.set_major_formatter(FixedFormatter(['0.3', '1', '3', '10', '30']))
                ax.yaxis.set_major_locator(FixedLocator(ticks))
                ax.yaxis.set_major_formatter(FixedFormatter(labels))
                for axis in (ax.xaxis, ax.yaxis):
                    axis.set_minor_locator(NullLocator())
                ax.grid(True, color=grid, lw=.6)
                ax.set_axisbelow(True)
                ax.axvline(benchy, color=muted, lw=.6, ls=':', zorder=0)
                ax.set_xlabel('G-code size (MB)')
            axes[1].annotate('3DBenchy', (benchy, ylim[0]), xytext=(3, 4), textcoords='offset points',
                             fontsize=9, color=muted)
            axes[0].set_ylabel(ylabel)
            axes[0].legend(fontsize=9, frameon=False, loc='upper left')
            fig.savefig(IMG / name)
            plt.close(fig)


if __name__ == '__main__':
    sizes = sweep_sizes()
    CSTAR = operating_chunks(sizes)
    r1_tables(sizes, CSTAR)
    mono = r1_monolithic()
    mono_gas_figure(mono)
    stage_table('demand-publication.tex', POST + PUB, 1e6, 1)
    stage_table('demand-publication-summary.tex', POST + PUB, 1e6, 1, keys=summary_keys())
    stage_table('dispute-identity.tex', IDENTITY, 1e9, 2)
    stage_table('dispute-conformance.tex', CONFORMANCE, 1e9, 2)
    stage_table('dispute-feature.tex', FEATURE, 1e9, 2)
    stage_table('dispute-all.tex', ALL_FOUR, 1e9, 2)
    stage_table('full-cost.tex', POST + PUB + BIND + ALL_FOUR, 1e9, 2)
    r3 = r3_table()
    inst = instance_table()
    rate_table()
    cost_time_figures()
    numbers(r3)
    summary_json(mono, r3, inst)
    source_map()
    for c in CSTAR:
        print(f"{c['chain'][0]}: c* = {c['z']} B, limiting {c['limiting']} {c['gas']:,} gas")
    print('tables:', ', '.join(p.name for p in sorted(TABLES.glob('*.tex'))))
