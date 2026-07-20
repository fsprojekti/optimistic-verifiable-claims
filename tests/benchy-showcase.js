/**
 * Benchy Showcase Benchmark — All Four OVC Instances
 *
 * Measures dispute-path gas for the 3DBenchy G-code artifact
 * (tests/3dbenchy_015mm_pla_mk3_2h.gcode) across all four OVC instances:
 *
 *   OVC-Access      (OVCBase, non-segmented — O(1), artifact-size-independent)
 *     commitClaim → disputeClaim → revealWitness(K)
 *
 *   OVC-Identity    (OVCIdentitySegmented)
 *     commitClaim → depositChunk(C) → disputeClaim → revealKey(K)
 *     → startAdjudication → estimateGas(processChunk)
 *
 *   OVC-Conformance (OVCConformanceSegmented)
 *     commitClaim → disputeClaim → depositChunk(G) → startAdjudication
 *     → estimateGas(processChunk)
 *
 *   OVC-Feature     (OVCFeatureSegmented — same flow as Conformance)
 *     commitClaim → disputeClaim → depositChunk(G) → startAdjudication
 *     → estimateGas(processChunk)
 *     f_claim is the honest net extrusion f(G) derived from the artifact by the
 *     off-chain reference in lib/gcode-reference.js, so the adjudicated outcome
 *     is the one a truthful Consumer would receive.
 *
 * Chain projections: Table 4 parameters (β = 1.5).
 *
 * Run:
 *   npx hardhat test tests/benchy-showcase.js --network localhost
 */

const fs   = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { netExtrusion, slicerFilamentUsed } = require("./lib/gcode-reference");

// ── Artifact ──────────────────────────────────────────────────────────────────

const GCODE_PATH     = path.join(__dirname, "3dbenchy_015mm_pla_mk3_2h.gcode");
const DISPUTE_WINDOW = 100_000;

// ── Chain projection parameters (Table 4) ────────────────────────────────────

// Operating chunk per chain = largest whose heaviest per-chunk transaction fits
// 95% of the block gas limit (the headroom keeps the transaction reliably
// includable rather than requiring an otherwise-empty block). OVC-Feature is the
// binding constraint on every chain, displacing OVC-Identity. Chunk size barely
// affects total gas (<1% across the feasible range) but sets transaction count and
// therefore dispute duration, so it is selected per chain rather than shared.
// Derived in scripts/compute_r4.py.
const CHAINS = [
    { name: "Ethereum (L1)", gasPriceGwei: 0.5,   tokenUSD: 3000, blockTimeS: 12,   chunkKB: 14 },
    { name: "Arbitrum (L2)", gasPriceGwei: 0.02,  tokenUSD: 3000, blockTimeS: 0.25, chunkKB: 13 },
    { name: "opBNB (L2)",    gasPriceGwei: 0.001, tokenUSD: 600,  blockTimeS: 1,    chunkKB: 80 },
];
const BETA = 1.5;

// ── Helpers ───────────────────────────────────────────────────────────────────

function rollingKeccak(buffer, chunkSize) {
    let hash = ethers.ZeroHash;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const chunk = buffer.slice(offset, Math.min(offset + chunkSize, buffer.length));
        hash = ethers.keccak256(ethers.concat([hash, chunk]));
    }
    return hash;
}

function xorWithKey(buffer, key32) {
    const out = Buffer.from(buffer);
    for (let i = 0; i < out.length; i++) out[i] ^= key32[i % 32];
    return out;
}

function extractClaimId(receipt, contract) {
    const parsed = receipt.logs
        .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find(e => e && e.name === "ClaimCommitted");
    return parsed.args.claimId;
}

function glim(bytes) { return Math.ceil(bytes * 2500) + 200_000_000; }
function dlim(bytes) { return Math.ceil(bytes * 1500) + 100_000_000; }

async function estProcessChunk(contract, claimId, addr, chunkBytes) {
    return Number(await ethers.provider.estimateGas({
        from:     addr,
        to:       await contract.getAddress(),
        data:     contract.interface.encodeFunctionData("processChunk", [claimId]),
        gasLimit: glim(chunkBytes),
    }));
}

function projectCost(gas, chain) {
    const wei = BigInt(gas) * BigInt(Math.round(chain.gasPriceGwei * 1e9));
    return Number(wei) / 1e18 * chain.tokenUSD;
}
function projectTime(chunks, chain) { return chunks * BETA * chain.blockTimeS; }
function fmtTime(s) {
    if (s < 60)   return `${s.toFixed(0)} s`;
    if (s < 3600) return `${(s/60).toFixed(1)} min`;
    return `${(s/3600).toFixed(2)} h`;
}
function fmtUSD(u) {
    if (u < 0.01) return `$${u.toFixed(5)}`;
    if (u < 1)    return `$${u.toFixed(4)}`;
    if (u < 1000) return `$${u.toFixed(2)}`;
    return `$${u.toLocaleString("en-US", {maximumFractionDigits: 0})}`;
}

// ── OVC-Access (non-segmented, O(1)) ─────────────────────────────────────────

async function measureAccess(contract, claimant, provider) {
    const key32          = Buffer.from(ethers.randomBytes(32));
    const provKeyHash    = ethers.keccak256(ethers.randomBytes(32)); // mock provider key hash
    const commitment     = ethers.keccak256(key32);
    const auxHash        = ethers.keccak256(ethers.concat([key32, provKeyHash]));

    const commitRec = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, auxHash, 0, provKeyHash
    )).wait();
    const claimId = extractClaimId(commitRec, contract);

    await (await contract.connect(provider).disputeClaim(claimId)).wait();

    const revealRec = await (await contract.connect(claimant).revealWitness(claimId, key32)).wait();
    const gas = Number(commitRec.gasUsed) + Number(revealRec.gasUsed);
    console.log(`  OVC-Access (O(1))        = ${gas.toLocaleString()} gas total lifecycle`);
    return gas; // fixed regardless of artifact size
}

// ── OVC-Identity segmented ────────────────────────────────────────────────────

async function measureIdentityPerChunk(contract, claimant, provider, gcode, chunkBytes) {
    const key32     = Buffer.from(ethers.randomBytes(32));
    const plain     = gcode.slice(0, chunkBytes);
    const ciph      = xorWithKey(plain, key32);
    const ciphHash  = rollingKeccak(ciph,   chunkBytes);
    const gcodeHash = rollingKeccak(plain,  chunkBytes);
    const keyHash   = ethers.keccak256(key32);

    const startRec = await (await contract.connect(claimant).commitClaim(
        provider.address, ciphHash, gcodeHash, 0, keyHash
    )).wait();
    const claimId = extractClaimId(startRec, contract);

    await (await contract.connect(claimant).depositChunk(
        claimId, ciph, { gasLimit: dlim(chunkBytes) }
    )).wait();
    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).revealKey(claimId, `0x${key32.toString("hex")}`)).wait();
    await (await contract.connect(claimant).startAdjudication(claimId)).wait();

    const g = await estProcessChunk(contract, claimId, claimant.address, chunkBytes);
    console.log(`  OVC-Identity    @ ${chunkBytes/1024} KB chunk = ${g.toLocaleString()} gas/chunk`);
    return g;
}

async function measureIdentityOverhead(contract, claimant, provider, chunkBytes) {
    const key32     = Buffer.from(ethers.randomBytes(32));
    const plain     = Buffer.alloc(chunkBytes, 0x41);
    const ciph      = xorWithKey(plain, key32);
    const ciphHash  = rollingKeccak(ciph,  chunkBytes);
    const gcodeHash = rollingKeccak(plain, chunkBytes);
    const keyHash   = ethers.keccak256(key32);

    const r0 = await (await contract.connect(claimant).commitClaim(
        provider.address, ciphHash, gcodeHash, 0, keyHash
    )).wait();
    const claimId = extractClaimId(r0, contract);
    await (await contract.connect(claimant).depositChunk(claimId, ciph, { gasLimit: dlim(chunkBytes) })).wait();
    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).revealKey(claimId, `0x${key32.toString("hex")}`)).wait();
    const rS = await (await contract.connect(claimant).startAdjudication(claimId)).wait();
    await (await contract.connect(claimant).processChunk(claimId, { gasLimit: glim(chunkBytes) })).wait();
    const rF = await (await contract.connect(claimant).finalizeAdjudication(claimId)).wait();
    return { start: Number(rS.gasUsed), finalize: Number(rF.gasUsed) };
}

// ── OVC-Conformance segmented ─────────────────────────────────────────────────

async function measureConformancePerChunk(contract, claimant, provider, gcode, chunkBytes) {
    const chunk      = gcode.slice(0, chunkBytes);
    const commitment = rollingKeccak(chunk, chunkBytes);

    const r0 = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, ethers.ZeroHash, 0, ethers.ZeroHash
    )).wait();
    const claimId = extractClaimId(r0, contract);

    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).depositChunk(claimId, chunk, { gasLimit: dlim(chunkBytes) })).wait();
    await (await contract.connect(claimant).startAdjudication(claimId)).wait();

    const g = await estProcessChunk(contract, claimId, claimant.address, chunkBytes);
    console.log(`  OVC-Conformance @ ${chunkBytes/1024} KB chunk = ${g.toLocaleString()} gas/chunk`);
    return g;
}

async function measureConformanceOverhead(contract, claimant, provider, chunkBytes) {
    const chunk      = Buffer.alloc(chunkBytes, 0x58);
    chunk.write("G1", chunkBytes - 2);
    const commitment = rollingKeccak(chunk, chunkBytes);

    const r0 = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, ethers.ZeroHash, 0, ethers.ZeroHash
    )).wait();
    const claimId = extractClaimId(r0, contract);
    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).depositChunk(claimId, chunk, { gasLimit: dlim(chunkBytes) })).wait();
    const rS = await (await contract.connect(claimant).startAdjudication(claimId)).wait();
    await (await contract.connect(claimant).processChunk(claimId, { gasLimit: glim(chunkBytes) })).wait();
    const rF = await (await contract.connect(claimant).finalizeAdjudication(claimId)).wait();
    return { start: Number(rS.gasUsed), finalize: Number(rF.gasUsed) };
}

// ── OVC-Feature segmented (same flow as Conformance) ─────────────────────────

async function measureFeaturePerChunk(contract, claimant, provider, gcode, chunkBytes, fClaim) {
    const chunk      = gcode.slice(0, chunkBytes);
    const commitment = rollingKeccak(chunk, chunkBytes);

    const r0 = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, ethers.ZeroHash, fClaim, ethers.ZeroHash
    )).wait();
    const claimId = extractClaimId(r0, contract);

    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).depositChunk(claimId, chunk, { gasLimit: dlim(chunkBytes) })).wait();
    await (await contract.connect(claimant).startAdjudication(claimId)).wait();

    const g = await estProcessChunk(contract, claimId, claimant.address, chunkBytes);
    console.log(`  OVC-Feature     @ ${chunkBytes/1024} KB chunk = ${g.toLocaleString()} gas/chunk`);
    return g;
}

async function measureFeatureOverhead(contract, claimant, provider, chunkBytes) {
    const chunk      = Buffer.from("G1 X0 Y0 E1.000\n".repeat(Math.ceil(chunkBytes / 17)).slice(0, chunkBytes));
    const commitment = rollingKeccak(chunk, chunkBytes);
    const fClaim     = 1000; // matches E1.000

    const r0 = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, ethers.ZeroHash, fClaim, ethers.ZeroHash
    )).wait();
    const claimId = extractClaimId(r0, contract);
    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    await (await contract.connect(claimant).depositChunk(claimId, chunk, { gasLimit: dlim(chunkBytes) })).wait();
    const rS = await (await contract.connect(claimant).startAdjudication(claimId)).wait();
    await (await contract.connect(claimant).processChunk(claimId, { gasLimit: glim(chunkBytes) })).wait();
    const rF = await (await contract.connect(claimant).finalizeAdjudication(claimId)).wait();
    return { start: Number(rS.gasUsed), finalize: Number(rF.gasUsed) };
}

// ── Main ──────────────────────────────────────────────────────────────────────

describe("Benchy Showcase — all four OVC instances", function () {
    it("measures and projects dispute costs for the 3DBenchy G-code", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();

        const gcode     = fs.readFileSync(GCODE_PATH);
        const gcodeText = gcode.toString();
        const gcodeSize = gcode.length;
        const lineCount = gcodeText.split("\n").length;

        // The honest claim a truthful Consumer would commit at Binding.
        const fClaim      = netExtrusion(gcodeText);
        const slicerMm    = slicerFilamentUsed(gcodeText);
        const fClaimMm    = Number(fClaim) / 1e5;

        console.log(`\n3DBenchy: ${gcodeSize.toLocaleString()} bytes (${(gcodeSize/1024/1024).toFixed(2)} MB), ${lineCount.toLocaleString()} lines`);
        console.log(`  f(G) = ${fClaim} (${fClaimMm.toFixed(2)} mm); slicer header ${slicerMm} mm`);

        // Deploy all contracts
        const accessC = await (await (await ethers.getContractFactory("OVCAccess")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        const idC     = await (await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        const confC   = await (await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        const featC   = await (await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(DISPUTE_WINDOW)).waitForDeployment();
        console.log("  Contracts deployed.\n");

        // OVC-Access: O(1), measure once
        const accessGas = await measureAccess(accessC, claimant, provider);

        const results = [];

        for (const chain of CHAINS) {
            const chunkBytes = chain.chunkKB * 1024;
            const chunks     = Math.ceil(gcodeSize / chunkBytes);
            console.log(`\n--- ${chain.name} (${chain.chunkKB} KB chunks, ${chunks} chunks) ---`);

            // Overheads (startAdjudication + finalizeAdjudication)
            const idOH   = await measureIdentityOverhead(idC,   claimant, provider, chunkBytes);
            const confOH = await measureConformanceOverhead(confC, claimant, provider, chunkBytes);
            const featOH = await measureFeatureOverhead(featC,  claimant, provider, chunkBytes);

            // Per-chunk gas on a representative first chunk
            const idPC   = await measureIdentityPerChunk(idC,   claimant, provider, gcode, chunkBytes);
            const confPC = await measureConformancePerChunk(confC, claimant, provider, gcode, chunkBytes);
            const featPC = await measureFeaturePerChunk(featC,  claimant, provider, gcode, chunkBytes, fClaim);

            // Total gas per instance = overhead + N × per-chunk
            const idGas   = idOH.start   + idOH.finalize   + chunks * idPC;
            const confGas = confOH.start + confOH.finalize + chunks * confPC;
            const featGas = featOH.start + featOH.finalize + chunks * featPC;
            const worstGas = accessGas + idGas + confGas + featGas;

            results.push({ chain: chain.name, chunkKB: chain.chunkKB, chunks,
                accessGas, idGas, confGas, featGas, worstGas,
                accessCost: projectCost(accessGas, chain),
                idCost:     projectCost(idGas, chain),
                confCost:   projectCost(confGas, chain),
                featCost:   projectCost(featGas, chain),
                worstCost:  projectCost(worstGas, chain),
                time:       projectTime(chunks, chain),
            });
        }

        // ── Report ────────────────────────────────────────────────────────────
        const lines = [];
        const emit  = s => { console.log(s); lines.push(s); };
        const sep   = "=".repeat(96);

        emit(`\n${sep}`);
        emit(`3DBenchy — ${gcodeSize.toLocaleString()} bytes (${(gcodeSize/1024/1024).toFixed(2)} MB), ${lineCount.toLocaleString()} lines`);
        emit(`Methodology: eth_estimateGas × chunk count + O(1) overhead. Chain params: Table 4. β = ${BETA}.`);
        emit(`OVC-Access is O(1) (${accessGas.toLocaleString()} gas, constant across all chains and sizes).`);
        emit(`OVC-Feature: f_claim = ${fClaim} (${fClaimMm.toFixed(2)} mm net extrusion), derived from the artifact;`);
        emit(`  slicer reports ${slicerMm} mm, the difference being start-G-code priming it excludes.`);
        emit(sep);
        emit(`\n${"Instance".padEnd(18)} ${"Chain".padEnd(20)} ${"Chunks".padStart(7)} ${"Gas (Mgas)".padStart(12)} ${"Cost".padStart(12)} ${"Time".padStart(10)}`);
        emit("-".repeat(82));

        for (const r of results) {
            emit(`${"OVC-Access".padEnd(18)} ${r.chain.padEnd(20)} ${"O(1)".padStart(7)} ${(r.accessGas/1e6).toFixed(3).padStart(12)} ${fmtUSD(r.accessCost).padStart(12)} ${"—".padStart(10)}`);
            emit(`${"OVC-Identity".padEnd(18)} ${r.chain.padEnd(20)} ${r.chunks.toString().padStart(7)} ${(r.idGas/1e6).toFixed(1).padStart(12)} ${fmtUSD(r.idCost).padStart(12)} ${fmtTime(r.time).padStart(10)}`);
            emit(`${"OVC-Conformance".padEnd(18)} ${r.chain.padEnd(20)} ${r.chunks.toString().padStart(7)} ${(r.confGas/1e6).toFixed(1).padStart(12)} ${fmtUSD(r.confCost).padStart(12)} ${fmtTime(r.time).padStart(10)}`);
            emit(`${"OVC-Feature".padEnd(18)} ${r.chain.padEnd(20)} ${r.chunks.toString().padStart(7)} ${(r.featGas/1e6).toFixed(1).padStart(12)} ${fmtUSD(r.featCost).padStart(12)} ${fmtTime(r.time).padStart(10)}`);
            emit(`${"WORST CASE (all 4)".padEnd(18)} ${r.chain.padEnd(20)} ${r.chunks.toString().padStart(7)} ${(r.worstGas/1e6).toFixed(1).padStart(12)} ${fmtUSD(r.worstCost).padStart(12)} ${fmtTime(r.time).padStart(10)}`);
            emit("-".repeat(82));
        }
        emit(sep);

        const reportPath = path.join(__dirname, "..", "experiments", "reports", "benchy-showcase.md");
        fs.mkdirSync(path.dirname(reportPath), { recursive: true });
        fs.writeFileSync(reportPath,
            ["# Benchy Showcase — All Four OVC Instances", "",
             `Artifact: 3DBenchy G-code, ${gcodeSize.toLocaleString()} bytes (${(gcodeSize/1024/1024).toFixed(2)} MB), ${lineCount.toLocaleString()} lines`,
             "", "```text", ...lines, "```"].join("\n"), "utf8");
        console.log(`\n[report] Saved to experiments/reports/benchy-showcase.md`);
    });
});
