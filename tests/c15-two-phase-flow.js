/**
 * C15 sanity test — the bidding/binding two-phase flow.
 *
 * Bidding : Demand.postDemand(hG, fClaim) + depositCiphertextChunk(C) + seal
 * Binding : BindingPhase.bindProvider(demandId, provider, hK, encryptedK)
 *           -> instantiates all four OVC instances, provider-bound
 * Honest  : Provider accepts all four via BindingPhase.accept
 * Dispute : OVC-Identity adjudicates, reading C cross-contract from the Demand
 *
 * Verifies: consistency (all instances carry the demand's hG), the encrypted key
 * is stored on-chain, and Identity's cross-contract C adjudication reaches VALID.
 *
 * Run: npx hardhat test tests/c15-two-phase-flow.js --network localhost
 */

const { expect } = require("chai");
const { ethers } = require("hardhat");

const DISPUTE_WINDOW = 100_000;

function rollingKeccak(buffer, chunkSize) {
    let hash = ethers.ZeroHash;
    for (let o = 0; o < buffer.length; o += chunkSize) {
        const chunk = buffer.slice(o, Math.min(o + chunkSize, buffer.length));
        hash = ethers.keccak256(ethers.concat([hash, chunk]));
    }
    return hash;
}
function xorKey(buf, key32) {
    const out = Buffer.from(buf);
    for (let i = 0; i < out.length; i++) out[i] ^= key32[i % 32];
    return out;
}

describe("C15 — bidding/binding two-phase flow", function () {
    this.timeout(0);

    let demand, access, identity, conformance, feature, binding;
    let consumer, provider;
    const CHUNK = 4096;

    beforeEach(async function () {
        [consumer, provider] = await ethers.getSigners();

        demand      = await (await (await ethers.getContractFactory("Demand")).deploy()).waitForDeployment();
        access      = await (await (await ethers.getContractFactory("OVCAccess")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        identity    = await (await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(DISPUTE_WINDOW, await demand.getAddress())).waitForDeployment();
        conformance = await (await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        feature     = await (await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        binding     = await (await (await ethers.getContractFactory("BindingPhase")).deploy(
            await access.getAddress(), await identity.getAddress(),
            await conformance.getAddress(), await feature.getAddress(),
            await demand.getAddress()
        )).waitForDeployment();

        // BindingPhase is the coordinator for the four OVC instances.
        for (const c of [access, identity, conformance, feature]) {
            await (await c.setCoordinator(await binding.getAddress())).wait();
        }
    });

    it("posts a demand, binds a provider, and adjudicates Identity from the Demand", async function () {
        // ── Artifact ─────────────────────────────────────────────────────────
        const G = Buffer.from("G1 X10 Y10 E1.0\nG1 X20 Y20 E2.0\nG92 E0\nG1 X0 Y0 E1.5\n".repeat(30));
        const K = Buffer.from(ethers.randomBytes(32));
        const C = xorKey(G, K);
        const hG = rollingKeccak(G, CHUNK);
        const hC = rollingKeccak(C, CHUNK);
        const hK = ethers.keccak256(K);
        const fClaim = 0;

        // ── Bidding: post demand + upload ciphertext + seal ──────────────────
        const dRec = await (await demand.connect(consumer).postDemand(hG, fClaim)).wait();
        const demandId = 1n;
        for (let o = 0; o < C.length; o += CHUNK) {
            await (await demand.connect(consumer).depositCiphertextChunk(demandId, C.slice(o, Math.min(o + CHUNK, C.length)))).wait();
        }
        await (await demand.connect(consumer).seal(demandId)).wait();
        expect(await demand.isSealed(demandId)).to.equal(true);
        expect(await demand.ciphertextRollingHash(demandId)).to.equal(hC);

        // ── Binding: bind the selected provider ──────────────────────────────
        const encryptedK = ethers.hexlify(ethers.randomBytes(48)); // K under provider pubkey (mock)
        await (await binding.connect(consumer).bindProvider(demandId, provider.address, hK, encryptedK)).wait();
        const [aId, iId, cId, fId] = await binding.getClaimIds(1);

        // Consistency: every artifact-bearing instance carries the demand's hG.
        expect((await conformance.claims(cId)).commitment).to.equal(hG);
        expect((await feature.claims(fId)).commitment).to.equal(hG);
        expect((await identity.claims(iId)).auxHash).to.equal(hG);
        expect((await identity.claims(iId)).commitment).to.equal(hC);
        expect(await identity.demandOf(iId)).to.equal(demandId);
        // Encrypted key delivered on-chain.
        expect((await binding.bindings(1)).encryptedKey).to.equal(encryptedK);

        // ── Dispute path on Identity: reads C from the Demand, decrypts, checks H~(G) ──
        await (await identity.connect(provider).disputeClaim(iId)).wait();
        await (await identity.connect(consumer).revealKey(iId, "0x" + K.toString("hex"))).wait();
        await (await identity.connect(consumer).startAdjudication(iId)).wait();
        const nChunks = Number(await demand.ciphertextChunkCount(demandId));
        for (let i = 0; i < nChunks; i++) {
            await (await identity.processChunk(iId, { gasLimit: 30_000_000 })).wait();
        }
        await (await identity.finalizeAdjudication(iId)).wait();
        expect((await identity.claims(iId)).outcome).to.equal(2); // VALID
    });

    it("honest path: provider accepts all four", async function () {
        const G = Buffer.from("G1 X0 Y0 E1.0\n".repeat(20));
        const K = Buffer.from(ethers.randomBytes(32));
        const C = xorKey(G, K);
        const hG = rollingKeccak(G, CHUNK), hC = rollingKeccak(C, CHUNK), hK = ethers.keccak256(K);

        await (await demand.connect(consumer).postDemand(hG, 0)).wait();
        for (let o = 0; o < C.length; o += CHUNK) {
            await (await demand.connect(consumer).depositCiphertextChunk(1, C.slice(o, Math.min(o + CHUNK, C.length)))).wait();
        }
        await (await demand.connect(consumer).seal(1)).wait();
        await (await binding.connect(consumer).bindProvider(1, provider.address, hK, "0x00")).wait();
        await (await binding.connect(provider).accept(1)).wait();

        const [aId, iId, cId, fId] = await binding.getClaimIds(1);
        for (const [c, id] of [[access, aId], [identity, iId], [conformance, cId], [feature, fId]]) {
            expect((await c.claims(id)).outcome).to.equal(1); // Accepted
        }
    });
});
