# D1 — Access validation and verifiable private key handover

**Date:** 13 October 2026. **Status:** implemented and locally validated in Stage 04.

## Defect reproduced

The inherited BindingPhase created Access with `commitment = H(K)` but zero auxiliary linkage
and zero Provider key hash. Its existing predicate compared `H(K || providerKeyHash)` with that
zero auxiliary field. A binding-created honest Access dispute therefore returned Incorrect.
The pre-fix regression was observed as `expected 4 to equal 2` (Incorrect versus Valid).
Earlier coordinated tests instantiated Access without disputing it. Standalone historical
Access tests supplied nonzero linkage fields and did not cover the coordinator defect.

The real-corpus runner also used `K || nonce` as a public encrypted-key fixture. This was not
private key delivery. Historical measurements remain unchanged and cannot establish secrecy.

## Selected profile

The selected Provider registers its own RSA-2048 public key (DER SPKI, exponent 65537).
Binding pins the registered key and a 256-byte RSAES-OAEP encrypted key envelope. SHA-256 is used
for OAEP and MGF1; the label is the fixed-width encoding of the domain hash, Provider address
and demand ID. Key generation and recipient decryption use Node/OpenSSL.

Let `E = RSAES-OAEP(pk_P, K; seed, label)`, `hP = H(pk_P)` and `hE = H(E)`.
Access pins `H(K)`, `hP`, `hE` and `a = H(K || hP || hE)`. Identity continues to pin the same `H(K)`.
The 64-byte dispute witness is `K || seed`. No Provider private key is disclosed.

On disclosure, Access first checks `H(K)` and returns Inconsistent on mismatch. It then checks
the linkage and reconstructs OAEP encryption using SHA-256 and the EVM modular-exponentiation
precompile. Valid requires the reconstructed envelope hash to equal the envelope hash fixed at
binding. A self-consistent hash linkage around an envelope encrypting the wrong key is therefore
Incorrect. Incorrect seed, envelope or demand context also fails. Refusal and timeout produce
Withheld. Acceptance does not publish either K or the seed.

The Consumer must securely retain the random OAEP opening until acceptance or the end of a
possible dispute. Fresh artifact keys/nonces and OAEP seeds are required for real use. The
Provider is responsible for registering a valid key for which it controls the private key.
Registration authenticates the account choosing the key; it is not a proof of private-key possession.

## Validation and boundaries

- 17 Access integration/adversarial tests pass, including the zero-linkage regression.
- Three RSA tests pass, including 12 randomized comparisons with independent OpenSSL OAEP
  encryption/decryption and malformed-key rejection.
- Three complete frozen corpus inputs pass private handover, full-file recovery and public
  Access adjudication on the local Hardhat chain: Cura, Orca and Prusa `rackstack_hinge`.
- The complete Stage 04 default suite reports 49 passing, one optional Anvil pilot pending.

Each complete-file Access dispute records 52,330 gas for challenge and 458,412 gas for reveal,
510,742 total in this local execution. Registration, deferred publication and binding are separate
operations. The complete three-input validation records 302 successful non-deployment transactions.
These are observed runs, not universal gas constants.

Access and BindingPhase bytecode changed. Demand and Identity bytecode hashes exactly match the
completed public campaign. Its matching upload/Identity phases remain relevant; historical total
binding/lifecycle costs must not be presented as measurements of the new Access binding profile.
There is no public-testnet Access measurement yet, and local validation is not an external
cryptographic audit or a formal security proof.

## Reproduction

From `code/`, run `npm test`. Targeted validation:

```powershell
node node_modules/hardhat/internal/cli/cli.js test tests/access-binding.test.js tests/rsa-oaep.test.js tests/access-real-corpus.test.js
```

Reports: `results/validation/access-validation.json`, `access-real-corpus.json` and
`suite-summary.json`. The real-corpus tests explicitly skip if their ignored G-code inputs have
not been restored from the frozen manifest. RSA private keys and undisclosed opening material
are never written to the reports.

The encoding follows [RFC 8017, section 7.1.1](https://www.rfc-editor.org/rfc/rfc8017.html#section-7.1.1).
Independent recipient checks use [Node crypto RSA/OAEP](https://nodejs.org/api/crypto.html#cryptoprivatedecryptprivatekey-buffer).
