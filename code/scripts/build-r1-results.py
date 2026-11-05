"""Generate the extended R1 figures/tables exclusively from audited local receipts."""
import csv
import json
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

STAGE = Path(__file__).resolve().parents[2]
RAW = STAGE/'results/raw-data/r1-selection-2026-10-15'
PAPER = STAGE/'paper/latex'

def read(path):
    with path.open(newline='',encoding='utf-8') as f:
        return list(csv.DictReader(f))

def generate(table):
    audit=json.loads((RAW/'audit.json').read_text())
    rows=read(RAW/'process-summary.csv')
    sizes=sorted({int(r['chunk_bytes']) for r in rows if r['mode']=='segmented'})
    artifacts=sorted({r['artifact'] for r in rows})
    assert len(artifacts)==3 and audit['valid_outcomes']==168
    labels={a:a.split(':')[1].capitalize() for a in artifacts}
    selected=audit['largest_tested_common_feasible_chunk_bytes']
    budget=audit['reference_budget']*audit['fill_factor']
    processes=['Ciphertext upload','Conformance deposit','Feature deposit','Identity','Conformance','Feature']
    maxima={(z,p):max(int(r['maximum_transaction_gas']) for r in rows if r['mode']=='segmented' and int(r['chunk_bytes'])==z and r['process']==p) for z in sizes for p in processes}
    assert max(maxima[(selected,p)] for p in processes)<=budget
    whole=[r for r in rows if r['mode']=='whole-file-single-chunk']
    whole_rows=[]
    for a in artifacts:
        data={r['process']:r for r in whole if r['artifact']==a}
        assert all(int(r['chunks'])==1 for r in data.values())
        whole_rows.append([labels[a],f'{int(data["Identity"]["artifact_bytes"]):,}',*[f'{int(data[p]["maximum_transaction_gas"])/1e6:.3f}' for p in ['Ciphertext upload','Identity','Conformance','Feature']]])
    table('r1-whole-file.tex','Whole-file execution of the current production kernels on the three frozen corpus inputs. Each listed operation carries the complete artifact in one chunk; gas is in millions (M).','tab:r1-whole','lrrrrr',
          ['Slicer','Bytes','Upload','Identity','Conf.','Feature'],whole_rows,
          r'Each artifact completed with Valid outcomes for all four claims. These are separate upload and processing transactions, with publication and setup preceding adjudication; they are not a single transaction executing the entire protocol. The local 10-billion-gas block limit permits measurement above the deployment reference budget.',placement='!htb')
    table('chunk-selection.tex','Maximum gas per chunk across all chunks of the three paired corpus inputs at each measured size. Gas is in millions (M).','tab:chunk-selection','rrrrr',
          ['Bytes','Upload','Identity','Conf.','Feature'],
          [[f'{z:,}',*[f'{maxima[(z,p)]/1e6:.3f}' for p in ['Ciphertext upload','Identity','Conformance','Feature']]] for z in sizes],
          r'All configurations completed with Valid outcomes on the raised-limit local node. Public-budget feasibility is assessed separately. Plaintext deposits are included in the common-size constraint; their individual bounds appear in Table~\ref{tab:chunk-process-bounds}.',placement='!htb')
    bounds=[]
    for p in processes:
        feasible=[z for z in sizes if maxima[(z,p)]<=budget]
        largest=max(feasible)
        higher=[z for z in sizes if z>largest]
        bounds.append([p,f'{largest:,}',f'{min(higher):,}' if higher else 'Not bracketed',f'{maxima[(largest,p)]/1e6:.3f}'])
    table('chunk-process-bounds.tex',r'Largest tested feasible chunk for each process under the 95\% reference budget (15.938 million gas).','tab:chunk-process-bounds','lrrr',
          ['Process','Bytes','Next tested','Gas (M)'],bounds,
          r'For a bracketed row, the next tested size exceeds the budget. Bounds describe the measured candidate set and three paired inputs, not all byte sizes or arbitrary G-code. All processes must use one common size; Identity supplies the limiting observed bound.',placement='!htb')
    plt.rcParams.update({'font.family':'DejaVu Sans','font.size':9,'axes.spines.top':False,'axes.spines.right':False,'pdf.fonttype':42,'savefig.bbox':'tight'})
    colors={'Ciphertext upload':'#8f63ad','Identity':'#205493','Conformance':'#b96c29','Feature':'#207866'}
    fig,axes=plt.subplots(1,2,figsize=(7.1,3.25),layout='constrained')
    for p,color in colors.items():
        per_byte=[]
        for z in sizes:
            subset=[r for r in rows if r['mode']=='segmented' and int(r['chunk_bytes'])==z and r['process']==p]
            per_byte.append(sum(int(r['total_gas']) for r in subset)/sum(int(r['artifact_bytes']) for r in subset))
        axes[0].plot([z/1024 for z in sizes],per_byte,'o-',ms=3,color=color,label=p)
        axes[1].plot([z/1024 for z in sizes],[maxima[(z,p)]/1e6 for z in sizes],'o-',ms=3,color=color)
    for ax in axes:
        ax.set_xscale('log',base=2)
        ax.set_xticks([1,2,4,8,16,32,64,128],['1','2','4','8','16','32','64','128'])
        ax.set_xlabel('Chunk size (KiB)')
        ax.axvline(selected/1024,color='gray',ls=':',lw=1)
    axes[0].set(ylabel='Measured gas per artifact byte',yscale='log',title='(a) Complete-file specific cost')
    axes[1].set(ylabel='Maximum transaction gas (millions)',yscale='log',title='(b) Per-chunk execution demand')
    axes[1].axhline(budget/1e6,color='#b44a35',ls='--',lw=1)
    axes[1].text(0.02,0.94,'Dashed: 95% reference budget',transform=axes[1].transAxes,va='top',fontsize=7)
    fig.legend(loc='outside lower center',ncol=4,fontsize=7)
    fig.savefig(PAPER/'img/d5-chunk-spectrum.pdf');plt.close(fig)
    fig,ax=plt.subplots(figsize=(6.5,2.9),layout='constrained')
    for p,color in colors.items():
        data=sorted([r for r in whole if r['process']==p],key=lambda r:int(r['artifact_bytes']))
        ax.plot([int(r['artifact_bytes'])/1024 for r in data],[int(r['maximum_transaction_gas'])/1e6 for r in data],'o-',color=color,label=p)
    ax.axhline(budget/1e6,color='#b44a35',ls='--',lw=1,label='95% reference budget')
    ax.set(xlabel='Complete artifact size (KiB)',ylabel='Gas per whole-file operation (millions)',yscale='log')
    ax.legend(fontsize=7,ncol=2)
    fig.savefig(PAPER/'img/r1-whole-file.pdf');plt.close(fig)
    return {'r1_extended_cases':audit['cases'],'r1_extended_valid_outcomes':audit['valid_outcomes'],
            'r1_extended_rpc_verified_receipts':audit['rpc_verified_receipts'],
            'r1_largest_tested_common_chunk_bytes':selected,'r1_next_tested_infeasible_chunk_bytes':audit['next_tested_infeasible_chunk_bytes'],
            'historical_d5_largest_tested_identity_chunk_bytes_within_budget':4096,
            'r1_largest_tested_identity_chunk_bytes_within_budget':max(z for z in sizes if maxima[(z,'Identity')]<=budget),
            'r1_candidate_sizes_bytes':sizes,'r1_common_optimum_established':True,
            'r1_optimum_scope':'Largest tested feasible candidate on three paired corpus inputs under local Cancun gas accounting and the 95% reference budget.'}
