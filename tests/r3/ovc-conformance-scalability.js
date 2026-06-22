/**
 * R3-C Monolithic — OVC-Conformance single-tx adjudication across the full size spectrum.
 *
 * Uses OVCConformance (non-segmented contract). The entire G-code buffer is
 * submitted in one revealWitness call, so gas grows linearly with G-code size.
 * This establishes the monolithic baseline for comparison against the segmented
 * architecture's diagonal (N=1 chunk = full G-code).
 *
 * Outputs:
 *   experiments/raw-data/r3/ovc-conformance-scalability-raw.csv
 *   experiments/reports/r3/ovc-conformance-scalability.txt
 *   experiments/reports/r3/ovc-conformance-scalability.md
 *
 * Run: npx hardhat test tests/r3/ovc-conformance-scalability.js --network localhost
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

function writeSummaryArtifacts(scriptFile, title, lines) {
    fs.mkdirSync(SUMMARY_DIR, { recursive: true });
    const baseName = path.basename(scriptFile, path.extname(scriptFile));
    const mdPath  = path.join(SUMMARY_DIR, `${baseName}.md`);
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

describe("R3-C Monolithic — OVC-Conformance single-tx adjudication spectrum", function () {
    it("benchmarks revealWitness gas across the full G-code size spectrum", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();

        const rawWriter = createCsvReportWriter(
            __filename, "raw",
            ["measurement_group", "instance", "gcode_size_label", "gcode_size_bytes", "operation", "gas_used", "gas_per_byte", "method", "status", "note"],
            { subdir: "r3" }
        );

        const Factory = await ethers.getContractFactory("OVCConformance");
        const ovcConformance = await Factory.deploy(100);
        await ovcConformance.waitForDeployment();

        const summaryLines = [];
        const emit = (line = "") => { console.log(line); summaryLines.push(line); };

        emit("\n" + "=".repeat(90));
        emit(`R3-C Monolithic — OVC-Conformance single-tx adjudication | Node: ${network.name}`);
        emit("=".repeat(90));
        emit("| G-code size | revealWitness gas    | gas/byte | Status |");
        emit("|-------------|----------------------|----------|--------|");

        for (const s of TEST_SIZES) {
            try {
                // Worst-case payload: valid G1 opcode at the very end forces a full buffer scan.
                const buffer = Buffer.alloc(s.bytes, 0x58);
                buffer.write("G1", s.bytes - 2);
                const pHash = ethers.keccak256(buffer);

                const commitRec = await (await ovcConformance.connect(claimant).commitClaim(
                    provider.address, pHash, pHash, 0, ethers.ZeroHash
                )).wait();
                const parsed = commitRec.logs
                    .map(l => { try { return ovcConformance.interface.parseLog(l); } catch { return null; } })
                    .find(e => e && e.name === "ClaimCommitted");
                const claimId = parsed.args.claimId;

                await (await ovcConformance.connect(provider).disputeClaim(claimId)).wait();

                const revealRec = await (await ovcConformance.connect(claimant).revealWitness(
                    claimId, buffer, { gasLimit: 50_000_000_000n }
                )).wait();

                const gasUsed   = Number(revealRec.gasUsed);
                const perByte   = (gasUsed / s.bytes).toFixed(2);

                rawWriter.appendRow({
                    measurement_group: "R3C-monolithic",
                    instance:          "OVC-Conformance",
                    gcode_size_label:  s.label,
                    gcode_size_bytes:  s.bytes,
                    operation:         "revealWitness",
                    gas_used:          gasUsed,
                    gas_per_byte:      perByte,
                    method:            "transaction",
                    status:            "OK",
                    note:              "Worst-case: G1 opcode at end of buffer forces full-buffer scan.",
                });

                emit(`| ${s.label.padEnd(11)} | ${gasUsed.toLocaleString().padStart(20)} | ${perByte.padStart(8)} | OK     |`);
            } catch (error) {
                rawWriter.appendRow({
                    measurement_group: "R3C-monolithic",
                    instance:          "OVC-Conformance",
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

        emit("=".repeat(90));
        emit("Monolithic baseline: entire G-code submitted in a single revealWitness tx.");
        emit("Compare diagonal (N=1) of R3-C segmented matrix for segmentation overhead.");
        emit("=".repeat(90));

        rawWriter.close();
        writeSummaryArtifacts(__filename, "R3-C Monolithic Summary", summaryLines);
    });
});
