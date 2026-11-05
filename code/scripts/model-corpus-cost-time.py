"""Offline, exploratory corpus projections from archived gas and client timings.

No RPC, wallet, chain writes or manuscript edits. Timing bands quantify bootstrap
uncertainty in conditional mean rates, not end-to-end completion guarantees.
"""
import csv
import hashlib
import json
from collections import defaultdict
from datetime import datetime
from pathlib import Path

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

STAGE = Path(__file__).resolve().parents[2]
BASE = STAGE / 'results/raw-data/duration-campaigns/d5-recovery-2026-10-12'
OUT = STAGE / 'results/derived/corpus-cost-time'
NETWORKS = ['sepolia', 'arbitrumSepolia', 'megaethTestnet']
SLICERS = ['cura', 'orca', 'prusa']
PHASES = {
    'posting': ['postDemand'],
    'publication': ['prepareBinding', 'depositCiphertextChunk', 'sealCiphertext'],
    'direct_identity_setup': ['commitClaim', 'setDemand', 'configureWitnessTerms'],
    'identity_dispute': ['disputeClaim', 'revealKey', 'startAdjudication', 'processChunk', 'finalizeAdjudication']}
OPS = [op for group in PHASES.values() for op in group]
CHUNK = 3072
GAP_SECONDS = 60
REPS = 2000
SEED = 20261016


def read_csv(p):
    with p.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def write_csv(name, rows):
    with (OUT / name).open('w', encoding='utf-8', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0])); w.writeheader(); w.writerows(rows)


def seconds(t):
    return datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp()


def base_op(name):
    return name.split('[')[0]


def count(op, size):
    return (size + CHUNK - 1) // CHUNK if op in ['depositCiphertextChunk', 'processChunk'] else 1


def gas_coefficients(jobs):
    result = {}
    for op in OPS:
        rows = [r for j in jobs for r in j['rows'] if r['operation'] == op]
        if op in ['depositCiphertextChunk', 'processChunk']:
            x = np.array([[1, r['payload_bytes']] for r in rows]); y = np.array([r['gas'] for r in rows])
            a, b = np.linalg.lstsq(x, y, rcond=None)[0]
            result[op] = [float(a), float(b)]
        else:
            result[op] = [float(np.mean([r['gas'] for r in rows])), 0.0]
    return result


def predict_gas(coefficients, size, phase):
    ops = OPS if phase == 'total' else PHASES[phase]
    return sum(coefficients[op][0]*count(op, size) + coefficients[op][1]*size for op in ops)


def time_rates(jobs, gap=GAP_SECONDS):
    return {op: float(np.mean([r['latency_s'] + (r['gap_s'] if r['gap_s'] <= gap else 0)
                              for j in jobs for r in j['rows'] if r['operation'] == op])) for op in OPS}


def time_prediction(rates, size, phase):
    ops = OPS if phase == 'total' else PHASES[phase]
    return sum(rates[op]*count(op, size) for op in ops)


def bootstrap_rates(jobs, rng):
    # Resample whole jobs first, then circular blocks of ten successive chunk
    # observations within each job/operation. Latency and client gap stay paired.
    result = {op: [] for op in OPS}
    for _ in range(REPS):
        selected = rng.integers(len(jobs), size=len(jobs))
        for op in OPS:
            samples = []
            for index in selected:
                a = np.array([r['latency_s'] + (r['gap_s'] if r['gap_s'] <= GAP_SECONDS else 0)
                              for r in jobs[index]['rows'] if r['operation'] == op])
                if len(a) > 1:
                    block = min(10, len(a))
                    starts = rng.integers(len(a), size=(len(a)+block-1)//block)
                    a = a[((starts[:, None]+np.arange(block)) % len(a)).ravel()[:len(a)]]
                samples.extend(a)
            result[op].append(float(np.mean(samples)))
    return {op: np.array(values) for op, values in result.items()}


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    paths = [STAGE / 'data/corpus/generated/gcode-manifest.csv', Path(__file__)]
    corpus = read_csv(paths[0]); assert len(corpus) == 60
    identity_audit_path = BASE / 'analysis/final-measurements.json'
    access_audit_path = STAGE / 'results/access-testnets/2026-10-14/rpc-audit.json'
    paths += [identity_audit_path, access_audit_path]
    identity_audit = json.loads(identity_audit_path.read_text())
    identity_hashes = {r['path'].replace('\\', '/'):r['sha256'] for r in identity_audit['evidence_sha256']}
    access_audit = json.loads(access_audit_path.read_text())
    access_hashes = {(n['network'],j['slicer']):j['journal_sha256'] for n in access_audit['networks'] for j in n['jobs']}
    models = {}; observations = []; validation = []; predictions = []; access_rows = []; diagnostics = []
    rng = np.random.default_rng(SEED)
    for network in NETWORKS:
        jobs = []
        for job in ['smoke-cura-6144', 'full-cura', 'full-orca', 'full-prusa']:
            path = BASE / network / (job + '.checkpoint.json'); paths.append(path)
            assert hashlib.sha256(path.read_bytes()).hexdigest() == identity_hashes[path.relative_to(STAGE).as_posix()]
            data = json.loads(path.read_text()); assert data['outcome'] == 'Valid'
            size = int(data['identity']['sample_bytes']); rows = []
            for name, raw in data['operations'].items():
                op = base_op(name)
                if op not in OPS:
                    continue
                assert raw['status'] == 1
                submitted, received = seconds(raw['submitted_at_utc']), seconds(raw['receipt_at_utc'])
                assert received >= submitted
                gap = submitted-rows[-1]['received'] if rows else 0
                assert gap >= 0
                payload = min(CHUNK, size-int(name.split('[')[1][:-1])*CHUNK) if '[' in name else 0
                rows.append({'operation':op, 'payload_bytes':payload, 'gas':int(raw['gas_used']),
                             'submitted':submitted, 'received':received,
                             'latency_s':received-submitted, 'gap_s':gap})
            assert len(rows) == 2*((size+CHUNK-1)//CHUNK)+10
            observed = rows[-1]['received']-rows[0]['submitted']
            assert abs(observed-sum(r['latency_s']+r['gap_s'] for r in rows)) < .001
            current = {'job':job, 'size':size, 'rows':rows, 'launches':data['launches']}; jobs.append(current)
            for phase in [*PHASES, 'total']:
                subset = rows if phase == 'total' else [r for r in rows if r['operation'] in PHASES[phase]]
                observations.append({'network':network,'job':job,'bytes':size,'phase':phase,'transactions':len(subset),
                    'gas':sum(r['gas'] for r in subset),
                    'elapsed_with_gaps_s':sum(r['latency_s']+r['gap_s'] for r in subset),
                    'client_time_excluding_long_gaps_s':sum(r['latency_s']+(r['gap_s'] if r['gap_s']<=GAP_SECONDS else 0) for r in subset),
                    'excluded_long_gap_s':sum(r['gap_s'] for r in subset if r['gap_s']>GAP_SECONDS),
                    'launches':data['launches']})
        full = [j for j in jobs if j['job'].startswith('full-')]
        gas = gas_coefficients(jobs); rates = time_rates(full); boots = bootstrap_rates(full,rng)
        models[network] = {'gas_coefficients_intercept_per_tx_slope_per_byte':gas,
                           'conditional_client_seconds_per_operation':rates,
                           'time_training_full_jobs':len(full), 'gas_training_jobs':len(jobs),
                           'gap_threshold_sensitivity_total_1MB_seconds':{str(g):time_prediction(time_rates(full,g),1_000_000,'total') for g in [30,60,120,300]}}
        for held in full:
            train = [j for j in jobs if j is not held]
            gg=gas_coefficients(train); tt=time_rates([j for j in full if j is not held])
            for phase in [*PHASES,'total']:
                measured=next(r for r in observations if r['network']==network and r['job']==held['job'] and r['phase']==phase)
                gp=predict_gas(gg,held['size'],phase);tp=time_prediction(tt,held['size'],phase)
                actual=measured['client_time_excluding_long_gaps_s']
                validation.append({'network':network,'held_out_job':held['job'],'phase':phase,
                    'actual_gas':measured['gas'],'predicted_gas':gp,'gas_error_percent':100*(gp/measured['gas']-1),
                    'actual_conditional_client_s':actual,'predicted_conditional_client_s':tp,
                    'time_error_percent':100*(tp/actual-1)})
        for artifact in corpus:
            size=int(artifact['size_bytes'])
            for phase in [*PHASES,'total']:
                ops=OPS if phase=='total' else PHASES[phase]
                samples=sum(boots[op]*count(op,size) for op in ops)
                low,high=np.quantile(samples,[.025,.975])
                predictions.append({'artifact_key':artifact['model_id']+':'+artifact['slicer'],'network':network,
                    'bytes':size,'chunk_bytes':CHUNK,'phase':phase,'transactions':sum(count(op,size) for op in ops),
                    'predicted_gas':predict_gas(gas,size,phase),'predicted_conditional_client_s':time_prediction(rates,size,phase),
                    'normalized_cost_native_at_1_gwei':predict_gas(gas,size,phase)*1e-9,
                    'bootstrap_mean_band_low_s':low,'bootstrap_mean_band_high_s':high,
                    'size_extrapolation_factor':size/max(j['size'] for j in full),
                    'status':'exploratory_projection_not_observed','regime':'historical_identity_client_rpc',
                    'cost_formula':'gas * specified effective gas price; no mainnet fiat price inferred'})
        identity_lat=[r['latency_s'] for j in full for r in j['rows']]
        diagnostics.append({'network':network,'regime':'identity_9_to_12_October','tx':len(identity_lat),
                            'median_submission_to_observed_receipt_s':float(np.median(identity_lat)),
                            'p90_submission_to_observed_receipt_s':float(np.quantile(identity_lat,.9))})
        access_lat=[]
        for slicer in SLICERS:
            p=STAGE/f'results/access-testnets/2026-10-14/{network}/{slicer}.json';paths.append(p)
            assert hashlib.sha256(p.read_bytes()).hexdigest() == access_hashes[network,slicer]
            a=json.loads(p.read_text());assert a['outcome']=='Valid'
            for op in ['bindProvider','disputeClaim','revealWitness']:
                r=a['operations'][op];dt=seconds(r['receipt_at_utc'])-seconds(r['submitted_at_utc']);access_lat.append(dt)
                access_rows.append({'network':network,'slicer':slicer,'operation':op,'gas':int(r['gas_used']),
                    'submission_to_observed_receipt_s':dt,'launches':a['launches'],
                    'regime':'access_14_October','scope':'observed; do not transfer fixed-call latency to unmeasured full sweeps'})
        diagnostics.append({'network':network,'regime':'access_14_October','tx':len(access_lat),
                            'median_submission_to_observed_receipt_s':float(np.median(access_lat)),
                            'p90_submission_to_observed_receipt_s':float(np.quantile(access_lat,.9))})
    write_csv('observed-identity-phases.csv',observations)
    write_csv('observed-access-operations.csv',access_rows)
    write_csv('leave-one-job-out.csv',validation)
    write_csv('corpus-predictions.csv',predictions)
    write_csv('timing-regimes.csv',diagnostics)
    report={'date':'2026-10-16','status':'exploratory model; not a production cost or network speed claim',
        'corpus_files':60,'size_range_bytes':[min(int(r['size_bytes']) for r in corpus),max(int(r['size_bytes']) for r in corpus)],
        'models':models,'bootstrap':{'replicates':REPS,'seed':SEED,'cluster':'full job','within_cluster_block_length':10,
            'band':'2.5%-97.5% bootstrap band for conditional mean duration, not a prediction interval',
            'independent_geometries':1,'full_jobs_per_network':3},
        'phase_time_definition':'Each phase includes the preceding inter-transaction gap; first posting starts at submission. Durations sum exactly. Gaps above 60s excluded only from conditional scenario; all submission-to-receipt durations including recovery remain.',
        'gas_model':'Per network/operation: chunk gas = intercept + slope * payload bytes; fixed-operation means. Four jobs per network; validation holds out complete full-file jobs.',
        'normalized_cost':'Gas times 1 gwei, expressed in native token. A common unit-price sensitivity scenario only; not an observed fee, chain fee quote, or total rollup fee model.',
        'timing_model':'Per network and operation, mean submission-to-observed-receipt plus recorded preceding client gap; no human bidding/selection waits, no finality guarantee.',
        'coverage':{'public_direct_identity':True,'revised_public_binding_and_access':'observed separately, 3 jobs per network',
                    'public_full_four_claim_model':False,'gas_measured_on_all_60_files':False},
        'limitations':['Largest input is over 800 times the largest executed artifact; no independent large-size validation.',
                       'Three slicer outputs share one geometry; hundreds of transactions are not hundreds of independent artifacts.',
                       'Arbitrum historical Identity timings are dominated by client/RPC recovery; later Access is a separate regime.',
                       'Bootstrap bands exclude model misspecification, future congestion changes and unobserved interruption tails.',
                       'Feature cost also depends on G-code content/state. Size alone is not validated for all corpus models.',
                       'Observed test-token fees do not establish production fiat prices; use an explicit fee scenario.',
                       'No pure inclusion-latency inference from client receipt timestamps.'],
        'validation':{n:{k:float(np.max(np.abs([r[k] for r in validation if r['network']==n and r['phase']=='total']))) for k in ['gas_error_percent','time_error_percent']} for n in NETWORKS}}
    (OUT/'model.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    plt.rcParams.update({'font.size':9,'axes.spines.top':False,'axes.spines.right':False})
    fig,axes=plt.subplots(1,2,figsize=(10,3.8),layout='constrained')
    colors=['#205493','#207866','#b96c29']
    names=['Sepolia','Arbitrum Sepolia (historical recovery)','MegaETH testnet']
    for network,color,label in zip(NETWORKS,colors,names):
        rr=sorted([r for r in predictions if r['network']==network and r['phase']=='total'],key=lambda r:r['bytes'])
        x=np.array([r['bytes']/1e6 for r in rr])
        axes[0].plot(x,[r['predicted_gas']/1e9 for r in rr],color=color,label=label)
        axes[1].plot(x,[r['predicted_conditional_client_s']/3600 for r in rr],color=color)
        axes[1].fill_between(x,[r['bootstrap_mean_band_low_s']/3600 for r in rr],[r['bootstrap_mean_band_high_s']/3600 for r in rr],color=color,alpha=.18)
        obs=[r for r in observations if r['network']==network and r['phase']=='total' and r['job'].startswith('full-')]
        axes[0].scatter([r['bytes']/1e6 for r in obs],[r['gas']/1e9 for r in obs],color=color,s=18)
        axes[1].scatter([r['bytes']/1e6 for r in obs],[r['client_time_excluding_long_gaps_s']/3600 for r in obs],color=color,s=18)
    for ax in axes:
        ax.set(xscale='log',yscale='log',xlabel='Corpus file size (MB)');ax.axvline(.316712,color='gray',ls=':',lw=1)
    axes[0].set(ylabel='Direct-Identity protocol gas (billions)',title='Gas: points measured, lines projected')
    axes[1].set(ylabel='Conditional client duration (hours)',title='Time: historical regimes, exploratory bands')
    fig.legend(loc='outside lower center',ncol=3,fontsize=8)
    fig.savefig(OUT/'exploratory-size-cost-time.png',dpi=180);plt.close(fig)
    outputs=[p for p in OUT.iterdir() if p.is_file() and p.name!='source-map.json']
    provenance={'inputs':[{'path':p.relative_to(STAGE).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in paths],
                'outputs':[{'path':p.relative_to(STAGE).as_posix(),'sha256':hashlib.sha256(p.read_bytes()).hexdigest()} for p in outputs]}
    (OUT/'source-map.json').write_text(json.dumps(provenance,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'predictions':len(predictions),'validation':report['validation'],'regimes':diagnostics},indent=2))


if __name__=='__main__':
    main()
