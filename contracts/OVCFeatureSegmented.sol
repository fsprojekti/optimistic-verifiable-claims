// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBaseSegmented.sol";

/**
 * OVC-Feature (segmented)
 *
 * Commitment = H̃(G) — rolling keccak of plaintext G chunks.
 * claimValue  = f_claim (total filament extrusion = final cumulative E-value under
 *               absolute extrusion mode M82, decimal-scaled ×1000, e.g. 6000 = 6.0 mm).
 *               Matches the monolithic OVCFeature predicate E_final(G) == f_claim.
 *
 * G is NOT deposited at binding. Same rationale as OVC-Conformance:
 * Provider gets G via OVC-Identity; G is deposited during dispute window
 * if the Provider challenges. Adjudication requires deposit complete before
 * it can start, ensuring H̃(G) integrity.
 */
contract OVCFeatureSegmented is OVCBaseSegmented {

    mapping(uint256 => uint256) public extrusionState;

    constructor(uint256 _disputeWindowBlocks) OVCBaseSegmented(_disputeWindowBlocks) {}

    // No deposit required at binding — G is revealed only if disputed.
    function acceptClaim(uint256 claimId) external override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function acceptClaimFor(uint256 claimId, address provider) external override onlyCoordinator {
        require(claims[claimId].provider == provider, "Wrong provider");
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function disputeClaim(uint256 claimId) external override onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // G must be fully deposited (H̃(G) == commitment) before adjudication starts.
    function startAdjudication(uint256 claimId) external override onlyClaimant(claimId) {
        require(isDepositComplete(claimId), "Deposit not complete");
        _startAdjudication(claimId);
    }

    // Absolute mode (M82): the final E-value is the cumulative total. Each chunk that
    // contains an E overwrites the running total with that chunk's last E; chunks with no
    // E leave it unchanged. After the last chunk, extrusionState = the witness's final E.
    // (Caveat: an E-number split across a chunk boundary is not reassembled — a known
    // limitation shared by all per-chunk numeric parsing in the segmented design.)
    function _processChunk(
        uint256 claimId,
        Claim storage /* claim */,
        AdjudicationSession storage /* session */,
        bytes storage chunk
    ) internal override {
        (uint256 v, bool found) = _lastEInChunk(chunk);
        if (found) {
            extrusionState[claimId] = v;
        }
    }

    function _finalizePredicate(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage /* session */
    ) internal view override returns (bool) {
        return extrusionState[claimId] == claim.claimValue;
    }

    // Last E-value in this chunk, decimal-scaled ×1000 (E6.0 -> 6000); found=false if none.
    function _lastEInChunk(bytes storage data) internal view returns (uint256 lastValue, bool found) {
        uint256 i = 0;
        uint256 len = data.length;
        while (i < len) {
            if (data[i] == 0x45) { // 'E'
                uint256 j = i + 1;
                uint256 intPart = 0;
                uint256 fracPart = 0;
                uint256 fracScale = 1;
                bool hasDigits = false;
                bool inFraction = false;
                while (j < len) {
                    bytes1 ch = data[j];
                    if (ch >= 0x30 && ch <= 0x39) {
                        hasDigits = true;
                        if (inFraction) {
                            if (fracScale < 1000) {
                                fracPart = fracPart * 10 + uint256(uint8(ch) - 48);
                                fracScale *= 10;
                            }
                        } else {
                            intPart = intPart * 10 + uint256(uint8(ch) - 48);
                        }
                        j++;
                        continue;
                    }
                    if (ch == 0x2e && !inFraction) { // '.'
                        inFraction = true;
                        j++;
                        continue;
                    }
                    break;
                }
                if (hasDigits) {
                    uint256 scaled = intPart * 1000;
                    if (fracScale > 1) {
                        scaled += fracPart * (1000 / fracScale);
                    }
                    lastValue = scaled;
                    found = true;
                }
                i = j;
                continue;
            }
            i++;
        }
    }
}
