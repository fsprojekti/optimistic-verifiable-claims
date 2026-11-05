// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./SegmentedCommitment.sol";

abstract contract OVCBaseSegmented {
    enum State { None, Committed, Accepted, Disputed, Adjudicating, Resolved }
    enum Outcome { None, Accepted, Valid, Inconsistent, Incorrect, Withheld }

    struct Claim {
        address claimant;
        address provider;
        bytes32 commitment;      // HÌƒ(chunks) â€” rolling hash over all deposited chunks
        bytes32 auxHash;         // secondary commitment (e.g. HÌƒ(G) for Identity)
        uint256 claimValue;
        bytes32 providerKeyHash;
        State state;
        Outcome outcome;
    }

    struct AdjudicationSession {
        uint256 nextChunkIndex;  // index of next chunk to process during adjudication
        uint256 bytesProcessed;  // cumulative bytes processed (stream-cipher offset)
        bytes32 rollingKeccak;   // predicate accumulator; usage defined by derived contract
    }

    struct DepositFormat {
        bytes32 domain;
        uint256 totalBytes;
        uint256 chunkSize;
        uint256 chunkCount;
        uint256 uploadedBytes;
        bool configured;
    }

    uint256 public claimCount;
    uint256 public immutable disputeWindowBlocks;
    address public coordinator;

    mapping(uint256 => Claim) public claims;
    mapping(uint256 => AdjudicationSession) public sessions;
    mapping(uint256 => uint256) public disputeDeadline;

    // Chunk storage written at binding, read at adjudication â€” no re-submission needed
    mapping(uint256 => mapping(uint256 => bytes)) public depositedChunks;
    mapping(uint256 => uint256) public depositedChunkCount;
    mapping(uint256 => bytes32) public depositRollingHash;
    mapping(uint256 => DepositFormat) public depositFormats;

    // Witness-reimbursement terms are fixed by the Consumer before the Provider
    // decides whether to dispute. The escrow reimburses witness publication only;
    // permissionless predicate processing remains a separate cost.
    mapping(uint256 => bool) public witnessTermsConfigured;
    mapping(uint256 => uint256) public expectedWitnessBytes;
    mapping(uint256 => uint256) public depositedWitnessBytes;
    mapping(uint256 => uint256) public witnessReimbursement;
    mapping(uint256 => uint256) public reimbursementEscrow;
    mapping(address => uint256) public reimbursementCredits;

    event ClaimCommitted(uint256 indexed claimId, address indexed claimant, address indexed provider);
    event ChunkDeposited(uint256 indexed claimId, uint256 indexed chunkIndex);
    event DepositFormatConfigured(
        uint256 indexed claimId,
        bytes32 indexed domain,
        uint256 totalBytes,
        uint256 chunkSize,
        uint256 chunkCount
    );
    event ClaimAccepted(uint256 indexed claimId);
    event ClaimDisputed(uint256 indexed claimId);
    event AdjudicationStarted(uint256 indexed claimId);
    event ClaimRevealed(uint256 indexed claimId, Outcome outcome);
    event ClaimWithheld(uint256 indexed claimId);
    event WitnessTermsConfigured(
        uint256 indexed claimId,
        uint256 expectedBytes,
        uint256 reimbursement
    );
    event ReimbursementEscrowed(uint256 indexed claimId, address indexed provider, uint256 amount);
    event ReimbursementSettled(uint256 indexed claimId, address indexed beneficiary, uint256 amount);
    event ReimbursementWithdrawn(address indexed beneficiary, uint256 amount);

    constructor(uint256 _disputeWindowBlocks) {
        require(_disputeWindowBlocks > 0, "Window must be > 0");
        disputeWindowBlocks = _disputeWindowBlocks;
    }

    modifier onlyCoordinator() {
        require(msg.sender == coordinator && coordinator != address(0), "Only coordinator");
        _;
    }

    function setCoordinator(address _coordinator) external {
        require(coordinator == address(0), "Already set");
        require(_coordinator != address(0), "Zero address");
        coordinator = _coordinator;
    }

    modifier onlyClaimant(uint256 claimId) {
        require(claims[claimId].claimant == msg.sender, "Only claimant");
        _;
    }

    modifier onlyProvider(uint256 claimId) {
        require(claims[claimId].provider == msg.sender, "Only provider");
        _;
    }

    /**
     * @notice Bind the maximum plaintext witness length and fixed reimbursement.
     *         Zero expected bytes are valid for Identity, where the response is a
     *         constant-size key revelation rather than a plaintext upload.
     */
    function configureWitnessTerms(
        uint256 claimId,
        uint256 expectedBytes,
        uint256 reimbursement
    ) external onlyClaimant(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(!witnessTermsConfigured[claimId], "Terms already configured");
        witnessTermsConfigured[claimId] = true;
        expectedWitnessBytes[claimId] = expectedBytes;
        witnessReimbursement[claimId] = reimbursement;
        emit WitnessTermsConfigured(claimId, expectedBytes, reimbursement);
    }

    function configureWitnessTermsFor(
        uint256 claimId,
        address claimant,
        uint256 expectedBytes,
        uint256 reimbursement
    ) external onlyCoordinator {
        require(claims[claimId].claimant == claimant, "Wrong claimant");
        require(claims[claimId].state == State.Committed, "Not committed");
        require(!witnessTermsConfigured[claimId], "Terms already configured");
        witnessTermsConfigured[claimId] = true;
        expectedWitnessBytes[claimId] = expectedBytes;
        witnessReimbursement[claimId] = reimbursement;
        emit WitnessTermsConfigured(claimId, expectedBytes, reimbursement);
    }

    /**
     * Configure the concrete EVM segmentation used to publish a committed
     * witness. The abstract claim contains only Com(X); this descriptor belongs
     * to the segmented implementation profile.
     */
    function configureDepositFormat(
        uint256 claimId,
        bytes32 domain,
        uint256 totalBytes,
        uint256 chunkSize
    ) external onlyClaimant(claimId) {
        _configureDepositFormat(claimId, domain, totalBytes, chunkSize);
    }

    function configureDepositFormatFor(
        uint256 claimId,
        address claimant,
        bytes32 domain,
        uint256 totalBytes,
        uint256 chunkSize
    ) external onlyCoordinator {
        require(claims[claimId].claimant == claimant, "Wrong claimant");
        _configureDepositFormat(claimId, domain, totalBytes, chunkSize);
    }

    function _configureDepositFormat(
        uint256 claimId,
        bytes32 domain,
        uint256 totalBytes,
        uint256 chunkSize
    ) internal {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(!depositFormats[claimId].configured, "Format already configured");
        require(domain != bytes32(0), "Domain required");
        if (witnessTermsConfigured[claimId]) {
            require(totalBytes == expectedWitnessBytes[claimId], "Witness length mismatch");
        }

        uint256 chunkCount = SegmentedCommitment.count(totalBytes, chunkSize);
        depositFormats[claimId] = DepositFormat({
            domain: domain,
            totalBytes: totalBytes,
            chunkSize: chunkSize,
            chunkCount: chunkCount,
            uploadedBytes: 0,
            configured: true
        });
        depositRollingHash[claimId] = SegmentedCommitment.seed(
            domain, totalBytes, chunkSize, chunkCount
        );
        emit DepositFormatConfigured(claimId, domain, totalBytes, chunkSize, chunkCount);
    }

    function plaintextCommitmentDomain() external pure returns (bytes32) {
        return SegmentedCommitment.PLAINTEXT_DOMAIN;
    }

    function _escrowReimbursement(uint256 claimId) internal {
        require(witnessTermsConfigured[claimId], "Witness terms not configured");
        uint256 requiredAmount = witnessReimbursement[claimId];
        require(msg.value == requiredAmount, "Incorrect reimbursement escrow");
        reimbursementEscrow[claimId] = requiredAmount;
        emit ReimbursementEscrowed(claimId, msg.sender, requiredAmount);
    }

    function _settleReimbursement(uint256 claimId, bool consumerWon) internal {
        uint256 amount = reimbursementEscrow[claimId];
        reimbursementEscrow[claimId] = 0;
        address beneficiary = consumerWon
            ? claims[claimId].claimant
            : claims[claimId].provider;
        reimbursementCredits[beneficiary] += amount;
        emit ReimbursementSettled(claimId, beneficiary, amount);
    }

    function withdrawReimbursement() external {
        uint256 amount = reimbursementCredits[msg.sender];
        require(amount != 0, "No reimbursement credit");
        reimbursementCredits[msg.sender] = 0;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, "Withdrawal failed");
        emit ReimbursementWithdrawn(msg.sender, amount);
    }

    // â”€â”€ Binding phase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function commitClaimFor(
        address claimant,
        address provider,
        bytes32 commitment,
        bytes32 auxHash,
        uint256 claimValue,
        bytes32 providerKeyHash
    ) external onlyCoordinator returns (uint256 claimId) {
        require(provider != address(0), "Provider required");
        claimId = ++claimCount;
        claims[claimId] = Claim({
            claimant: claimant,
            provider: provider,
            commitment: commitment,
            auxHash: auxHash,
            claimValue: claimValue,
            providerKeyHash: providerKeyHash,
            state: State.Committed,
            outcome: Outcome.None
        });
        emit ClaimCommitted(claimId, claimant, provider);
    }

    function acceptClaimFor(uint256 claimId, address provider) external virtual onlyCoordinator {
        require(claims[claimId].provider == provider, "Wrong provider");
        require(claims[claimId].state == State.Committed, "Not committed");
        require(isDepositComplete(claimId), "Deposit not complete");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function commitClaim(
        address provider,
        bytes32 commitment,
        bytes32 auxHash,
        uint256 claimValue,
        bytes32 providerKeyHash
    ) external returns (uint256 claimId) {
        require(provider != address(0), "Provider required");
        claimId = ++claimCount;
        claims[claimId] = Claim({
            claimant: msg.sender,
            provider: provider,
            commitment: commitment,
            auxHash: auxHash,
            claimValue: claimValue,
            providerKeyHash: providerKeyHash,
            state: State.Committed,
            outcome: Outcome.None
        });
        emit ClaimCommitted(claimId, msg.sender, provider);
    }

    // Consumer uploads a canonically segmented witness. Identity sources deferred C from
    // Demand instead; Conformance/Feature deposit G after dispute because G must stay
    // private until a dispute is triggered.
    function depositChunk(uint256 claimId, bytes calldata chunk) external onlyClaimant(claimId) {
        State s = claims[claimId].state;
        require(s == State.Committed || s == State.Disputed, "Not in depositable state");
        DepositFormat storage format = depositFormats[claimId];
        require(format.configured, "Deposit format not configured");

        uint256 index = depositedChunkCount[claimId];
        uint256 requiredLength = SegmentedCommitment.expectedLength(
            format.totalBytes,
            format.chunkSize,
            format.chunkCount,
            index
        );
        require(chunk.length == requiredLength, "Incorrect chunk length");
        if (s == State.Disputed) {
            uint256 newTotal = depositedWitnessBytes[claimId] + chunk.length;
            require(newTotal <= expectedWitnessBytes[claimId], "Witness exceeds bound length");
            depositedWitnessBytes[claimId] = newTotal;
        }
        depositedChunks[claimId][index] = chunk;
        depositedChunkCount[claimId] = index + 1;
        format.uploadedBytes += chunk.length;
        depositRollingHash[claimId] = SegmentedCommitment.appendCalldata(
            depositRollingHash[claimId], index, chunk
        );
        emit ChunkDeposited(claimId, index);
    }

    function isDepositComplete(uint256 claimId) public view returns (bool) {
        DepositFormat storage format = depositFormats[claimId];
        return format.configured
            && depositedChunkCount[claimId] == format.chunkCount
            && format.uploadedBytes == format.totalBytes
            && depositRollingHash[claimId] == claims[claimId].commitment;
    }

    // Provider co-signs binding. Base requires deposit complete (overridden by
    // Conformance/Feature which deposit G at dispute time, not binding time).
    function acceptClaim(uint256 claimId) external virtual onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(isDepositComplete(claimId), "Deposit not complete");
        claims[claimId].state = State.Accepted;
        claims[claimId].outcome = Outcome.Accepted;
        emit ClaimAccepted(claimId);
    }

    function disputeClaim(uint256 claimId) external payable virtual onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(isDepositComplete(claimId), "Deposit not complete");
        _escrowReimbursement(claimId);
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // â”€â”€ Adjudication phase â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    // Consumer opens adjudication within the dispute window. Virtual so derived
    // contracts can add pre-conditions (e.g. key must be revealed first).
    function startAdjudication(uint256 claimId) external virtual onlyClaimant(claimId) {
        _startAdjudication(claimId);
    }

    function _startAdjudication(uint256 claimId) internal virtual {
        require(claims[claimId].state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");
        require(
            depositedWitnessBytes[claimId] == expectedWitnessBytes[claimId],
            "Witness length incomplete"
        );
        claims[claimId].state = State.Adjudicating;
        emit AdjudicationStarted(claimId);
    }

    // Process the next stored chunk. Permissionless â€” chunks are already on-chain
    // and the outcome is deterministic, so any party can advance adjudication.
    // Virtual so an instance can source its chunks elsewhere (e.g. OVC-Identity
    // reads the ciphertext cross-contract from the Demand store).
    function processChunk(uint256 claimId) external virtual {
        require(claims[claimId].state == State.Adjudicating, "Not adjudicating");
        AdjudicationSession storage session = sessions[claimId];
        uint256 idx = session.nextChunkIndex;
        require(idx < depositedChunkCount[claimId], "All chunks processed");

        bytes storage chunk = depositedChunks[claimId][idx];
        _processChunk(claimId, claims[claimId], session, chunk);
        session.bytesProcessed += chunk.length;
        session.nextChunkIndex++;
    }

    // Permissionless â€” finalises once all chunks have been processed.
    function finalizeAdjudication(uint256 claimId) external {
        require(claims[claimId].state == State.Adjudicating, "Not adjudicating");
        require(
            sessions[claimId].nextChunkIndex == depositedChunkCount[claimId],
            "Not all chunks processed"
        );
        bool success = _finalizePredicate(claimId, claims[claimId], sessions[claimId]);
        claims[claimId].outcome = success ? Outcome.Valid : Outcome.Incorrect;
        claims[claimId].state = State.Resolved;
        _settleReimbursement(claimId, success);
        emit ClaimRevealed(claimId, claims[claimId].outcome);
        delete sessions[claimId];
    }

    // Anyone may call this once the dispute window has expired without adjudication starting.
    function resolveWithheld(uint256 claimId) external {
        require(claims[claimId].state == State.Disputed, "Not disputed");
        require(block.number > disputeDeadline[claimId], "Dispute window still open");
        claims[claimId].state = State.Resolved;
        claims[claimId].outcome = Outcome.Withheld;
        _settleReimbursement(claimId, false);
        emit ClaimWithheld(claimId);
    }

    // â”€â”€ Hooks for derived contracts â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

    function _processChunk(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage session,
        bytes storage chunk
    ) internal virtual;

    function _finalizePredicate(
        uint256 claimId,
        Claim storage claim,
        AdjudicationSession storage session
    ) internal view virtual returns (bool);
}
