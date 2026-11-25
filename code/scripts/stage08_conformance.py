"""Stage 08 (D7): the machine-profile Conformance receipts that replace the Stage 05 ones.

Only OVCConformanceSegmented changed (T0'), so the result builder keeps every Stage 05 receipt
except the five operations of the Conformance dispute, which it takes per (artifact, chunk)
from the Stage 08 campaigns (T10, T11), and it adds the Consumer's declaration to posting.
The machine registration is a one-time cost per machine profile, reported separately.

Network gas and testnet steps (T13, results/raw-data/conformance-testnet-2026-11-25/PROTOCOL.md):
every Conformance operation, the declaration and the registration take the per-operation ratio
public/local measured on the chain's network in that campaign (Ethereum on a mainnet fork), and the
two Conformance chunk operations take their steps from its runs on the chain's testnet. Every other
operation keeps the Stage 05 ratios and the 2 November steps. (T12 used the Feature sweep's ratio
and steps as a proxy; GAS_PROXY and STEP_PROXY keep that variant for comparison.)
"""
import csv
import gzip
from pathlib import Path

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE / 'results/raw-data'
R1 = RAW / 'conformance-r1-2026-11-25'
LADDER = RAW / 'conformance-ladder-2026-11-25'
MONO = RAW / 'conformance-monolithic-2026-11-25'
CSV_NAME = 'conformance-ladder-transactions.csv'
TESTNET = RAW / 'conformance-testnet-2026-11-25'
# Chain -> runs of that campaign giving its gas ratios, and the runs giving its steps.
GAS_RUNS = {'Ethereum': ['mainnet-fork'], 'Arbitrum': ['arbitrumSepolia'],
            'MegaETH': ['megaethTestnet-31872', 'megaethTestnet-31872-benchy']}
STEP_RUN_NAMES = {'Ethereum': ['sepolia'], 'Arbitrum': ['arbitrumSepolia'],
                  'MegaETH': ['megaethTestnet-31872', 'megaethTestnet-31872-benchy']}
STEP_OPS = ['conformanceDepositChunk', 'conformanceProcessChunk']
HINGE = {'rackstack_hinge:cura', 'rackstack_hinge:orca', 'rackstack_hinge:prusa'}

DISPUTE = ['conformanceDisputeClaim', 'conformanceDepositChunk', 'conformanceStartAdjudication',
           'conformanceProcessChunk', 'conformanceFinalizeAdjudication']
DECLARE = 'declareConformance'
REGISTER = 'registerMachine'
GAS_PROXY = {'conformanceProcessChunk': 'featureProcessChunk', DECLARE: 'postDemand', REGISTER: 'postDemand'}
STEP_PROXY = {'conformanceProcessChunk': 'featureProcessChunk'}

INPUTS = []
_cache = {}


def _read(case):
    path = case / CSV_NAME
    if not path.exists():
        path = path.with_name(path.name + '.gz')
    if path not in _cache:
        INPUTS.append(path)
        with (gzip.open(path, 'rt', newline='') if path.suffix == '.gz' else path.open(newline='')) as f:
            rows = list(csv.DictReader(f))
        assert all(r['status'] == '1' for r in rows), path
        _cache[path] = rows
    return _cache[path]


def case_dir(key, chunk):
    model, slicer = key.split(':')
    if key in HINGE:
        return R1 / ('whole-file' if chunk == 'whole' else f'chunk-{chunk}')
    if chunk == 'whole':
        return MONO / f'{model}-{slicer}'
    return LADDER / f'chunk-{chunk}' / f'{model}-{slicer}'


def rows(key, chunk):
    """The Stage 08 declaration and Conformance dispute receipts of one artifact, or None if absent."""
    case = case_dir(key, chunk)
    if not (case / 'rpc-audit.json').exists():
        return None
    return [r for r in _read(case) if r['artifact_key'] == key and r['operation'] in DISPUTE + [DECLARE]]


def substitute(base, key, chunk):
    """Stage 05 receipts with the Conformance dispute replaced and the declaration added."""
    if base is None:
        return None
    new = rows(key, chunk)
    if new is None:
        return None  # never mix the Stage 05 Conformance into a Stage 08 result
    return [r for r in base if r['operation'] not in DISPUTE] + new


def declaration_row(key):
    """A declaration receipt for an artifact measured only on the undisputed path (fixed-size call)."""
    for chunk in (4160, 8000, 31872):
        r = rows(key, chunk)
        if r:
            return next(x for x in r if x['operation'] == DECLARE)
    r = rows('rackstack_hinge:cura', 4160)
    return next(x for x in r if x['operation'] == DECLARE)


def registration_gas():
    """Gas of the one-time machine-profile registration (setup row of the R1 campaign)."""
    out = set()
    for case in sorted(R1.glob('chunk-*')):
        if (case / 'rpc-audit.json').exists():
            out |= {int(r['gas_used']) for r in _read(case) if r['operation'] == REGISTER}
    return sorted(out)


def _public(run):
    path = TESTNET / run / 'journal-transactions.csv'
    INPUTS.append(path)
    with path.open(newline='', encoding='utf-8') as f:
        out = [r for r in csv.DictReader(f)
               if r['operation'] != 'fundProvider' and not r['operation'].startswith('deploy')]
    assert out and all(r['status'] == '1' for r in out), path
    return out


def _local_gas(key, op, index, chunk):
    """Gas of the local counterpart (same artifact, operation, chunk index and chunk size)."""
    if key == 'setup':  # the registration is the same call in every local case
        key = 'rackstack_hinge:cura'
        match = lambda r: r['operation'] == op
    else:
        match = lambda r: r['artifact_key'] == key and r['operation'] == op and r['chunk_index'] == index
    found = [int(r['gas_used']) for r in _read(case_dir(key, chunk)) if match(r)]
    assert len(found) == 1, (key, op, index, chunk)
    return found[0]


_ratios = {}


def ratios(chain):
    """Per-operation gas ratio public/local of every Conformance operation, as testnet_model.ratios."""
    if chain not in _ratios:
        acc = {}
        for run in GAS_RUNS[chain]:
            for r in _public(run):
                g = int(r['gas_used'])
                l = _local_gas(r['artifact_key'], r['operation'], r['chunk_index'], int(r['chunk_size_bytes']))
                a = acc.setdefault(r['operation'], [0, 0, 0, float('inf'), 0.0])
                a[0] += g
                a[1] += l
                a[2] += 1
                a[3] = min(a[3], g / l)
                a[4] = max(a[4], g / l)
        _ratios[chain] = {op: {'ratio': a[0] / a[1], 'min': a[3], 'max': a[4], 'n': a[2], 'public_gas': a[0],
                               'local_gas': a[1], 'runs': GAS_RUNS[chain]} for op, a in acc.items()}
    return _ratios[chain]


def step_runs():
    """testnet_model.STEP_RUNS for the Conformance chunk operations."""
    out = {}
    for chain, names in STEP_RUN_NAMES.items():
        runs = [f'{TESTNET.name}/{n}' for n in names if (TESTNET / n / 'journal-transactions.csv').exists()]
        for n in names:
            INPUTS.append(TESTNET / n / 'journal-transactions.csv')
        out[chain] = {op: runs for op in STEP_OPS}
    return out
