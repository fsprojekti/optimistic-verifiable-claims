/**
 * R3-F Monolithic — OVC-Feature single-tx adjudication across the full size spectrum.
 *
 * Uses OVCFeature (non-segmented contract). The entire G-code buffer is submitted
 * in one revealWitness call; adjudication parses E-values and sums them in a single
 * transaction. Gas grows linearly with G-code size.
 *
 * This establishes the monolithic baseline for comparison against the segmented
 * architecture's diagonal (N=1 chunk = full G-code) in R3-F segmented.
 *
 * Outputs:
 *   experiments/raw-data/r3/ovc-feature-scalability-raw.csv
 *   experiments/reports/r3/ovc-feature-scalability.md
 *
 * Run: npx hardhat test tests/r3/ovc-feature-scalability.js --network localhost
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

// ── Constants ──────────────────────────────────────────────────────────────────

const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", "r3");

const TEST_SIZES = [
    { label: "1 KB",   bytes: 1 * 1024 },
    { label: "4 KB",   bytes: 4 * 1024 },
    { label: "16 KB",  bytes: 16 * 1024 },
    { label: "64 KB",  bytes: 64 * 1024 },
    { label: "256 KB", bytes: 256 * 1024 },
    { label: "512 KB", bytes: 512 * 1024 },
    { label: "1 MB",   bytes: 1 * 1024 * 1024 },
    { label: "5 MB",   bytes: 5 * 1024 * 1024 },
    { label: "10 MB",  bytes: 10 * 1024 * 1024 },
    { label: "25 MB",  bytes: 25 * 1024 * 1024 },
    { label: "50 MB",  bytes: 50 * 1024 * 1024 },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

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
    fs.writeFileSync(mdPath, [
        `# ${title}`,
        "",
        `Source script: ${path.relative(process.cwd(), scriptFile)}`,
        "",
        "```text",
        ...lines,
        "```",
        "",
    ].join("\n"), "utf8");
    console.log(`[report] Wrote ${path.relative(process.cwd(), mdPath)}`);
}

// ── Test ───────────────────────────────────────────────────────────────────────

describe("R3-F Monolithic — OVC-Feature single-tx adjudication spectrum", function () {
    it("benchmarks revealWitness gas across the full G-code size spectrum", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();

        const rawWriter = createCsvReportWriter(
            __filename, "raw",
            ["measurement_group", "instance", "gcode_size_label", "gcode_size_bytes", "operation", "gas_used", "gas_per_byte", "method", "status", "note"],
            { subdir: "r3" }
        );

        const Factory = await ethers.getContractFactory("OVCFeature");
        const ovcFeature = await Factory.deploy(100);
        await ovcFeature.waitForDeployment();

        const summaryLines = [];
        const emit = (line = "") => { console.log(line); summaryLines.push(line); };

        emit("\n" + "=".repeat(95));
        emit(`R3-F Monolithic — OVC-Feature single-tx adjudication | Node: ${network.name}`);
        emit("=".repeat(95));
        emit("| G-code size | revealWitness gas    | gas/byte | Status |");
        emit("|-------------|----------------------|----------|--------|");

        // G-code line used for all payload generation.
        // claimValue = 123 * repeats (E=0.123 scaled by 1000).
        const GCODE_LINE = "G1 X10.0 Y10.0 E0.123\n";

        for (const s of TEST_SIZES) {
            try {
                const repeats       = Math.floor(s.bytes / GCODE_LINE.length);
                const buffer        = Buffer.from(GCODE_LINE.repeat(repeats).padEnd(s.bytes, " "));
                const pHash         = ethers.keccak256(buffer);
                const expectedESum  = 123 * repeats;

                const commitRec = await (await ovcFeature.connect(claimant).commitClaim(
                    provider.address, pHash, ethers.ZeroHash, expectedESum, ethers.ZeroHash
                )).wait();
                const claimId = extractClaimId(commitRec, ovcFeature);

                await (await ovcFeature.connect(provider).disputeClaim(claimId)).wait();

                const revealRec = await (await ovcFeature.connect(claimant).revealWitness(
                    claimId, buffer, { gasLimit: 60_000_000_000n }
                )).wait();

                const gasUsed = Number(revealRec.gasUsed);
                const perByte = (gasUsed / s.bytes).toFixed(2);

                rawWriter.appendRow({
                    measurement_group: "R3F-monolithic",
                    instance:          "OVC-Feature",
                    gcode_size_label:  s.label,
                    gcode_size_bytes:  s.bytes,
                    operation:         "revealWitness",
                    gas_used:          gasUsed,
                    gas_per_byte:      perByte,
                    method:            "transaction",
                    status:            "OK",
                    note:              "Numeric E-value extraction and sum over entire buffer in one tx.",
                });

                emit(`| ${s.label.padEnd(11)} | ${gasUsed.toLocaleString().padStart(20)} | ${perByte.padStart(8)} | OK     |`);
            } catch (error) {
                rawWriter.appendRow({
                    measurement_group: "R3F-monolithic",
                    instance:          "OVC-Feature",
                    gcode_size_label:  s.label,
                    gcode_size_bytes:  s.bytes,
                    operation:         "revealWitness",
                    gas_used:          "",
                    gas_per_byte:      "",
                    method:            "transaction",
                    status:            "FAIL",
                    note:              (error.shortMessage || error.message).slice(0, 120),
                });
                emit(`| ${s.label.padEnd(11)} | ${"FAILED".padStart(20)} | ${"-".padStart(8)} | FAIL   |`);
            }
        }

        emit("=".repeat(95));
        emit("Monolithic baseline: entire G-code submitted in a single revealWitness tx.");
        emit("Compare diagonal (N=1) of R3-F segmented matrix for segmentation overhead.");
        emit("=".repeat(95));

        rawWriter.close();
        writeSummaryArtifacts(__filename, "R3-F Monolithic Summary", summaryLines);
    });
});
