# Public Access validation — 14 October 2026

This campaign executes the repaired Stage 04 RSA-OAEP Access profile on Sepolia,
Arbitrum Sepolia and MegaETH testnet. Its planned matrix is three paired slicer outputs
(Cura, Orca, Prusa `rackstack_hinge`) on each network: nine Access jobs.

**Final status:** 9/9 Valid; 117 independently verified successful receipts (39 per network),
with no RPC-audit errors. See `rpc-audit.json` and `access-comparison.csv`.

## Procedure and scope

Each job reuses its completed public Identity campaign's sealed Demand. Its original source
checkpoint and artifact hash are checked before submission. Ciphertext is not uploaded again.
Five new contracts are deployed: Access, Identity, Conformance, Feature and BindingPhase.
Four coordinator registrations, Provider key registration, binding, Access challenge and witness
reveal complete the 13-operation sequence. Other claim contracts are instantiated but not disputed.

The runner registers a real RSA-2048 encryption key, binds the encrypted artifact key to it,
decrypts the on-chain envelope with the generated private key, reads every ciphertext chunk
from the existing Demand and recovers the complete frozen artifact. An unrelated RSA private
key is also required to fail recipient decryption. It then challenges Access and reveals the
key/seed opening so the EVM can check public RSA-OAEP re-encryption and reach Valid.

Consumer and Provider share the existing research EOA in this public fixture; separate-account
authorization is tested locally. Artifact keys are the already disclosed Identity fixture keys.
These runs validate functional handover and public adjudication, not secrecy of production data.
Fees exclude prior Demand deployment/publication and include the new job deployments/setup.
This is not a fresh complete-workflow gas measurement or a public run of all four disputes.

## Recovery and evidence

Public per-job JSON exports never contain signed raw transactions, RSA private keys or
undisclosed opening material. The resumable signed outbox and RSA material are under the
Git-ignored `.secrets/stage04-access-2026-10-14/`. Confirmed operations are reused on restart.
The funds guard preserves 0.005 native test ETH. Pacing and any restarts are recorded.

Sepolia and Arbitrum use the original runner version. MegaETH uses v2 with the existing
200-million-gas MegaETH budget; its initial attempt used an incorrect 32-million budget and
stopped before signing any transaction. The unused empty journal and budget adjustment record
are preserved. Neither contracts nor the two already running workers were changed for this fix.

`status.json` under each network records current campaign progress. Successful job files are
`cura.json`, `orca.json` and `prusa.json`. Completion is claimed only for jobs with Valid,
all 13 successful operations, full artifact recovery and a confirmed final claim.

## Independent audit and reproduction

From the stage's `code/` directory:

```powershell
node scripts/audit-testnet-access.js --require-complete
```

This independently re-reads every successful receipt, verifies gas, fees, actors and operation
coverage, and checks the live final Access claim. Using the public dispute opening, it also
reconstructs RSA-OAEP ciphertext independently and checks the bound envelope and linkage.
It writes `rpc-audit.json` and `access-comparison.csv` without signing or sending transactions.
`--require-complete` requires all nine jobs and fails if any audit check fails.

To start or resume the campaign, use `scripts/run-stage04-access-testnets.ps1` from the repository
root. It selects the matching runner version for existing journals and rejects an already active
worker on that network. Sepolia uses the previously authorized dRPC endpoint.
