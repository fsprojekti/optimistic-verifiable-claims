// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCAccess.sol";
import "./OVCIdentitySegmented.sol";
import "./OVCConformanceSegmented.sol";
import "./OVCFeatureSegmented.sol";
import "./Demand.sol";

/**
 * BindingPhase — binds a selected Provider to a posted Demand.
 *
 * Two-phase model:
 *   Bidding  (Demand contract): the Consumer posts the artifact commitment H~(G),
 *            the feature claim f_claim, and uploads the ciphertext C in chunks.
 *            Provider-independent; no OVC instance exists yet.
 *   Binding  (this contract): once a Provider is selected, the Consumer calls
 *            bindProvider, which instantiates all four OVC instances bound to that
 *            Provider and delivers the decryption key K encrypted under the
 *            Provider's public key on-chain.
 *
 * Cross-instance consistency is a contract invariant enforced across the two
 * phases: bindProvider reads H~(G) and H~(C) from the sealed Demand and propagates
 * them identically to every instance, so a dishonest Consumer cannot register a
 * different artifact to different instances. H(K) is likewise shared by
 * OVC-Access and OVC-Identity in the single binding transaction.
 */
contract BindingPhase {
    OVCAccess               public immutable ovcAccess;
    OVCIdentitySegmented    public immutable ovcIdentity;
    OVCConformanceSegmented public immutable ovcConformance;
    OVCFeatureSegmented     public immutable ovcFeature;
    Demand                  public immutable demand;

    struct Binding {
        address consumer;
        address provider;
        uint256 demandId;
        uint256 accessClaimId;
        uint256 identityClaimId;
        uint256 conformanceClaimId;
        uint256 featureClaimId;
        bytes   encryptedKey;   // K encrypted under the Provider's public key
    }

    uint256 public bindingCount;
    mapping(uint256 => Binding) public bindings;

    event ProviderBound(
        uint256 indexed bindingId,
        uint256 indexed demandId,
        address indexed provider,
        uint256 accessClaimId,
        uint256 identityClaimId,
        uint256 conformanceClaimId,
        uint256 featureClaimId
    );
    event BindingAccepted(uint256 indexed bindingId);

    constructor(
        address _ovcAccess,
        address _ovcIdentity,
        address _ovcConformance,
        address _ovcFeature,
        address _demand
    ) {
        ovcAccess       = OVCAccess(_ovcAccess);
        ovcIdentity     = OVCIdentitySegmented(_ovcIdentity);
        ovcConformance  = OVCConformanceSegmented(_ovcConformance);
        ovcFeature      = OVCFeatureSegmented(_ovcFeature);
        demand          = Demand(_demand);
    }

    /**
     * @notice Bind the selected Provider to a sealed Demand: instantiate all four
     *         OVC instances and deliver the encrypted key on-chain.
     *
     * @param demandId      The sealed demand to bind.
     * @param provider      The selected Provider.
     * @param hK            H(K) — shared by OVC-Access (commitment) and OVC-Identity
     *                      (providerKeyHash).
     * @param encryptedKey  K encrypted under the Provider's public key, delivered
     *                      on-chain so the Provider can recover K, then G = C XOR K.
     *
     * H~(G), H~(C) and f_claim are read from the Demand — not passed in — so the
     * bound artifact is provably the demanded one.
     */
    function bindProvider(
        uint256 demandId,
        address provider,
        bytes32 hK,
        bytes calldata encryptedKey
    ) external returns (uint256 bindingId) {
        require(demand.isSealed(demandId), "Demand not sealed");
        require(msg.sender == _demandConsumer(demandId), "Only demand consumer");

        bytes32 hG = demand.artifactHash(demandId);
        bytes32 hC = demand.ciphertextRollingHash(demandId);
        uint256 fClaim = demand.featureClaim(demandId);

        // Provider-delivery claims (bound to the selected Provider).
        uint256 aId = ovcAccess.commitClaimFor(
            msg.sender, provider, hK, bytes32(0), 0, bytes32(0)
        );
        uint256 iId = ovcIdentity.commitClaimFor(
            msg.sender, provider, hC, hG, 0, hK
        );
        ovcIdentity.setDemand(iId, demandId);

        // Artifact claims (the demand's commitments, now bound to the Provider).
        uint256 cId = ovcConformance.commitClaimFor(
            msg.sender, provider, hG, bytes32(0), 0, bytes32(0)
        );
        uint256 fId = ovcFeature.commitClaimFor(
            msg.sender, provider, hG, bytes32(0), fClaim, bytes32(0)
        );

        bindingId = ++bindingCount;
        bindings[bindingId] = Binding({
            consumer:           msg.sender,
            provider:           provider,
            demandId:           demandId,
            accessClaimId:      aId,
            identityClaimId:    iId,
            conformanceClaimId: cId,
            featureClaimId:     fId,
            encryptedKey:       encryptedKey
        });

        emit ProviderBound(bindingId, demandId, provider, aId, iId, cId, fId);
    }

    /**
     * @notice Provider atomically accepts all four OVC instances once ready.
     */
    function accept(uint256 bindingId) external {
        Binding storage b = bindings[bindingId];
        require(b.provider == msg.sender, "Only provider");

        ovcAccess.acceptClaimFor(b.accessClaimId, msg.sender);
        ovcIdentity.acceptClaimFor(b.identityClaimId, msg.sender);
        ovcConformance.acceptClaimFor(b.conformanceClaimId, msg.sender);
        ovcFeature.acceptClaimFor(b.featureClaimId, msg.sender);

        emit BindingAccepted(bindingId);
    }

    function getClaimIds(uint256 bindingId)
        external
        view
        returns (uint256 accessId, uint256 identityId, uint256 conformanceId, uint256 featureId)
    {
        Binding storage b = bindings[bindingId];
        return (b.accessClaimId, b.identityClaimId, b.conformanceClaimId, b.featureClaimId);
    }

    function _demandConsumer(uint256 demandId) internal view returns (address c) {
        (c, , , , , ) = demand.demands(demandId);
    }
}
