"""Present the frozen exploratory corpus model without refitting or chain access."""
import csv
import hashlib
import json
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np

STAGE = Path(__file__).resolve().parents[2]
MODEL = STAGE/'results/derived/corpus-cost-time'
PAPER = STAGE/'paper/latex'
NETWORKS = ['sepolia','arbitrumSepolia','megaethTestnet']
NAMES = ['Sepolia','Arb. Sepolia','MegaETH']


def read(name):
    with (MODEL/name).open(encoding='utf-8-sig',newline='') as f:
        return list(csv.DictReader(f))


def generate(table):
    provenance=json.loads((MODEL/'source-map.json').read_text())
    for e in provenance['inputs']+provenance['outputs']:
        assert hashlib.sha256((STAGE/e['path']).read_bytes()).hexdigest()==e['sha256'],e['path']
    report=json.loads((MODEL/'model.json').read_text())
    rows=read('corpus-predictions.csv');observed=read('observed-identity-phases.csv')
    access=read('observed-access-operations.csv')
    totals=[r for r in rows if r['phase']=='total']
    ref=[r for r in totals if r['network']=='sepolia']
    selected=[min(ref,key=lambda r:abs(int(r['bytes'])/1e6-v)) for v in [.3,1,5,25,100,260]]
    assert len({r['artifact_key'] for r in selected})==6
    by={(r['artifact_key'],r['network'],r['phase']):r for r in rows}
    size=lambda r:f"{int(r['bytes'])/1e6:.3f}"
    costs=[];times=[]
    for r in selected:
        costs.append([size(r),*[f"{float(by[r['artifact_key'],n,'total']['normalized_cost_native_at_1_gwei']):.3f}" for n in NETWORKS]])
        time_row=[size(r)]
        for n in NETWORKS:
            p=by[r['artifact_key'],n,'total']
            point=f"{float(p['predicted_conditional_client_s'])/3600:.2f}"
            band=f"[{float(p['bootstrap_mean_band_low_s'])/3600:.2f}, {float(p['bootstrap_mean_band_high_s'])/3600:.2f}]"
            time_row.append(r'\shortstack[r]{'+point+r'\\{'+band+'}}')
        times.append(time_row)
    table('corpus-cost-scenarios.tex',
          'Direct-Identity protocol cost projected to six actual corpus sizes, at a common illustrative effective price of 1 gwei per gas. Values are native-token units.',
          'tab:corpus-cost','rrrr',['MB',*NAMES],costs,
          'Values also equal gas in billions numerically at this unit price. Multiply by the chosen gas price in gwei; any separately charged network components must be added. This is a common-price sensitivity scenario, not observed test fees or a mainnet affordability ranking. It covers posting, deferred publication, direct Identity setup and its dispute, excluding deployment. Sizes are decimal MB; all 60 corpus predictions are archived.',placement='!htb')
    table('corpus-duration-scenarios.tex',
          r'Conditional mean duration of the same direct-Identity path, projected in hours. Each cell gives the mean above its 95\% bootstrap band.',
          'tab:corpus-duration','rrrr',['MB',*NAMES],times,
          'Arbitrum retains the historical client/RPC recovery regime; this is not a comparison of intrinsic chain speed. The scenario separates inter-transaction gaps above 60 s and retains all submission-to-observed-receipt delays and ordinary client pacing. Bands exclude unobserved outages and extrapolation-model error; they are not job-completion prediction intervals.',placement='!htb')
    duration_path=PAPER/'tables/corpus-duration-scenarios.tex'
    duration_text=duration_path.read_text()
    duration_text='\n'.join(line[:-2]+r'\\[3pt]' if r'\shortstack' in line and line.endswith(r'\\') else line for line in duration_text.splitlines())+'\n'
    duration_path.write_text(duration_text,encoding='utf-8')
    phase_rows=[]
    for n,name in zip(NETWORKS,NAMES):
        vals=[]
        for phase in ['posting','publication','identity_dispute']:
            rr=[r for r in observed if r['network']==n and r['job'].startswith('full-') and r['phase']==phase]
            v=np.array([float(r['client_time_excluding_long_gaps_s']) for r in rr])/60
            vals.append(f'{np.median(v):.2f} [{v.min():.2f}, {v.max():.2f}]')
        phase_rows.append([name,*vals])
    table('observed-phase-durations.tex',
          'Measured client durations for the three full-file Identity jobs per network (0.264--0.317 MB): median [minimum, maximum], in minutes.',
          'tab:phase-duration','lrrr',['Network','Posting','Publication','Identity dispute'],phase_rows,
          'Publication includes preparation, upload and sealing; dispute includes challenge through finalization. Boundary gaps belong to the following phase. Gaps above 60 s are separated; receipt delays, including RPC recovery, remain. Direct Identity setup is separate. These are on-chain workflow timings, excluding human bidding, selection and manufacturing.',placement='!htb')
    binding=[]
    for n,name in zip(NETWORKS,NAMES):
        rr=[r for r in access if r['network']==n and r['operation']=='bindProvider']
        g=np.array([int(r['gas']) for r in rr])/1e6
        t=np.array([float(r['submission_to_observed_receipt_s']) for r in rr])
        binding.append([name,f'{np.median(g):.3f}',f'{np.median(t):.2f}',f'{t.min():.2f}--{t.max():.2f}'])
    table('binding-cost.tex','R3 measured final four-claim binding: gas and client duration for three jobs per network.',
          'tab:r3-binding','lrrr',['Network','Gas (M)','Median (s)','Range (s)'],binding,
          'One coordinator transaction per job; gas is the median, rounded to 0.001 M. Duration runs from submission to observed receipt; the Sepolia range includes a resumed case. Excludes deployment, initialization, key registration, earlier publication and later acceptance/disputes. The revised Access campaign reused sealed Demand ciphertext.',placement='!htb')
    table('model-validation.tex','Leave-one-full-job-out validation of the direct-Identity model. Maximum absolute total-path error over three held-out jobs per network.',
          'tab:model-validation','lrr',['Network',r'Gas error (\%)',r'Time error (\%)'],
          [[name,f"{report['validation'][n]['gas_error_percent']:.3f}",f"{report['validation'][n]['time_error_percent']:.2f}"] for n,name in zip(NETWORKS,NAMES)],
          'The held-out jobs are three slicer outputs of one geometry, 0.264--0.317 MB. This checks within-range transfer; it does not validate the larger corpus sizes. Timing targets use the same conditional gap treatment as the model.',placement='!htb')
    table('projection-artifacts.tex','Actual corpus files selected for the six-size projection table. All model outputs retain the frozen artifact identity.',
          'tab:projection-artifacts','lrr',['Model / slicer','Bytes','MB'],
          [[r['artifact_key'].replace('_',r'\_').replace(':',' / '),f"{int(r['bytes']):,}",size(r)] for r in selected],placement='!htb')
    fig,axes=plt.subplots(1,2,figsize=(7.2,3.25),layout='constrained')
    colors=['#205493','#207866','#b96c29']
    for n,name,color in zip(NETWORKS,NAMES,colors):
        rr=sorted([r for r in totals if r['network']==n],key=lambda r:int(r['bytes']))
        x=np.array([int(r['bytes'])/1e6 for r in rr])
        axes[0].plot(x,[float(r['normalized_cost_native_at_1_gwei']) for r in rr],color=color,label=name)
        axes[1].plot(x,[float(r['predicted_conditional_client_s'])/3600 for r in rr],color=color)
        axes[1].fill_between(x,[float(r['bootstrap_mean_band_low_s'])/3600 for r in rr],[float(r['bootstrap_mean_band_high_s'])/3600 for r in rr],color=color,alpha=.2)
        obs=[r for r in observed if r['network']==n and r['phase']=='total' and r['job'].startswith('full-')]
        axes[0].scatter([int(r['bytes'])/1e6 for r in obs],[int(r['gas'])*1e-9 for r in obs],s=15,color=color)
        axes[1].scatter([int(r['bytes'])/1e6 for r in obs],[float(r['client_time_excluding_long_gaps_s'])/3600 for r in obs],s=15,color=color)
    for ax in axes:
        ax.set(xscale='log',yscale='log',xlabel='Artifact size (MB)')
        ax.axvline(.316712,color='gray',ls=':',lw=1)
        ax.tick_params(labelsize=8)
    axes[0].set(ylabel='Native-token units at 1 gwei/gas',title='(a) Common-price cost scenario')
    axes[1].set(ylabel='Conditional client duration (h)',title='(b) Historical operating regimes')
    fig.legend(loc='outside lower center',ncol=3,fontsize=8)
    fig.savefig(PAPER/'img/corpus-cost-time.pdf');plt.close(fig)
    return {'cost_time_model_corpus_files':60,'cost_time_model_phase_rows':len(rows),
            'cost_time_projection_size_bytes':[int(r['bytes']) for r in selected],
            'cost_time_model_scope':'Direct-Identity only; explicit historical client regimes and common 1-gwei sensitivity scenario.',
            'cost_time_source_hashes_verified':len(provenance['inputs'])+len(provenance['outputs'])}
