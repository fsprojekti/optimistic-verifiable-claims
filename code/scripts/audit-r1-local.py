"""Reconcile R1 CSVs, streamed receipts and independently archived local RPC receipts."""
import csv
import gzip
import hashlib
import json
import math
from pathlib import Path

STAGE = Path(__file__).resolve().parents[2]
ROOT = STAGE / 'results/raw-data/r1-selection-2026-10-15'
OPS = ['depositCiphertextChunk', 'conformanceDepositChunk', 'featureDepositChunk',
       'processChunk', 'conformanceProcessChunk', 'featureProcessChunk']
NAMES = ['Ciphertext upload', 'Conformance deposit', 'Feature deposit',
         'Identity', 'Conformance', 'Feature']
REVEALED_TOPIC = '0x040e2b6384d25e884a666584eca61cb9ff8ddafedc9bca922f516a670e1f0881'

def read_csv(path):
    with path.open(encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))

def write_csv(path, rows):
    with path.open('w', encoding='utf-8', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)

def main():
    manifest = json.loads((ROOT/'campaign.json').read_text())
    assert manifest['status'] == 'complete'
    for relative, expected in manifest['source_sha256'].items():
        assert hashlib.sha256((STAGE/relative).read_bytes()).hexdigest() == expected,relative
    by_process = []
    cases = []
    all_receipts = []
    seen = set()
    input_hashes = {}
    verified_verdicts = 0
    checkpoint = json.loads((ROOT/'node-checkpoint.json').read_text()) if (ROOT/'node-checkpoint.json').exists() else {}
    cache_path = ROOT/'rpc-receipts-before-restart.json'
    assert hashlib.sha256(cache_path.read_bytes()).hexdigest()==checkpoint['rpc_receipt_archive_sha256']
    initial_cache = json.loads(cache_path.read_text())
    assert len(initial_cache)==checkpoint['verified_receipts']
    driver = manifest['isolated_driver']
    assert hashlib.sha256((STAGE/driver['path']).read_bytes()).hexdigest()==driver['sha256']
    for name, status in manifest['cases'].items():
        assert status['status'] == 'complete'
        directory = ROOT/name
        metadata = json.loads((directory/'run-metadata.json').read_text())
        tx = read_csv(directory/'r1-chunk-selection-transactions.csv')
        streamed = [json.loads(line) for line in (directory/'receipts.jsonl').read_text().splitlines()]
        assert len(tx) == len(streamed) == metadata['successful_receipts']
        if name in checkpoint.get('node_epoch_1_cases',[]):
            epoch = 'initial-node'
            receipt_cache = initial_cache
        else:
            rpc_audit = json.loads((directory/'rpc-audit.json').read_text())
            archive = directory/'rpc-receipts.json.gz'
            assert hashlib.sha256(archive.read_bytes()).hexdigest()==rpc_audit['receipt_archive_sha256']
            receipt_cache = json.loads(gzip.decompress(archive.read_bytes()))
            assert len(receipt_cache)==rpc_audit['verified_receipts']==len(tx)
            epoch = rpc_audit['node_instance']
        for row, stream in zip(tx,streamed):
            assert all(str(stream[k]) == str(v) for k,v in row.items()),name
            assert int(row['status']) == 1 and (epoch,row['tx_hash']) not in seen
            seen.add((epoch,row['tx_hash']))
            receipt = receipt_cache[row['tx_hash']]
            assert receipt['transactionHash']==row['tx_hash']
            assert int(receipt['status'],16)==1 and int(receipt['gasUsed'],16)==int(row['gas_used'])
            assert int(receipt['blockNumber'],16)==int(row['block_number'])
            if row['operation'] in ['finalizeAdjudication','conformanceFinalizeAdjudication','featureFinalizeAdjudication','accessRevealWitness']:
                verdicts=[log for log in receipt['logs'] if log['topics'] and log['topics'][0]==REVEALED_TOPIC and log['address'].lower()==receipt['to'].lower()]
                assert len(verdicts)==1 and int(verdicts[0]['data'],16)==2,(name,row['operation'])
                verified_verdicts+=1
        all_receipts.extend(dict(r,node_epoch=epoch) for r in tx)
        summaries = read_csv(directory/'r1-chunk-selection-summary.csv')
        predicates = read_csv(directory/'r1-chunk-selection-predicates.csv')
        assert len(summaries)==3 and len(predicates)==12
        assert all(r['outcome']=='Valid' for r in summaries+predicates)
        for s in summaries:
            artifact = s['artifact_key']; n=int(s['size_bytes']); z=int(s['chunk_size_bytes'])
            assert int(s['chunk_count'])==math.ceil(n/z)
            input_hashes.setdefault(artifact,s['output_sha256'])
            assert input_hashes[artifact]==s['output_sha256']
            p = {r['predicate']:r for r in predicates if r['artifact_key']==artifact}
            assert set(p)=={'Access','Identity','Conformance','Feature'}
            for operation,label in zip(OPS,NAMES):
                selected = [r for r in tx if r['artifact_key']==artifact and r['operation']==operation]
                assert [int(r['chunk_index']) for r in selected]==list(range(math.ceil(n/z)))
                gas = [int(r['gas_used']) for r in selected]
                by_process.append({'case':name,'mode':metadata['mode'],'artifact':artifact,
                                   'artifact_bytes':n,'chunk_bytes':z,'chunks':len(gas),'process':label,
                                   'total_gas':sum(gas),'gas_per_byte':sum(gas)/n,
                                   'maximum_transaction_gas':max(gas),
                                   'within_reference_95_percent':max(gas)*100<=16777216*95})
                if label in ['Identity','Conformance','Feature']:
                    assert sum(gas)==int(p[label]['process_gas'])
                    assert max(gas)==int(p[label]['max_process_tx_gas'])
            assert int(s['upload_gas'])==sum(int(r['gas_used']) for r in tx if r['artifact_key']==artifact and r['operation']=='depositCiphertextChunk')
            assert int(s['identity_processing_gas'])==int(p['Identity']['process_gas'])
        current = [r for r in by_process if r['case']==name]
        cases.append({'case':name,'mode':metadata['mode'],'chunk_bytes':metadata['chunk_size_bytes'],
                      'artifacts':3,'valid_outcomes':12,'successful_recorded_transactions':len(tx),
                      'maximum_chunk_transaction_gas':max(r['maximum_transaction_gas'] for r in current),
                      'within_reference_95_percent':all(r['within_reference_95_percent'] for r in current)})
    feasible=[r['chunk_bytes'] for r in cases if r['mode']=='segmented' and r['within_reference_95_percent']]
    assert len(cases)==14 and verified_verdicts==168
    frozen={f"{r['model_id']}:{r['slicer']}":r['output_sha256'] for r in read_csv(STAGE/'data/corpus/generated/gcode-manifest.csv')}
    assert all(frozen[name]==value for name,value in input_hashes.items())
    baseline=read_csv(STAGE/'results/raw-data/stage03-d5-canonical-3072/real-corpus-anvil-predicates.csv')
    repeated={(r['artifact_key'],r['predicate']):r for r in read_csv(ROOT/'chunk-3072/r1-chunk-selection-predicates.csv')}
    for original in baseline:
        current=repeated[original['artifact_key'],original['predicate']]
        for key in ['deposit_gas','process_gas','max_process_tx_gas']:
            assert current[key]==original[key]
    largest=max(feasible)
    next_tested=min(r['chunk_bytes'] for r in cases if r['mode']=='segmented' and r['chunk_bytes']>largest)
    write_csv(ROOT/'process-summary.csv',by_process)
    write_csv(ROOT/'case-summary.csv',cases)
    report={'cases':len(cases),'valid_outcomes':sum(r['valid_outcomes'] for r in cases),
            'receipt_event_valid_verdicts_verified':verified_verdicts,
            'original_3072_predicate_profiles_reproduced_exactly':len(baseline),
            'rpc_verified_receipts':len(all_receipts),'rpc_receipts_verified_before_node_restart':len(initial_cache),'input_sha256':input_hashes,
            'transaction_identity':'Local node instance plus transaction hash; receipts independently re-fetched and archived before each node shutdown.',
            'reference_budget':16777216,'fill_factor':0.95,
            'largest_tested_common_feasible_chunk_bytes':largest,
            'next_tested_infeasible_chunk_bytes':next_tested,
            'scope':'Three paired outputs of one geometry; local Cancun execution. Largest tested feasible candidate, not a proof for arbitrary inputs or public-network gas schedules.',
            'evidence_sha256':{p.relative_to(ROOT).as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(ROOT.rglob('*')) if p.is_file() and p.name not in ['audit.json','runner.log']}}
    (ROOT/'audit.json').write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({k:v for k,v in report.items() if k!='evidence_sha256'},indent=2))

if __name__=='__main__':
    main()
