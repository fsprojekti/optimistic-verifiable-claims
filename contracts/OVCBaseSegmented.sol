// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract OVCBaseSegmented {
    enum State { None, Committed, Accepted, Disputed, Adjudicating, Resolved }
    enum Outcome { None, Accepted, Valid, Inconsistent, Incorrect, Withheld }

    struct Claim {
        address claimant;
        address provider;
        bytes32 commitment;      // H̃(chunks) — rolling hash over all deposited chunks
        bytes32 auxHash;         // secondary commitment (e.g. H̃(G) for Identity)
        uint256 claimValue;
        bytes32 providerKeyHash;
        State state;
        Outcome outcome;
    }

    struct AdjudicationSession {
        uint256 nextChunkIndex;  // index of next chunk to process during adjudication
        uint256 bytesProcessed;  // cumulative bytes processed (used for XOR key offset)
        bytes32 rollingKeccak;   // predicate accumulator; usage defined by derived contract
    }

    uint256 public claimCount;
    uint256 public immutable disputeWindowBlocks;
    address public coordinator;

    mapping(uint256 => Claim) public claims;
    mapping(uint256 => AdjudicationSession) public sessions;
    mapping(uint256 => uint256) public disputeDeadline;

    // Chunk storage written at binding, read at adjudication — no re-submission needed
    mapping(uint256 => mapping(uint256 => bytes)) public depositedChunks;
    mapping(uint256 => uint256) public depositedChunkCount;
    mapping(uint256 => bytes32) public depositRollingHash;

    event ClaimCommitted(uint256 indexed claimId, address indexed claimant, address indexed provider);
    event ChunkDeposited(uint256 indexed claimId, uint256 indexed chunkIndex);
    event ClaimAccepted(uint256 indexed claimId);
    event ClaimDisputed(uint256 indexed claimId);
    event AdjudicationStarted(uint256 indexed claimId);
    event ClaimRevealed(uint256 indexed claimId, Outcome outcome);
    event ClaimWithheld(uint256 indexed claimId);

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

    // ── Binding phase ────────────────────────────────────────────────────────

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

    // Consumer uploads chunks on-chain. For Identity, C is deposited at binding (Committed
    // state) so Provider can read it. For Conformance/Feature, G is deposited after dispute
    // (Disputed state) because G must stay private until a dispute is actually triggered.
    // Deposit is complete when depositRollingHash[claimId] == commitment.
    function depositChunk(uint256 claimId, bytes calldata chunk) external onlyClaimant(claimId) {
        State s = claims[claimId].state;
        require(s == State.Committed || s == State.Disputed, "Not in depositable state");
        uint256 index = depositedChunkCount[claimId];
        depositedChunks[claimId][index] = chunk;
        depositedChunkCount[claimId] = index + 1;
        depositRollingHash[claimId] = keccak256(
            abi.encodePacked(depositRollingHash[claimId], chunk)
        );
        emit ChunkDeposited(claimId, index);
    }

    function isDepositComplete(uint256 claimId) public view returns (bool) {
        return depositRollingHash[claimId] == claims[claimId].commitment;
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

    function disputeClaim(uint256 claimId) external virtual onlyProvider(claimId) {
        require(claims[claimId].state == State.Committed, "Not committed");
        require(isDepositComplete(claimId), "Deposit not complete");
        claims[claimId].state = State.Disputed;
        disputeDeadline[claimId] = block.number + disputeWindowBlocks;
        emit ClaimDisputed(claimId);
    }

    // ── Adjudication phase ───────────────────────────────────────────────────

    // Consumer opens adjudication within the dispute window. Virtual so derived
    // contracts can add pre-conditions (e.g. key must be revealed first).
    function startAdjudication(uint256 claimId) external virtual onlyClaimant(claimId) {
        _startAdjudication(claimId);
    }

    function _startAdjudication(uint256 claimId) internal virtual {
        require(claims[claimId].state == State.Disputed, "Not disputed");
        require(block.number <= disputeDeadline[claimId], "Dispute window expired");
        claims[claimId].state = State.Adjudicating;
        emit AdjudicationStarted(claimId);
    }

    // Process the next stored chunk. Permissionless — chunks are already on-chain
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

    // Permissionless — finalises once all chunks have been processed.
    function finalizeAdjudication(uint256 claimId) external {
        require(claims[claimId].state == State.Adjudicating, "Not adjudicating");
        require(
            sessions[claimId].nextChunkIndex == depositedChunkCount[claimId],
            "Not all chunks processed"
        );
        bool success = _finalizePredicate(claimId, claims[claimId], sessions[claimId]);
        claims[claimId].outcome = success ? Outcome.Valid : Outcome.Incorrect;
        claims[claimId].state = State.Resolved;
        emit ClaimRevealed(claimId, claims[claimId].outcome);
        delete sessions[claimId];
    }

    // Anyone may call this once the dispute window has expired without adjudication starting.
    function resolveWithheld(uint256 claimId) external {
        require(claims[claimId].state == State.Disputed, "Not disputed");
        require(block.number > disputeDeadline[claimId], "Dispute window still open");
        claims[claimId].state = State.Resolved;
        claims[claimId].outcome = Outcome.Withheld;
        emit ClaimWithheld(claimId);
    }

    // ── Hooks for derived contracts ──────────────────────────────────────────

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
