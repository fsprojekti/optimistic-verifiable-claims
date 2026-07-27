/**
 * Demand + BindingPhase Gas Benchmark (C15 two-phase)
 *
 * Measures the full two-phase coordinator cost across an artifact ladder, so
 * the O(1) claim for the binding terms is measured rather than asserted:
 * postDemand, seal, bindProvider and accept should be flat across artifact
 * size, while the ciphertext deposit is the only term that grows.
 *
 * Deployment order (mirrors production):
 *   1. Deploy the Demand store.
 *   2. Deploy four OVC contracts (OVC-Identity gets the Demand address).
 *   3. Deploy BindingPhase with their addresses + the Demand address.
 *   4. Call setCoordinator(bindingPhaseAddress) on each OVC contract.
 *
 * Everything is redeployed for each artifact size: reusing one deployment
 * would leave shared counters warm after the first binding, which is exactly
 * the artefact that would blur a flat-vs-growing comparison.
 *
 * Protocol flow measured here:
 *   Bidding:
 *     postDemand()            — Consumer commits H̃(G) + f_claim, provider-independent.
 *     depositCiphertextChunk() × N — Consumer uploads C to the Demand (O(N)).
 *     seal()                  — Consumer finalizes the demand's rolling hash H̃(C).
 *   Binding:
 *     bindProvider()          — Consumer atomically instantiates all four OVC
 *                               instances bound to the selected Provider and
 *                               delivers the encrypted key on-chain. Cross-instance
 *                               invariants enforced: same H(K) in Access+Identity,
 *                               same H̃(G) in Identity+Conformance+Feature, H̃(C)
 *                               and f_claim read from the sealed Demand.
 *     accept()                — Provider atomically co-signs all four in one tx.
 *
 * Run: npx hardhat test tests/r1/binding-phase.js
 */

const { ethers } = require("hardhat");
const { writeCsvReport } = require("../../scripts/benchmarkCsv");

const CHUNK_SIZE = 4096;
const SECRET_K   = Buffer.alloc(32, 0x42);
const KB         = 1024;
const SIZES      = [64 * KB, 256 * KB, 1024 * KB, 5 * 1024 * KB];

function xorEncrypt(buf, key32) {
    const out = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i++) out[i] = buf[i] ^ key32[i % 32];
    return out;
}

function rollingKeccak(data, chunkSize) {
    let hash = ethers.ZeroHash;
    for (let off = 0; off < data.length; off += chunkSize) {
        const chunk = data.slice(off, Math.min(off + chunkSize, data.length));
        hash = ethers.keccak256(ethers.concat([hash, chunk]));
    }
    return hash;
}

function label(bytes) {
    return bytes < KB * KB ? `${bytes / KB} KB` : `${bytes / (KB * KB)} MB`;
}

/** One full bidding + binding cycle on a freshly deployed stack. */
async function runCycle(byteSize, consumer, prov, rawRows) {
    // 1. Deploy the Demand store
    const demand     = await (await ethers.getContractFactory("Demand")).deploy();
    await demand.waitForDeployment();
    const demandAddr = await demand.getAddress();

    // 2. Deploy all four OVC contracts (OVC-Identity reads C from the Demand)
    const ovcAccess      = await (await ethers.getContractFactory("OVCAccess")).deploy(100);
    const ovcIdentity    = await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(100, demandAddr);
    const ovcConformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(100);
    const ovcFeature     = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(100);
    await Promise.all([ovcAccess, ovcIdentity, ovcConformance, ovcFeature].map(c => c.waitForDeployment()));

    // 3. Deploy BindingPhase coordinator
    const bp = await (await ethers.getContractFactory("BindingPhase")).deploy(
        await ovcAccess.getAddress(),
        await ovcIdentity.getAddress(),
        await ovcConformance.getAddress(),
        await ovcFeature.getAddress(),
        demandAddr
    );
    await bp.waitForDeployment();
    const bpAddr = await bp.getAddress();

    // 4. Register coordinator on each OVC contract
    await (await ovcAccess.setCoordinator(bpAddr)).wait();
    await (await ovcIdentity.setCoordinator(bpAddr)).wait();
    await (await ovcConformance.setCoordinator(bpAddr)).wait();
    await (await ovcFeature.setCoordinator(bpAddr)).wait();

    // 5. Prepare material
    const gcode     = Buffer.alloc(byteSize, 0x58); // placeholder G-code
    const encrypted = xorEncrypt(gcode, SECRET_K);

    const hK     = ethers.keccak256(SECRET_K);       // H(K)
    const hG     = rollingKeccak(gcode, CHUNK_SIZE); // H̃(G)
    const fClaim = 0n; // no extrusion claim in this benchmark

    const row = (operation, tx_index, gas_used, extra = {}) => rawRows.push({
        benchmark: "R1-binding-phase",
        operation,
        tx_index,
        chunk_index: "",
        chunk_size_bytes: "",
        artifact_size_bytes: byteSize,
        gas_used,
        binding_id: "",
        ...extra,
    });

    // ══ Bidding ══════════════════════════════════════════════════════════
    const postRec = await (await demand.connect(consumer).postDemand(hG, fClaim)).wait();
    const demandId = await demand.demandCount();
    row("postDemand", 1, postRec.gasUsed);

    let totalDepositGas = 0n;
    let chunkCount      = 0;
    for (let off = 0; off < byteSize; off += CHUNK_SIZE) {
        const chunk      = encrypted.slice(off, Math.min(off + CHUNK_SIZE, byteSize));
        const depositRec = await (await demand.connect(consumer).depositCiphertextChunk(demandId, chunk)).wait();
        totalDepositGas += depositRec.gasUsed;
        chunkCount++;
        row("depositCiphertextChunk", chunkCount + 1, depositRec.gasUsed,
            { chunk_index: chunkCount, chunk_size_bytes: chunk.length });
    }

    const sealRec = await (await demand.connect(consumer).seal(demandId)).wait();
    row("seal", chunkCount + 2, sealRec.gasUsed);

    // ══ Binding ══════════════════════════════════════════════════════════
    const encryptedKey = ethers.hexlify(ethers.randomBytes(48)); // K under provider pubkey (mock)
    const bindRec = await (await bp.connect(consumer).bindProvider(demandId, prov.address, hK, encryptedKey)).wait();
    const bindingId = 1n;
    row("bindProvider", chunkCount + 3, bindRec.gasUsed, { binding_id: bindingId });

    const acceptRec = await (await bp.connect(prov).accept(bindingId)).wait();
    row("accept", chunkCount + 4, acceptRec.gasUsed, { binding_id: bindingId });

    return {
        byteSize,
        chunkCount,
        post:    postRec.gasUsed,
        deposit: totalDepositGas,
        seal:    sealRec.gasUsed,
        bind:    bindRec.gasUsed,
        accept:  acceptRec.gasUsed,
    };
}

describe("BindingPhase: Atomic Coordinator Gas Benchmark", function () {
    it("measures bind() + depositChunk() + accept() gas across an artifact ladder", async function () {
        this.timeout(0);
        const [consumer, prov] = await ethers.getSigners();
        const rawRows = [];
        const results = [];

        for (const byteSize of SIZES) {
            console.log(`  running ${label(byteSize)} …`);
            results.push(await runCycle(byteSize, consumer, prov, rawRows));
        }

        writeCsvReport(
            __filename,
            "raw",
            ["benchmark", "operation", "tx_index", "chunk_index", "chunk_size_bytes", "artifact_size_bytes", "gas_used", "binding_id"],
            rawRows,
            { subdir: "r1" }
        );

        const n = (g) => g.toLocaleString().padStart(14);
        console.log("\n" + "=".repeat(92));
        console.log("DEMAND + BINDING PHASE — TWO-PHASE GAS BENCHMARK (4 KB chunks)");
        console.log("=".repeat(92));
        console.log("Artifact        postDemand         deposit           seal   bindProvider         accept");
        console.log("-".repeat(92));
        for (const r of results) {
            console.log(
                label(r.byteSize).padEnd(8) +
                n(r.post) + n(r.deposit) + n(r.seal) + n(r.bind) + n(r.accept)
            );
        }
        console.log("-".repeat(92));

        // The O(1) terms must not track artifact size; the deposit must.
        const spread = (key) => {
            const vs = results.map(r => Number(r[key]));
            return (Math.max(...vs) / Math.min(...vs) - 1) * 100;
        };
        for (const key of ["post", "seal", "bind", "accept"]) {
            console.log(`${key.padEnd(12)} spread across the ladder: ${spread(key).toFixed(3)}%`);
        }
        const sizeRatio = SIZES[SIZES.length - 1] / SIZES[0];
        const depositRatio = Number(results[results.length - 1].deposit) / Number(results[0].deposit);
        console.log(`deposit      grows ${depositRatio.toFixed(1)}x for a ${sizeRatio}x artifact`);
        console.log("=".repeat(92));
        console.log("Cross-instance invariants enforced atomically in bindProvider():");
        console.log("  H(K) shared:  OVC-Access.commitment == OVC-Identity.providerKeyHash");
        console.log("  H̃(G) shared: OVC-Identity.auxHash == OVC-Conformance.commitment == OVC-Feature.commitment");
        console.log("  H̃(C), f_claim read from the sealed Demand.");
        console.log("=".repeat(92));
    });
});
