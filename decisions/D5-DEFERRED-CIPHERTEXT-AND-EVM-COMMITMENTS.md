# D5 — Deferred Ciphertext Publication and the Segmented EVM Profile

**Status:** decided and implemented locally  
**Date:** 21 August 2026

## Decision

The abstract OVC protocol and its bounded-transaction implementation are specified as separate
layers.

### Abstract OVC protocol

For plaintext artifact `G`, key `K`, nonce `N`, and ciphertext `C`:

\[
C = \operatorname{Enc}_K(N,G), \qquad
h_G = \operatorname{Com}_G(G), \qquad
h_C = \operatorname{Com}_C(C).
\]

The Consumer posts `h_G`, `h_C`, `N`, and the public claim before bidding. After selecting a
Provider, the Consumer publishes `C`; binding can occur only if the published value verifies
against `h_C`. Chunking is not an abstract OVC action or security assumption.

The ordering is:

```text
DemandCommitted -> Bidding -> ProviderSelected -> CiphertextPublished
    -> ProviderBound -> Accepted | Disputed
```

If no Provider is selected, the Consumer never pays the ciphertext-publication cost. If the
Consumer stops after selection, no OVC claims have yet been created and the Provider is not bound.
Any marketplace consequence for abandonment remains outside OVC.

### Segmented EVM profile

Solidity realizes `Com` with deterministic, domain-separated segmented commitments because a
large artifact cannot be processed in one bounded EVM transaction. For domain `d`, total byte
length `n`, implementation chunk size `z`, and `m = ceil(n/z)`:

\[
r_0 = H(d \mathbin\| n \mathbin\| z \mathbin\| m),
\]

\[
r_{i+1} = H(r_i \mathbin\| i \mathbin\| |X_i| \mathbin\| X_i),
\qquad \operatorname{Com}^{EVM}_d(X;z)=r_m.
\]

All scalar fields use fixed-width EVM encoding. Separate `OVC_PLAINTEXT_V1` and
`OVC_CIPHERTEXT_V1` domains prevent cross-type reuse. The contract enforces sequential indices,
exact non-final and final chunk lengths, total bytes, chunk count, and equality between the
computed and bidding commitments.

`z` is bounded by an immutable deployment-specific `maxChunkSize`; it is not universal across
chains. Public pure functions expose the exact seed and step functions as a reference oracle,
while normal clients calculate the same commitment locally.

## Cost implication

Let `U_C(n, omega)` be the ciphertext-publication cost in execution environment `omega`, and let
`p_B` be the probability that a demand reaches Provider selection. Eager publication incurs
`U_C`; deferred publication has expected cost:

\[
\mathbb{E}[U_C^{deferred}] = p_B U_C,
\]

so the expected avoided cost is `(1-p_B)U_C`. For EVM calibration only, `U_C` may be expanded as
a function of `z` and `ceil(n/z)`.

## Implementation

- `SegmentedCommitment.sol` defines the canonical EVM construction.
- `Demand.sol` separates bidding, binding preparation, and verified publication.
- `BindingPhase.sol` binds only the selected Provider and prevents duplicate binding.
- Identity, Conformance, and Feature use the same plaintext commitment profile.
- JavaScript reference code and experiment runners reproduce the Solidity encoding exactly.

Results produced before D5 remain historical pre-D5 evidence. Network chunk limits and duration
measurements must be regenerated because the transaction sequence and hashing gas changed.
