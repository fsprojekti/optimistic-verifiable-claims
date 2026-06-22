// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCAccess.sol";
import "./OVCIdentitySegmented.sol";
import "./OVCConformanceSegmented.sol";
import "./OVCFeatureSegmented.sol";

/**
 * BindingPhase — atomic coordinator for the four-OVC pipeline.
 *
 * Problem it solves:
 *   Each OVC instance has its own commitClaim. If called independently,
 *   a dishonest Consumer could commit a different H̃(G) to OVC-Conformance
 *   than to OVC-Identity, breaking cross-instance consistency. The same
 *   risk applies to H(K) across OVC-Access and OVC-Identity.
 *
 * Solution:
 *   bind() commits all four OVC instances in a single transaction.
 *   Because hK and hG are calldata values shared across all four calls,
 *   cross-instance consistency is a contract invariant, not an off-chain
 *   assumption.
 *
 * accept() lets the Provider co-sign all four instances atomically once
 *   all chunk deposits are complete.
 *
 * Disputes are out-of-scope for this contract — the Provider disputes
 *   individual OVC instances directly.
 *
 * Deployment:
 *   1. Deploy the four OVC contracts.
 *   2. Deploy BindingPhase with their addresses.
 *   3. Call setCoordinator(bindingPhaseAddress) on each OVC contract.
 */
contract BindingPhase {
    OVCAccess               public immutable ovcAccess;
    OVCIdentitySegmented    public immutable ovcIdentity;
    OVCConformanceSegmented public immutable ovcConformance;
    OVCFeatureSegmented     public immutable ovcFeature;

    struct Binding {
        address consumer;
        address provider;
        uint256 accessClaimId;
        uint256 identityClaimId;
        uint256 conformanceClaimId;
        uint256 featureClaimId;
    }

    uint256 public bindingCount;
    mapping(uint256 => Binding) public bindings;

    event Bound(
        uint256 indexed bindingId,
        address indexed consumer,
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
        address _ovcFeature
    ) {
        ovcAccess       = OVCAccess(_ovcAccess);
        ovcIdentity     = OVCIdentitySegmented(_ovcIdentity);
        ovcConformance  = OVCConformanceSegmented(_ovcConformance);
        ovcFeature      = OVCFeatureSegmented(_ovcFeature);
    }

    /**
     * @notice Consumer atomically commits all four OVC instances.
     *
     * @param provider  Address of the selected Provider.
     * @param hK        H(K)  — shared by OVC-Access (commitment) and
     *                          OVC-Identity (providerKeyHash).
     * @param hC        H̃(C) — OVC-Identity commitment (rolling hash of C chunks).
     * @param hG        H̃(G) — shared by OVC-Identity (auxHash),
     *                          OVC-Conformance (commitment), OVC-Feature (commitment).
     * @param fClaim    Claimed filament value — OVC-Feature claimValue.
     *
     * Cross-instance invariants enforced atomically:
     *   ovcAccess.commitment      == hK
     *   ovcIdentity.providerKeyHash == hK          (same K)
     *   ovcIdentity.auxHash         == hG          (same G)
     *   ovcConformance.commitment   == hG          (same G)
     *   ovcFeature.commitment       == hG          (same G)
     */
    function bind(
        address provider,
        bytes32 hK,
        bytes32 hC,
        bytes32 hG,
        uint256 fClaim
    ) external returns (uint256 bindingId) {
        bindingId = ++bindingCount;

        uint256 aId = ovcAccess.commitClaimFor(
            msg.sender, provider, hK, bytes32(0), 0, bytes32(0)
        );
        uint256 iId = ovcIdentity.commitClaimFor(
            msg.sender, provider, hC, hG, 0, hK
        );
        uint256 cId = ovcConformance.commitClaimFor(
            msg.sender, provider, hG, bytes32(0), 0, bytes32(0)
        );
        uint256 fId = ovcFeature.commitClaimFor(
            msg.sender, provider, hG, bytes32(0), fClaim, bytes32(0)
        );

        bindings[bindingId] = Binding({
            consumer:          msg.sender,
            provider:          provider,
            accessClaimId:     aId,
            identityClaimId:   iId,
            conformanceClaimId: cId,
            featureClaimId:    fId
        });

        emit Bound(bindingId, msg.sender, provider, aId, iId, cId, fId);
    }

    /**
     * @notice Provider atomically accepts all four OVC instances once all
     *         chunk deposits are complete. Reverts if any instance is not
     *         ready (deposit incomplete or wrong state).
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

    // Convenience view: returns all four claim IDs for a binding.
    function getClaimIds(uint256 bindingId)
        external
        view
        returns (uint256 accessId, uint256 identityId, uint256 conformanceId, uint256 featureId)
    {
        Binding storage b = bindings[bindingId];
        return (b.accessClaimId, b.identityClaimId, b.conformanceClaimId, b.featureClaimId);
    }
}
