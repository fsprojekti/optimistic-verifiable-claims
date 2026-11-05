// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCBase.sol";
import "./RSAOAEP.sol";

contract OVCAccess is OVCBase {
    struct EnvelopeTerms { bytes publicKey; bytes32 labelHash; bool configured; }
    mapping(uint256 => EnvelopeTerms) private envelopes;

    constructor(uint256 _disputeWindowBlocks) OVCBase(_disputeWindowBlocks) {}

    function configureEnvelope(uint256 claimId, bytes calldata publicKey, bytes32 labelHash) external onlyCoordinator {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(!envelopes[claimId].configured, "Envelope already configured");
        require(RSAOAEP.validPublicKey(publicKey), "Unsupported RSA public key");
        require(keccak256(publicKey) == claims[claimId].providerKeyHash, "Provider key mismatch");
        envelopes[claimId] = EnvelopeTerms(publicKey, labelHash, true);
    }

    // Witness = K (32 bytes) || OAEP random seed (32 bytes). The binding pins H(K).
    function revealWitness(uint256 claimId, bytes calldata witness) public override onlyClaimant(claimId) {
        Claim storage claim = claims[claimId];
        require(claim.state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");
        require(witness.length == 64, "Access witness must be 64 bytes");
        if (keccak256(witness[:32]) != claim.commitment) {
            claim.outcome = Outcome.Inconsistent;
        } else {
            claim.outcome = _verifyPredicate(claimId, claim, witness) ? Outcome.Valid : Outcome.Incorrect;
        }
        claim.state = State.Resolved;
        emit ClaimRevealed(claimId, claim.outcome);
    }

    function _verifyPredicate(uint256 claimId, Claim storage claim, bytes calldata witness)
        internal
        view
        override
        returns (bool)
    {
        // commitment = H(K); providerKeyHash = H(registered public key);
        // claimValue = uint256(H(encrypted key envelope));
        // auxHash = H(K || providerKeyHash || H(envelope)).
        EnvelopeTerms storage terms = envelopes[claimId];
        if (!terms.configured || keccak256(abi.encodePacked(
            witness[:32], claim.providerKeyHash, bytes32(claim.claimValue)
        )) != claim.auxHash) return false;
        return keccak256(RSAOAEP.encrypt(bytes32(witness[:32]), bytes32(witness[32:]),
            terms.labelHash, terms.publicKey)) == bytes32(claim.claimValue);
    }
}

