/**
 * R3-I Monolithic — OVC-Identity single-tx adjudication across the full size spectrum.
 *
 * Uses OVCIdentity (non-segmented contract). The full ciphertext C is uploaded
 * at binding in one commitIdentityClaim call; adjudication is a single revealWitness
 * that decrypts C against revealed K and verifies integrity. Gas grows linearly
 * with G-code size.
 *
 * This establishes the monolithic baseline for comparison against the segmented
 * architecture's diagonal (N=1 chunk = full G-code) in R3-I segmented.
 *
 * Outputs:
 *   experiments/raw-data/r3/ovc-identity-scalability-raw.csv
 *   experiments/reports/r3/ovc-identity-scalability.md
 *
 * Run: npx hardhat test tests/r3/ovc-identity-scalability.js --network localhost
 */

const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

// ── Constants ──────────────────────────────────────────────────────────────────

const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", "r3");
const SECRET_K = Buffer.alloc(32, 0x42);

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

function xorEncrypt(buffer, key32) {
    const out = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] ^ key32[i % 32];
    return out;
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

describe("R3-I Monolithic — OVC-Identity single-tx adjudication spectrum", function () {
    it("benchmarks revealWitness gas across the full G-code size spectrum", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();

        const rawWriter = createCsvReportWriter(
            __filename, "raw",
            ["measurement_group", "instance", "gcode_size_label", "gcode_size_bytes", "operation", "gas_used", "gas_per_byte", "method", "status", "note"],
            { subdir: "r3" }
        );

        const Factory = await ethers.getContractFactory("OVCIdentity");
        const ovcIdentity = await Factory.deploy(100);
        await ovcIdentity.waitForDeployment();

        const summaryLines = [];
        const emit = (line = "") => { console.log(line); summaryLines.push(line); };

        emit("\n" + "=".repeat(90));
        emit(`R3-I Monolithic — OVC-Identity single-tx adjudication | Node: ${network.name}`);
        emit("=".repeat(90));
        emit("| G-code size | revealWitness gas    | gas/byte | Status |");
        emit("|-------------|----------------------|----------|--------|");

        try { for (const s of TEST_SIZES) {
            try {
                const gcode      = Buffer.alloc(s.bytes, 0x58);
                const ciphertext = xorEncrypt(gcode, SECRET_K);
                // Commitment = H(K || G || C) — triple-witness hash
                const commitment = ethers.keccak256(ethers.concat([SECRET_K, gcode, ciphertext]));

                // TX #1: binding — C stored on-chain; gas is O(|C|)
                const commitRec = await (await ovcIdentity.connect(claimant).commitIdentityClaim(
                    provider.address, commitment, ciphertext,
                    { gasLimit: BigInt(Math.ceil(s.bytes * 1500)) + 100_000_000n }
                )).wait();
                const claimId    = extractClaimId(commitRec, ovcIdentity);
                // TX #2: dispute
                await (await ovcIdentity.connect(provider).disputeClaim(claimId)).wait();

                // TX #3: full witness K || G || C — base class hashes it against commitment,
                // then _verifyPredicate runs the XOR loop. Both are O(|G|).
                const witness    = ethers.concat([SECRET_K, gcode, ciphertext]);
                const revealRec  = await (await ovcIdentity.connect(claimant).revealWitness(
                    claimId, witness, { gasLimit: BigInt(Math.ceil(s.bytes * 3000)) + 100_000_000n }
                )).wait();
                const adjudGas   = Number(revealRec.gasUsed);
                const perByte    = (adjudGas / s.bytes).toFixed(2);

                rawWriter.appendRow({
                    measurement_group: "R3I-monolithic",
                    instance:          "OVC-Identity",
                    gcode_size_label:  s.label,
                    gcode_size_bytes:  s.bytes,
                    operation:         "revealWitness",
                    gas_used:          adjudGas,
                    gas_per_byte:      perByte,
                    method:            "transaction",
                    status:            "OK",
                    note:              "Adjudication: reads stored C, decrypts against revealed K, verifies rolling hash.",
                });

                emit(`| ${s.label.padEnd(11)} | ${adjudGas.toLocaleString().padStart(20)} | ${perByte.padStart(8)} | OK     |`);
            } catch (error) {
                rawWriter.appendRow({
                    measurement_group: "R3I-monolithic",
                    instance:          "OVC-Identity",
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
        } } finally {
            emit("=".repeat(90));
            emit("Monolithic baseline: C uploaded and adjudicated in single transactions.");
            emit("Compare diagonal (N=1) of R3-I segmented matrix for segmentation overhead.");
            emit("=".repeat(90));

            rawWriter.close();
            writeSummaryArtifacts(__filename, "R3-I Monolithic Summary", summaryLines);
        }
    });
});
