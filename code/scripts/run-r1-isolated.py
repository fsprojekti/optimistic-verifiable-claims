"""Continue the frozen R1 matrix with a fresh local Anvil instance per case.

All receipts are independently re-fetched and archived before the instance stops.
Contract code, candidate sizes and validation remain those of run-r1-local.py.
"""
import csv
import gzip
import hashlib
import json
import os
from pathlib import Path
import runpy
import subprocess
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen

BASE = runpy.run_path(str(Path(__file__).with_name('run-r1-local.py')))
STAGE, PROJECT, CODE, OUT, SIZES = [BASE[k] for k in ['STAGE','PROJECT','CODE','OUT','SIZES']]
ANVIL = Path(os.environ['USERPROFILE'])/'.foundry/bin/anvil.exe'

def now(): return datetime.now(timezone.utc).isoformat()
def save(p,v): p.write_text(json.dumps(v,indent=2)+'\n',encoding='utf-8')
def rpc(payload):
    with urlopen(Request('http://127.0.0.1:19545',data=json.dumps(payload).encode(),headers={'Content-Type':'application/json'}),timeout=120) as f:
        return json.load(f)

def main():
    manifest_path=OUT/'campaign.json'
    manifest=json.loads(manifest_path.read_text())
    for rel,expected in manifest['source_sha256'].items():
        assert hashlib.sha256((STAGE/rel).read_bytes()).hexdigest()==expected,rel
    manifest['isolated_driver']={'path':Path(__file__).relative_to(STAGE).as_posix(),
                                 'sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                                 'anvil_sha256':hashlib.sha256(ANVIL.read_bytes()).hexdigest(),
                                 'reason':'Fresh node per independent case avoids increasing state-management overhead; per-case receipts audited before shutdown.'}
    manifest['status']='running';save(manifest_path,manifest)
    for size in SIZES:
        name='whole-file' if size=='whole' else f'chunk-{size}'
        d=OUT/name;result=d/'r1-chunk-selection-predicates.csv'
        if result.exists():
            with result.open() as f:rows=list(csv.DictReader(f))
            assert len(rows)==12 and all(r['outcome']=='Valid' for r in rows)
            meta=json.loads((d/'run-metadata.json').read_text())
            assert meta.get('completed_at')
            manifest['cases'][name]={'status':'complete','completed_at':meta['completed_at'],'receipts':meta['successful_receipts']}
            save(manifest_path,manifest)
            continue
        assert not (d/'receipts.jsonl').exists(), f'Preserve and inspect incomplete {name}'
        d.mkdir(parents=True,exist_ok=True)
        manifest['cases'][name]={'status':'running','started_at':now(),'node_instance':name}
        save(manifest_path,manifest)
        print(f'{now()} START {name} (fresh local node)',flush=True)
        flags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0
        node=subprocess.Popen([str(ANVIL),'--host','127.0.0.1','--port','19545','--chain-id','31337',
                               '--hardfork','cancun','--gas-limit','10000000000','--balance','1000000',
                               '--prune-history','1','--silent'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=flags)
        try:
            for attempt in range(40):
                assert node.poll() is None,'Anvil exited; check port ownership'
                try:
                    r=rpc({'jsonrpc':'2.0','id':1,'method':'web3_clientVersion','params':[]})
                    if 'anvil' in r.get('result','').lower():break
                except OSError:pass
                time.sleep(.25)
            else:raise RuntimeError('Local node did not start')
            env=os.environ.copy()
            env.update(OVC_R1_ENABLED='1',LOCALHOST_RPC_URL='http://127.0.0.1:19545',
                       OVC_CORPUS_ROOT=str(PROJECT/'_local-tools/ovc-d5-canonical-corpus'),
                       OVC_PILOT_FILES='3',OVC_PILOT_CHUNK_BYTES=str(size if size!='whole' else 4096),
                       OVC_R1_WHOLE_FILE='1' if size=='whole' else '0',OVC_PILOT_OUTPUT_SUBDIR=f'r1-selection-2026-10-15/{name}')
            with (d/'runner.log').open('w',encoding='utf-8') as log:
                proc=subprocess.Popen(['node','node_modules/hardhat/internal/cli/cli.js','test','tests/pilot/r1-chunk-selection.js','--network','localhost','--no-compile'],cwd=CODE,env=env,stdout=log,stderr=subprocess.STDOUT,creationflags=flags)
                while proc.poll() is None:
                    time.sleep(10)
                    p=d/'receipts.jsonl'
                    if p.exists():
                        lines=p.read_text().splitlines()
                        if lines:
                            r=json.loads(lines[-1]);print(f'{now()} {name}: {len(lines)} receipts; {r["slicer"]} {r["operation"]} {r["chunk_index"]}',flush=True)
            assert proc.returncode==0 and result.exists(),f'{name} failed; inspect runner.log'
            with result.open() as f:outcomes=list(csv.DictReader(f))
            assert len(outcomes)==12 and all(r['outcome']=='Valid' for r in outcomes)
            with (d/'r1-chunk-selection-transactions.csv').open() as f:rows=list(csv.DictReader(f))
            receipts={}
            for offset in range(0,len(rows),100):
                group=rows[offset:offset+100]
                reply=rpc([{'jsonrpc':'2.0','id':i,'method':'eth_getTransactionReceipt','params':[r['tx_hash']]} for i,r in enumerate(group)])
                for item in reply:
                    r=group[item['id']];receipt=item['result']
                    assert receipt['transactionHash']==r['tx_hash'] and int(receipt['status'],16)==1
                    assert int(receipt['gasUsed'],16)==int(r['gas_used'])
                    assert int(receipt['blockNumber'],16)==int(r['block_number'])
                    assert r['tx_hash'] not in receipts
                    receipts[r['tx_hash']]=receipt
            archive=d/'rpc-receipts.json.gz'
            archive.write_bytes(gzip.compress(json.dumps(receipts,sort_keys=True).encode(),mtime=0))
            save(d/'rpc-audit.json',{'verified_at':now(),'node_instance':name,'verified_receipts':len(receipts),
                                   'receipt_archive_sha256':hashlib.sha256(archive.read_bytes()).hexdigest(),
                                   'client_version':r'Anvil 1.7.1','hardfork':'cancun','block_gas_limit':10000000000,'prune_history':1})
            meta=json.loads((d/'run-metadata.json').read_text())
            manifest['cases'][name].update(status='complete',completed_at=meta['completed_at'],receipts=len(rows),rpc_audited=True)
            save(manifest_path,manifest)
            print(f'{now()} COMPLETE {name}: 12 Valid outcomes; {len(receipts)} audited receipts',flush=True)
        finally:
            node.terminate();node.wait(timeout=20)
    for rel,expected in manifest['source_sha256'].items():
        assert hashlib.sha256((STAGE/rel).read_bytes()).hexdigest()==expected,rel
    manifest.update(status='complete',completed_at=now());save(manifest_path,manifest)
    print('R1 matrix complete; all new-node receipts archived and verified.',flush=True)

if __name__=='__main__':main()
