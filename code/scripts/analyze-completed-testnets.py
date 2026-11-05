"""Reconcile completed checkpoint/CSV evidence and compare like-for-like phases."""
import csv
import hashlib
import json
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

STAGE = Path(__file__).resolve().parents[2]
ROOT = STAGE / 'results/raw-data/duration-campaigns/d5-recovery-2026-10-12'
OUTPUT = ROOT / 'analysis'


def read_csv(path):
    with Path(path).open(encoding='utf-8-sig', newline='') as stream:
        return list(csv.DictReader(stream))


def main():
    local = {r['slicer']: r for r in read_csv(STAGE / 'results/raw-data/stage03-d5-canonical-3072/real-corpus-anvil-summary.csv')}
    fees = defaultdict(int)
    counts = defaultdict(int)
    seen = set()
    rows = []
    evidence = []
    bytecodes = None
    for network in ['sepolia', 'arbitrumSepolia', 'megaethTestnet']:
        for job in ['smoke-cura-6144', 'full-cura', 'full-orca', 'full-prusa']:
            file = ROOT / network / f'{job}.checkpoint.json'
            checkpoint = json.loads(file.read_text(encoding='utf-8'))
            identity = checkpoint['identity']
            assert checkpoint['outcome'] == 'Valid', (network, job)
            assert identity['network'] == network
            assert identity['chain_id'] == {'sepolia': '11155111', 'arbitrumSepolia': '421614', 'megaethTestnet': '6343'}[network]
            if bytecodes is None:
                bytecodes = identity['bytecodes']
            assert identity['bytecodes'] == bytecodes
            chunks = (identity['sample_bytes'] + 3071) // 3072
            expected = {'deployDemand', 'deployOVCIdentitySegmented', 'setCoordinator', 'postDemand',
                        'prepareBinding', 'sealCiphertext', 'commitClaim', 'setDemand', 'configureWitnessTerms',
                        'disputeClaim', 'revealKey', 'startAdjudication', 'finalizeAdjudication'}
            expected |= {f'{prefix}[{i}]' for prefix in ['depositCiphertextChunk', 'processChunk'] for i in range(chunks)}
            operations = checkpoint['operations']
            assert set(operations) == expected
            transactions = read_csv(checkpoint['transaction_csv_path'])
            summary = read_csv(checkpoint['summary_path'])[0]
            assert len(transactions) == len(expected)
            assert {t['operation'] for t in transactions} == expected
            for tx in transactions:
                op = operations[tx['operation']]
                assert op['status'] == int(tx['status']) == 1
                assert op['hash'] == tx['tx_hash']
                assert int(op['gas_used']) == int(tx['gas_used'])
                assert int(op['block_number']) == int(tx['block_number'])
                assert (network, op['hash']) not in seen
                seen.add((network, op['hash']))
            protocol = {k: v for k, v in operations.items() if not k.startswith('deploy') and k != 'setCoordinator'}
            gas = sum(int(v['gas_used']) for v in protocol.values())
            assert gas == int(summary['protocol_gas'])
            assert len(protocol) == int(summary['protocol_transaction_count'])
            assert summary['outcome'] == 'Valid'
            total_fee = sum(int(v['fee_wei']) for v in operations.values())
            fees[network] += total_fee
            counts[network] += len(operations)
            for input_file in [file, Path(checkpoint['transaction_csv_path']), Path(checkpoint['summary_path'])]:
                evidence.append({'path': str(input_file.relative_to(STAGE)), 'sha256': hashlib.sha256(input_file.read_bytes()).hexdigest()})
            if job.startswith('full-'):
                slicer = job[5:]
                baseline = local[slicer]
                assert identity['artifact_sha256'] == baseline['output_sha256']
                assert identity['sample_bytes'] == int(baseline['size_bytes'])
                upload = sum(int(v['gas_used']) for k, v in operations.items() if k.startswith('depositCiphertextChunk['))
                processing = sum(int(v['gas_used']) for k, v in operations.items() if k.startswith('processChunk['))
                rows.append({'network': network, 'slicer': slicer, 'bytes': identity['sample_bytes'],
                             'chunks': chunks, 'transactions_including_setup': len(operations),
                             'protocol_gas': gas, 'protocol_gas_per_byte': gas / identity['sample_bytes'],
                             'post_demand_gas': int(operations['postDemand']['gas_used']),
                             'ciphertext_upload_gas': upload, 'identity_processing_gas': processing,
                             'upload_share_protocol_percent': 100 * upload / gas,
                             'upload_vs_anvil_ratio': upload / int(baseline['upload_gas']),
                             'processing_vs_anvil_ratio': processing / int(baseline['identity_processing_gas']),
                             'max_processing_transaction_gas': max(int(v['gas_used']) for k, v in operations.items() if k.startswith('processChunk[')),
                             'fee_native_test_eth_including_setup': str(Decimal(total_fee) / Decimal(10**18)),
                             'wall_clock_minutes': int(summary['client_wall_clock_ms']) / 60000,
                             'scheduled_pacing_seconds': int(summary['scheduled_protocol_delay_ms']) / 1000,
                             'launches': checkpoint['launches'], 'timing_interrupted': checkpoint['launches'] > 1,
                             'outcome': 'Valid'})
    report = {'analyzed_at_utc': datetime.now(timezone.utc).isoformat(), 'completed_jobs': 12,
              'unique_successful_transactions': len(seen), 'counts_per_network': dict(counts),
              'fees_native_test_eth_including_smoke_and_setup': {k: str(Decimal(v) / Decimal(10**18)) for k, v in fees.items()},
              'full_artifact_comparisons': rows, 'evidence_sha256': evidence,
              'limitations': ['Three slicer outputs of one geometry, one run per network/workload; smoke jobs are excerpts.',
                              'Public runner is Identity only and uses zero witness reimbursement.',
                              'Local bindProvider coordinates multiple predicates; public Identity uses direct claim setup. Compare matching upload and process phases, not total lifecycle gas as identical experiments.',
                              'Interrupted durations include RPC retries and downtime; Sepolia Cura spans the weekend.',
                              'Native test-token fees are observed testnet fees, not mainnet cost predictions.',
                              'Deterministic fixture key is revealed in adjudication; this is not a confidentiality proof or a private key-delivery test.']}
    OUTPUT.mkdir(exist_ok=True)
    (OUTPUT / 'final-measurements.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    with (OUTPUT / 'full-artifact-comparison.csv').open('w', newline='', encoding='utf-8') as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)
    print(json.dumps({k: report[k] for k in ['completed_jobs', 'unique_successful_transactions', 'counts_per_network', 'fees_native_test_eth_including_smoke_and_setup']}, indent=2))
    for row in rows:
        print(json.dumps({k: row[k] for k in ['network', 'slicer', 'protocol_gas', 'upload_share_protocol_percent', 'upload_vs_anvil_ratio', 'processing_vs_anvil_ratio', 'wall_clock_minutes', 'timing_interrupted']}))


if __name__ == '__main__':
    main()
