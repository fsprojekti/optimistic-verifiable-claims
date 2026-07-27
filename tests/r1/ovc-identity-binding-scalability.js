/**
 * R1 — Binding Phase chunk-size spectrum
 *
 * Methodology:
 *   1. Measure commitClaim and acceptClaim O(1) overheads with real tx.
 *   2. Measure per-deposit-chunk gas at each chunk size via eth_estimateGas.
 *      estimateGas executes the same EVM opcodes as a real tx and returns
 *      bit-identical gas, but skips block-level RLP size checks, allowing
 *      measurement at chunk sizes that exceed the local node's body limit.
 *   3. Derive total binding gas at every (chunk, G-code) combination by
 *      formula: total = commitClaim + ⌈G/chunk⌉ × per_chunk + acceptClaim.
 *      Per-chunk gas is constant by EVM physics (each chunk writes fresh
 *      cold storage slots), so derivation is mathematically exact.
 *
 *   R1a O(1) instances (Access, Conformance, Feature): measured with small
 *   G-code payload — values are size-independent at binding.
 *
 * Run: npx hardhat test tests/r1/ovc-identity-binding-scalability.js
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

const SECRET_K = Buffer.alloc(32, 0x42);

// Output subdir override (e.g. OVC_OUTPUT_SUBDIR=r1-128 for a focused single-chunk run
// that must not overwrite the full-spectrum CSVs/reports). Defaults to "r1".
const OUTPUT_SUBDIR = process.env.OVC_OUTPUT_SUBDIR || "r1";
const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", OUTPUT_SUBDIR);

function parseSpectrum(envName, fallback) {
    const raw = process.env[envName];
    if (!raw) return fallback;
    return raw.split(",").map(v => Number(v.trim())).filter(v => Number.isFinite(v) && v > 0);
}

// Spectrum: chunk sizes for OVC-Identity R1b.1 measurements (env override: R1_CHUNK_SPECTRUM_KB)
const CHUNK_SPECTRUM_KB = parseSpectrum(
    "R1_CHUNK_SPECTRUM_KB",
    [1, 4, 8, 12, 16, 64, 128, 256, 512, 1024, 5 * 1024, 10 * 1024, 25 * 1024, 50 * 1024]
);
// G-code sizes for R1b.2 derived matrix (env override: R1_GCODE_SPECTRUM_KB)
const GCODE_SPECTRUM_KB = parseSpectrum(
    "R1_GCODE_SPECTRUM_KB",
    [64, 256, 1024, 5 * 1024, 10 * 1024, 25 * 1024, 50 * 1024]
);

function fmtSize(kb) {
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
}

function extractClaimId(receipt, contract) {
    const parsed = receipt.logs
        .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "ClaimCommitted");
    return parsed.args.claimId;
}

function writeSummaryArtifacts(scriptFile, title, lines) {
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });

    const baseName = path.basename(scriptFile, path.extname(scriptFile));
    const mdPath = path.join(SUMMARY_DIR, `${baseName}.md`);

    const markdownLines = [
        `# ${title}`,
        "",
        `Source script: ${path.relative(process.cwd(), scriptFile)}`,
        "",
        "```text",
        ...lines,
        "```",
        "",
    ];
    fs.writeFileSync(mdPath, markdownLines.join("\n"), "utf8");

    console.log(`[report] Wrote ${path.relative(process.cwd(), mdPath)}`);
}

describe("R1 — Binding Phase chunk-size spectrum", function () {
    it("R1a + R1b: O(1) overheads, per-chunk gas spectrum, derived total matrix", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();
        const overheadWriter = createCsvReportWriter(
            __filename,
            "overheads-raw",
            ["measurement_group", "instance", "operation", "gas_used", "method", "note"],
            { subdir: OUTPUT_SUBDIR }
        );
        const perChunkWriter = createCsvReportWriter(
            __filename,
            "per-chunk-raw",
            ["measurement_group", "instance", "chunk_size_kb", "chunk_size_bytes", "per_chunk_gas", "effective_gas_per_byte", "method", "status"],
            { subdir: OUTPUT_SUBDIR }
        );

        // ── Deploy the Demand store + all four segmented contracts ────────────
        // C15: the ciphertext C is uploaded to the Demand at bidding (O(N)), not to
        // OVC-Identity. OVC-Identity is constructed with a reference to the Demand and
        // reads C cross-contract at adjudication. The per-chunk upload cost measured
        // in R1b is therefore Demand.depositCiphertextChunk, the bidding-phase cost.
        const demand      = await (await ethers.getContractFactory("Demand")).deploy();
        await demand.waitForDeployment();
        const demandAddr  = await demand.getAddress();
        const access      = await (await ethers.getContractFactory("OVCAccess")).deploy(100);
        const identity    = await (await ethers.getContractFactory("OVCIdentitySegmented")).deploy(100, demandAddr);
        const conformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(100);
        const feature     = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(100);
        await Promise.all([access, identity, conformance, feature].map(c => c.waitForDeployment()));
        // Claimant acts as coordinator so it can call setDemand at binding.
        await (await identity.setCoordinator(claimant.address)).wait();

        const keyHash = ethers.keccak256(SECRET_K);

        // ═════════════════════════════════════════════════════════════════════
        // R1a — O(1) commit + accept for Access, Conformance, Feature
        // ═════════════════════════════════════════════════════════════════════

        // OVC-Access uses raw key (32 B); commitment = H(K); auxHash = H(K ‖ providerKeyHash)
        const accessKey       = ethers.toUtf8Bytes("secret-key");
        const accessKeyCommit = ethers.keccak256(accessKey);
        const providerKeyHash = ethers.keccak256(ethers.toUtf8Bytes("provider-pubkey"));
        const wrapperHash     = ethers.keccak256(
            ethers.solidityPacked(["bytes", "bytes32"], [accessKey, providerKeyHash])
        );

        const accessCommitRec  = await (await access.connect(claimant).commitClaim(
            provider.address, accessKeyCommit, wrapperHash, 0, providerKeyHash
        )).wait();
        const accessClaimId    = extractClaimId(accessCommitRec, access);
        const accessAcceptRec  = await (await access.connect(provider).acceptClaim(accessClaimId)).wait();
        const accessCommitGas  = Number(accessCommitRec.gasUsed);
        const accessAcceptGas  = Number(accessAcceptRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Access",
            operation: "commitClaim",
            gas_used: accessCommitGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Access commitClaim = ${accessCommitGas.toLocaleString()} gas`);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Access",
            operation: "acceptClaim",
            gas_used: accessAcceptGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Access acceptClaim = ${accessAcceptGas.toLocaleString()} gas`);

        // OVC-Conformance segmented: commitClaim with H̃(G); accept is O(1) (deposit-check overridden)
        const dummyHash = ethers.keccak256(Buffer.alloc(32, 0x47));
        const confCommitRec = await (await conformance.connect(claimant).commitClaim(
            provider.address, dummyHash, ethers.ZeroHash, 0, ethers.ZeroHash
        )).wait();
        const confClaimId   = extractClaimId(confCommitRec, conformance);
        const confAcceptRec = await (await conformance.connect(provider).acceptClaim(confClaimId)).wait();
        const confCommitGas = Number(confCommitRec.gasUsed);
        const confAcceptGas = Number(confAcceptRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Conformance",
            operation: "commitClaim",
            gas_used: confCommitGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Conformance commitClaim = ${confCommitGas.toLocaleString()} gas`);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Conformance",
            operation: "acceptClaim",
            gas_used: confAcceptGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Conformance acceptClaim = ${confAcceptGas.toLocaleString()} gas`);

        // OVC-Feature segmented
        const featCommitRec = await (await feature.connect(claimant).commitClaim(
            provider.address, dummyHash, ethers.ZeroHash, 0, ethers.ZeroHash
        )).wait();
        const featClaimId   = extractClaimId(featCommitRec, feature);
        const featAcceptRec = await (await feature.connect(provider).acceptClaim(featClaimId)).wait();
        const featCommitGas = Number(featCommitRec.gasUsed);
        const featAcceptGas = Number(featAcceptRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Feature",
            operation: "commitClaim",
            gas_used: featCommitGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Feature commitClaim = ${featCommitGas.toLocaleString()} gas`);
        overheadWriter.appendRow({
            measurement_group: "R1a",
            instance: "OVC-Feature",
            operation: "acceptClaim",
            gas_used: featAcceptGas,
            method: "transaction",
            note: "size-independent",
        });
        console.log(`[R1a] OVC-Feature acceptClaim = ${featAcceptGas.toLocaleString()} gas`);

        // ═════════════════════════════════════════════════════════════════════
        // R1b — OVC-Identity chunk-size spectrum (C15 two-phase)
        //   Bidding : Demand.postDemand + depositCiphertextChunk (O(N) upload)
        //   Binding : identity.commitClaim + setDemand + acceptClaim  (all O(1))
        // ═════════════════════════════════════════════════════════════════════

        // Bidding: post a demand and deposit a 1 KB baseline ciphertext chunk so the
        // demand has a valid rolling hash. Left unsealed while we estimate the per-chunk
        // upload spectrum, then sealed to drive the binding-phase overheads.
        const baselineChunk = Buffer.alloc(1024, 0x58);                                     // 1 KB
        await (await demand.connect(claimant).postDemand(ethers.keccak256(baselineChunk), 0)).wait();
        const baselineDemandId = await demand.demandCount();
        await (await demand.connect(claimant).depositCiphertextChunk(baselineDemandId, baselineChunk)).wait();

        // R1b.1 — per-chunk upload gas spectrum via estimateGas on Demand.depositCiphertextChunk.
        const perChunkGas  = {};
        const perChunkLbl  = {};

        for (const kb of CHUNK_SPECTRUM_KB) {
            const bytes = kb * 1024;
            const chunk = Buffer.alloc(bytes, 0x58);
            try {
                console.log(`[R1b.1] Estimating depositCiphertextChunk for ${fmtSize(kb)}...`);
                const est = await ethers.provider.estimateGas({
                    from: claimant.address,
                    to:   demandAddr,
                    data: demand.interface.encodeFunctionData("depositCiphertextChunk", [baselineDemandId, chunk]),
                });
                perChunkGas[kb] = Number(est);
                perChunkLbl[kb] = "eth_estimateGas";
                perChunkWriter.appendRow({
                    measurement_group: "R1b.1",
                    instance: "Demand (OVC-Identity ciphertext)",
                    chunk_size_kb: kb,
                    chunk_size_bytes: bytes,
                    per_chunk_gas: perChunkGas[kb],
                    effective_gas_per_byte: (perChunkGas[kb] / bytes).toFixed(2),
                    method: perChunkLbl[kb],
                    status: "OK",
                });
                console.log(`[R1b.1] ${fmtSize(kb)} = ${perChunkGas[kb].toLocaleString()} gas`);
            } catch (e) {
                perChunkGas[kb] = null;
                perChunkLbl[kb] = "FAIL";
                perChunkWriter.appendRow({
                    measurement_group: "R1b.1",
                    instance: "Demand (OVC-Identity ciphertext)",
                    chunk_size_kb: kb,
                    chunk_size_bytes: bytes,
                    per_chunk_gas: "",
                    effective_gas_per_byte: "",
                    method: perChunkLbl[kb],
                    status: "FAIL",
                });
                console.log(`[R1b.1] ${fmtSize(kb)} FAILED: ${(e.shortMessage || e.message).slice(0, 120)}`);
            }
        }

        // Binding overheads: seal the demand, commit the Identity claim against the
        // demand's rolling hash, link it (setDemand), then accept. All O(1).
        await (await demand.connect(claimant).seal(baselineDemandId)).wait();
        const baselineCommitHash = await demand.ciphertextRollingHash(baselineDemandId);

        const idCommitRec = await (await identity.connect(claimant).commitClaim(
            provider.address, baselineCommitHash, ethers.ZeroHash, 0, keyHash
        )).wait();
        const idClaimId   = extractClaimId(idCommitRec, identity);
        const idCommitGas = Number(idCommitRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1b-overhead",
            instance: "OVC-Identity",
            operation: "commitClaim",
            gas_used: idCommitGas,
            method: "transaction",
            note: "1 KB baseline demand used for per-chunk spectrum",
        });
        console.log(`[R1b] OVC-Identity commitClaim = ${idCommitGas.toLocaleString()} gas`);

        const idSetDemandRec = await (await identity.connect(claimant).setDemand(idClaimId, baselineDemandId)).wait();
        const idSetDemandGas = Number(idSetDemandRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1b-overhead",
            instance: "OVC-Identity",
            operation: "setDemand",
            gas_used: idSetDemandGas,
            method: "transaction",
            note: "C15: links the binding-phase claim to the bidding-phase demand",
        });
        console.log(`[R1b] OVC-Identity setDemand = ${idSetDemandGas.toLocaleString()} gas`);

        const idAcceptRec = await (await identity.connect(provider).acceptClaim(idClaimId)).wait();
        const idAcceptGas = Number(idAcceptRec.gasUsed);
        overheadWriter.appendRow({
            measurement_group: "R1b-overhead",
            instance: "OVC-Identity",
            operation: "acceptClaim",
            gas_used: idAcceptGas,
            method: "transaction",
            note: "C15: acceptClaim reads the demand's rolling hash cross-contract",
        });
        console.log(`[R1b] OVC-Identity acceptClaim = ${idAcceptGas.toLocaleString()} gas`);
        overheadWriter.close();
        perChunkWriter.close();

        // ═════════════════════════════════════════════════════════════════════
        // OUTPUT
        // ═════════════════════════════════════════════════════════════════════

        const summaryLines = [];
        const emitSummary = (line = "") => {
            console.log(line);
            summaryLines.push(line);
        };

        emitSummary("\n" + "=".repeat(80));
        emitSummary("R1 — BINDING PHASE GAS COST (chain-agnostic EVM measurements)");
        emitSummary("=".repeat(80));

        // ── R1a: O(1) instances ──────────────────────────────────────────────
        emitSummary("\nTable R1a: Binding gas for O(1) instances (Access, Conformance, Feature)");
        emitSummary("-".repeat(80));
        emitSummary("| OVC Instance     | commitClaim    | acceptClaim    |");
        emitSummary("|------------------|----------------|----------------|");
        const r1aRows = [
            ["OVC-Access",      accessCommitGas, accessAcceptGas],
            ["OVC-Conformance", confCommitGas,   confAcceptGas],
            ["OVC-Feature",     featCommitGas,   featAcceptGas],
        ];
        for (const [name, c, a] of r1aRows) {
            emitSummary(`| ${name.padEnd(16)} | ${c.toLocaleString().padStart(14)} | ${a.toLocaleString().padStart(14)} |`);
        }

        // ── R1b.1: per-chunk gas spectrum ───────────────────────────────────
        emitSummary("\nTable R1b.1: bidding-phase per-ciphertext-chunk upload gas vs chunk size (Demand.depositCiphertextChunk)");
        emitSummary(`Binding O(1): commitClaim = ${idCommitGas.toLocaleString()} | setDemand = ${idSetDemandGas.toLocaleString()} | acceptClaim = ${idAcceptGas.toLocaleString()} gas`);
        emitSummary("-".repeat(80));
        emitSummary("| Chunk size | Per-chunk gas      | Effective gas/byte | Method          |");
        emitSummary("|------------|--------------------|--------------------|-----------------|");
        for (const kb of CHUNK_SPECTRUM_KB) {
            const g = perChunkGas[kb];
            const bytes = kb * 1024;
            if (g === null) {
                emitSummary(`| ${fmtSize(kb).padEnd(10)} | ${'FAILED'.padStart(18)} | ${'—'.padStart(18)} | ${perChunkLbl[kb].padEnd(15)} |`);
            } else {
                const perByte = (g / bytes).toFixed(2);
                emitSummary(`| ${fmtSize(kb).padEnd(10)} | ${g.toLocaleString().padStart(18)} | ${perByte.padStart(18)} | ${perChunkLbl[kb].padEnd(15)} |`);
            }
        }

        // ── R1b.2: derived total binding gas matrix ──────────────────────────
        emitSummary("\nTable R1b.2: OVC-Identity total demand+bind gas vs chunk × G-code");
        emitSummary("Derived: total = ⌈G-code/chunk⌉ × per_chunk (bidding) + commitClaim + setDemand + acceptClaim (binding)");
        emitSummary("Values shown in gigagas (Ggas, ×10^9)");
        emitSummary("-".repeat(110));

        let header = "| Chunk \\ G-code |";
        for (const gKb of GCODE_SPECTRUM_KB) {
            header += ` ${fmtSize(gKb).padStart(12)} |`;
        }
        emitSummary(header);

        let sep = "|----------------|";
        for (const _ of GCODE_SPECTRUM_KB) sep += "--------------|";
        emitSummary(sep);

        for (const cKb of CHUNK_SPECTRUM_KB) {
            let row = `| ${fmtSize(cKb).padEnd(14)} |`;
            for (const gKb of GCODE_SPECTRUM_KB) {
                const cBytes = cKb * 1024;
                const gBytes = gKb * 1024;
                if (cBytes > gBytes) {
                    row += `${'—'.padStart(12)} |`;
                } else if (perChunkGas[cKb] === null) {
                    row += `${'FAIL'.padStart(12)} |`;
                } else {
                    const N = Math.ceil(gBytes / cBytes);
                    const total = idCommitGas + idSetDemandGas + N * perChunkGas[cKb] + idAcceptGas;
                    const gigaGas = (total / 1e9).toFixed(3);
                    const cell = `${gigaGas}(N=${N})`;
                    row += `${cell.padStart(12)} |`;
                }
            }
            emitSummary(row);
        }

        emitSummary("=".repeat(80));
        emitSummary("Bold diagonal (chunk = G-code) is the monolithic boundary — single tx.");
        emitSummary("Top rows (small chunks) reveal the per-tx ~21 K overhead penalty.");
        emitSummary("=".repeat(80));

        writeSummaryArtifacts(__filename, "R1 Summary", summaryLines);
    });
});
