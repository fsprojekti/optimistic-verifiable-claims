# D2 — Public Access validation using sealed Demand inputs

**Date:** 14 October 2026. **Status:** complete; all nine jobs Valid and all 117 receipts independently audited.

## Scope authorized by the owner

Execute the repaired Access profile on Sepolia, Arbitrum Sepolia and MegaETH testnet using the
existing research account. Test the three complete frozen paired artifacts already measured in
the public Identity campaign. The public key handover and Access predicate now replace the earlier
placeholder linkage; previous public Identity receipts do not count as Access validation.

## Reuse without another ciphertext upload

Each public Identity job already has a sealed Demand containing the exact canonical ciphertext
and selected research account. The new campaign checks the source posting receipt, bytecode
identities, artifact hash, commitments, nonce, dimensions, consumer and selected Provider before
using that Demand. It deploys the current Access/coordinator profile, binds against the unchanged
Demand, verifies real RSA-OAEP handover and recovers every byte from the stored ciphertext.

The Access dispute then reveals K and the OAEP seed and verifies actual public re-encryption.
Only Access is disputed. Identity, Conformance and Feature are instantiated by BindingPhase but
their predicates are not executed in this campaign. There is no second publication cost and no
claim that these receipts measure a newly uploaded complete four-dispute pipeline.

Consumer and Provider share the same test EOA, while RSA recipient keys are separately generated.
Distinct-account access rules are covered by the local tests. Artifact keys are already public
fixtures from the Identity campaign, so this campaign validates cryptographic functionality and
network execution rather than secrecy of real customer data.

## Reliability and accounting

The signed transaction outbox and random RSA opening persist only under Git-ignored `.secrets/`.
Public exports redact pending signed bytes and never contain RSA private keys. Every operation
is journalled before broadcast and reused after confirmation. The reserve guard retains 0.005
native test ETH. The planned matrix has 13 successful operations per job, 39 per network, 117 total.

The MegaETH first attempt used an incorrect Arbitrum-sized 32M budget and stopped before signing
any transaction. Its RPC estimated Access deployment at 81,060,795 gas. The v2 runner uses the
existing 200M MegaETH profile, while the two already active original-version workers remain intact.
This is a runner budget correction; contract bytecode and pending signed transactions are unchanged.
The empty unused journal, old runner source and correction provenance are retained.

An independent read-only audit verifies receipts, gas, fees, actors, claim outcomes, bytecode
identities and the RSA envelope reconstructed from the public dispute opening. Final acceptance
requires nine Valid jobs and 117 unique successful receipts. Test-token fees include the new
deployments/setup but omit the earlier Demand deployment and publication. They are not a mainnet
price model or a like-for-like comparison with the full Identity campaign's total fees.

## References

- Campaign: `results/access-testnets/2026-10-14/`
- Independent audit: `code/scripts/audit-testnet-access.js`
- Launch/resume: repository-root `scripts/run-stage04-access-testnets.ps1`
- Local runner validation: `results/validation/access-runner-validation.json` (three passing checks)

## Accepted outcome

The final RPC audit reports nine Valid jobs and 117 distinct successful receipts with no errors.
Each network completed three jobs and 39 transactions. Access challenge-plus-reveal gas was
601,050-601,062 on Sepolia, 510,742 on Arbitrum Sepolia and 628,422 on MegaETH. Native test-token
fees including new deployments/setup were 0.000305374685462658, 0.000945311065224 and
0.001822378662, respectively. The last Sepolia job completed at 15:30 UTC on 14 October.
The Sepolia Prusa RPC interruption recovered the already accepted binding transaction; no
successful operation was duplicated. Earlier incomplete audit evidence is preserved separately.
