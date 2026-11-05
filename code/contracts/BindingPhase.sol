// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./OVCAccess.sol";
import "./OVCIdentitySegmented.sol";
import "./OVCConformanceSegmented.sol";
import "./OVCFeatureSegmented.sol";
import "./Demand.sol";
import "./SegmentedCommitment.sol";
import "./RSAOAEP.sol";

/**
 * BindingPhase â€” binds a selected Provider to a posted Demand.
 *
 * Bidding commits Com(G) and Com(C), but does not publish C. After Provider
 * selection, the Demand contract verifies the deferred segmented publication of
 * C. This contract then creates the OVC instances and delivers encrypted K.
 *
 * Cross-instance consistency is a contract invariant enforced across the two
 * phases: bindProvider reads H~(G) and H~(C) from the sealed Demand and propagates
 * them identically to every instance, so a dishonest Consumer cannot register a
 * different artifact to different instances. H(K) is likewise shared by
 * OVC-Access and OVC-Identity in the single binding transaction.
 */
contract BindingPhase {
    struct ClaimIds {
        uint256 accessId;
        uint256 identityId;
        uint256 conformanceId;
        uint256 featureId;
    }
    struct AccessCommitments {
        bytes32 providerKeyHash;
        bytes32 envelopeHash;
        bytes32 linkCommitment;
    }
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
    mapping(uint256 => uint256) public demandToBinding;
    mapping(address => bytes) public accessPublicKeys;

    event AccessPublicKeyRegistered(address indexed provider, bytes32 keyHash);

    // The selected Provider, not the Consumer, chooses its encryption public key.
    // Existing claims pin the key hash and remain unchanged on later rotation.
    function registerAccessPublicKey(bytes calldata publicKey) external {
        require(RSAOAEP.validPublicKey(publicKey), "Unsupported RSA public key");
        accessPublicKeys[msg.sender] = publicKey;
        emit AccessPublicKeyRegistered(msg.sender, keccak256(publicKey));
    }

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
     * @param hK            H(K) â€” shared by OVC-Access (commitment) and OVC-Identity
     *                      (providerKeyHash).
     * @param encryptedKey  K encrypted under the Provider's public key, delivered
     *                      on-chain so the Provider can recover K and decrypt C
     *                      with the nonce committed in the Demand.
     * @param accessLinkCommitment H(K || H(registered public key) || H(encryptedKey)).
     *
     * H~(G), H~(C) and f_claim are read from the Demand â€” not passed in â€” so the
     * bound artifact is provably the demanded one.
     */
    function bindProvider(
        uint256 demandId,
        address provider,
        bytes32 hK,
        bytes calldata encryptedKey,
        bytes32 accessLinkCommitment,
        uint256[3] calldata reimbursements
    ) external returns (uint256 bindingId) {
        require(demand.isSealed(demandId), "Demand not sealed");
        require(msg.sender == demand.demandConsumer(demandId), "Only demand consumer");
        require(demand.selectedProvider(demandId) == provider, "Provider not selected");
        require(demandToBinding[demandId] == 0, "Demand already bound");
        require(accessPublicKeys[provider].length != 0, "Provider access key not registered");
        require(hK != bytes32(0), "Key commitment required");
        require(encryptedKey.length == 256, "RSA envelope must be 256 bytes");
        require(accessLinkCommitment != bytes32(0), "Access linkage required");

        ClaimIds memory ids = _createClaims(
            demandId, provider, hK,
            AccessCommitments(keccak256(accessPublicKeys[provider]), keccak256(encryptedKey), accessLinkCommitment),
            reimbursements
        );

        bindingId = ++bindingCount;
        demandToBinding[demandId] = bindingId;
        bindings[bindingId] = Binding({
            consumer:           msg.sender,
            provider:           provider,
            demandId:           demandId,
            accessClaimId:      ids.accessId,
            identityClaimId:    ids.identityId,
            conformanceClaimId: ids.conformanceId,
            featureClaimId:     ids.featureId,
            encryptedKey:       encryptedKey
        });

        emit ProviderBound(
            bindingId,
            demandId,
            provider,
            ids.accessId,
            ids.identityId,
            ids.conformanceId,
            ids.featureId
        );
    }

    function _createClaims(
        uint256 demandId,
        address provider,
        bytes32 hK,
        AccessCommitments memory accessTerms,
        uint256[3] calldata reimbursements
    ) internal returns (ClaimIds memory ids) {
        bytes32 hG = demand.artifactHash(demandId);
        uint256 witnessBytes = demand.ciphertextByteCount(demandId);

        ids.accessId = ovcAccess.commitClaimFor(
            msg.sender, provider, hK, accessTerms.linkCommitment,
            uint256(accessTerms.envelopeHash), accessTerms.providerKeyHash
        );
        ovcAccess.configureEnvelope(ids.accessId, accessPublicKeys[provider], sha256(abi.encodePacked(
            keccak256("OVC_ACCESS_RSA_OAEP_SHA256_V1"), provider, demandId
        )));
        ids.identityId = ovcIdentity.commitClaimFor(
            msg.sender,
            provider,
            demand.ciphertextCommitment(demandId),
            hG,
            0,
            hK
        );
        ovcIdentity.setDemand(ids.identityId, demandId);
        ovcIdentity.configureWitnessTermsFor(
            ids.identityId, msg.sender, 0, reimbursements[0]
        );

        ids.conformanceId = ovcConformance.commitClaimFor(
            msg.sender, provider, hG, bytes32(0), 0, bytes32(0)
        );
        ids.featureId = ovcFeature.commitClaimFor(
            msg.sender,
            provider,
            hG,
            bytes32(0),
            demand.featureClaim(demandId),
            bytes32(0)
        );
        ovcConformance.configureWitnessTermsFor(
            ids.conformanceId, msg.sender, witnessBytes, reimbursements[1]
        );
        ovcFeature.configureWitnessTermsFor(
            ids.featureId, msg.sender, witnessBytes, reimbursements[2]
        );
        uint256 chunkSize = demand.artifactChunkSize(demandId);
        ovcConformance.configureDepositFormatFor(
            ids.conformanceId,
            msg.sender,
            SegmentedCommitment.PLAINTEXT_DOMAIN,
            witnessBytes,
            chunkSize
        );
        ovcFeature.configureDepositFormatFor(
            ids.featureId,
            msg.sender,
            SegmentedCommitment.PLAINTEXT_DOMAIN,
            witnessBytes,
            chunkSize
        );
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
}
