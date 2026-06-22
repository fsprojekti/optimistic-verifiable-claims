/**
 * BindingPhase Gas Benchmark
 *
 * Measures the atomic binding coordinator cost across both the Consumer and
 * Provider sides for a small representative G-code file.
 *
 * Deployment order (mirrors production):
 *   1. Deploy four OVC contracts.
 *   2. Deploy BindingPhase with their addresses.
 *   3. Call setCoordinator(bindingPhaseAddress) on each OVC contract.
 *
 * Protocol flow measured here:
 *   bind()       — Consumer atomically commits all four OVC instances in one tx.
 *                  Cross-instance invariants enforced: same H(K) in Access+Identity,
 *                  same H̃(G) in Identity+Conformance+Feature.
 *   depositChunk() × N — Consumer deposits C on OVC-Identity so Provider can read it.
 *   accept()     — Provider atomically co-signs all four instances in one tx.
 *
 * Run: npx hardhat test tests/r1/binding-phase.js
 */

const { ethers } = require("hardhat");
const { writeCsvReport } = require("../../scripts/benchmarkCsv");

const CHUNK_SIZE = 4096;
const SECRET_K   = Buffer.alloc(32, 0x42);

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

describe("BindingPhase: Atomic Coordinator Gas Benchmark", function () {
    it("measures bind() + depositChunk() + accept() gas", async function () {
        this.timeout(0);
        const [consumer, prov] = await ethers.getSigners();
        const rawRows = [];

        // 1. Deploy all four OVC contracts
        const ovcAccess      = await (await ethers.getContractFactory("OVCAccess")).deploy(100);
        const ovcIdentity    = await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(100);
        const ovcConformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(100);
        const ovcFeature     = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(100);
        await Promise.all([ovcAccess, ovcIdentity, ovcConformance, ovcFeature].map(c => c.waitForDeployment()));

        // 2. Deploy BindingPhase coordinator
        const BindingPhase = await ethers.getContractFactory("BindingPhase");
        const bp = await BindingPhase.deploy(
            await ovcAccess.getAddress(),
            await ovcIdentity.getAddress(),
            await ovcConformance.getAddress(),
            await ovcFeature.getAddress()
        );
        await bp.waitForDeployment();
        const bpAddr = await bp.getAddress();

        // 3. Register coordinator on each OVC contract
        await (await ovcAccess.setCoordinator(bpAddr)).wait();
        await (await ovcIdentity.setCoordinator(bpAddr)).wait();
        await (await ovcConformance.setCoordinator(bpAddr)).wait();
        await (await ovcFeature.setCoordinator(bpAddr)).wait();

        // 4. Prepare material — 64 KB G-code
        const byteSize  = 64 * 1024;
        const gcode     = Buffer.alloc(byteSize, 0x58); // placeholder G-code
        const encrypted = xorEncrypt(gcode, SECRET_K);

        const hK    = ethers.keccak256(SECRET_K);       // H(K)
        const hC    = rollingKeccak(encrypted, CHUNK_SIZE); // H̃(C)
        const hG    = rollingKeccak(gcode, CHUNK_SIZE);     // H̃(G)
        const fClaim = 0n; // no extrusion claim in this benchmark

        // ── bind() ─────────────────────────────────────────────────────────────
        const bindTx  = await bp.connect(consumer).bind(prov.address, hK, hC, hG, fClaim);
        const bindRec = await bindTx.wait();
        const bindingId = 1n;
        rawRows.push({
            benchmark: "R1-binding-phase",
            operation: "bind",
            tx_index: 1,
            chunk_index: "",
            chunk_size_bytes: "",
            artifact_size_bytes: byteSize,
            gas_used: bindRec.gasUsed,
            binding_id: bindingId,
        });

        // Extract the identity claimId from event
        const boundEvent = bindRec.logs
            .map(l => { try { return bp.interface.parseLog(l); } catch { return null; } })
            .find(e => e && e.name === "Bound");
        const identityClaimId = boundEvent.args.identityClaimId;

        // ── depositChunk() — Consumer uploads C to OVC-Identity ───────────────
        let totalDepositGas = 0n;
        let chunkCount      = 0;
        for (let off = 0; off < byteSize; off += CHUNK_SIZE) {
            const chunk     = encrypted.slice(off, Math.min(off + CHUNK_SIZE, byteSize));
            const depositTx = await ovcIdentity.connect(consumer).depositChunk(identityClaimId, chunk);
            const depositRec = await depositTx.wait();
            totalDepositGas += depositRec.gasUsed;
            chunkCount++;
            rawRows.push({
                benchmark: "R1-binding-phase",
                operation: "depositChunk",
                tx_index: chunkCount + 1,
                chunk_index: chunkCount,
                chunk_size_bytes: chunk.length,
                artifact_size_bytes: byteSize,
                gas_used: depositRec.gasUsed,
                binding_id: bindingId,
            });
        }

        // ── accept() ───────────────────────────────────────────────────────────
        const acceptTx  = await bp.connect(prov).accept(bindingId);
        const acceptRec = await acceptTx.wait();
        rawRows.push({
            benchmark: "R1-binding-phase",
            operation: "accept",
            tx_index: chunkCount + 2,
            chunk_index: "",
            chunk_size_bytes: "",
            artifact_size_bytes: byteSize,
            gas_used: acceptRec.gasUsed,
            binding_id: bindingId,
        });

        // ── Report ─────────────────────────────────────────────────────────────
        const bindGas   = bindRec.gasUsed;
        const acceptGas = acceptRec.gasUsed;
        const grandTotal = bindGas + totalDepositGas + acceptGas;

        writeCsvReport(
            __filename,
            "raw",
            ["benchmark", "operation", "tx_index", "chunk_index", "chunk_size_bytes", "artifact_size_bytes", "gas_used", "binding_id"],
            rawRows,
            { subdir: "r1" }
        );

        console.log("\n" + "=".repeat(70));
        console.log("BINDING PHASE — ATOMIC COORDINATOR GAS BENCHMARK (64 KB artifact)");
        console.log("=".repeat(70));
        console.log(`bind()           — Consumer commits all 4 OVC instances: ${bindGas.toLocaleString()} gas`);
        console.log(`depositChunk()×${chunkCount}  — Consumer uploads C to OVC-Identity:  ${totalDepositGas.toLocaleString()} gas`);
        console.log(`accept()         — Provider co-signs all 4 OVC instances: ${acceptGas.toLocaleString()} gas`);
        console.log("-".repeat(70));
        console.log(`Grand total (bind + deposits + accept):                   ${grandTotal.toLocaleString()} gas`);
        console.log("=".repeat(70));
        console.log("Cross-instance invariants enforced atomically in bind():");
        console.log("  H(K) shared:  OVC-Access.commitment == OVC-Identity.providerKeyHash");
        console.log("  H̃(G) shared: OVC-Identity.auxHash == OVC-Conformance.commitment == OVC-Feature.commitment");
        console.log("=".repeat(70));
    });
});
