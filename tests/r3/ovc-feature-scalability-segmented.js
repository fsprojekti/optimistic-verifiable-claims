/**
 * R3-F — OVC-Feature adjudication chunk-size spectrum.
 *
 * Measures OVC-Feature dispute-path adjudication in the same report-oriented
 * format used by R1 and R2: raw CSV outputs plus txt/md summary artifacts.
 *
 * Env overrides (comma-separated KB values):
 *   R3_CHUNK_SPECTRUM_KB   default: 1,4,16,64,128,256,512,1024,5120,10240,25600,51200
 *   R3_GCODE_SPECTRUM_KB   default: 64,256,1024,5120,10240,25600,51200
 *
 * Run: npx hardhat test tests/r3/ovc-feature-scalability-segmented.js --network localhost
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

// ── Constants ──────────────────────────────────────────────────────────────────

const OUTPUT_SUBDIR = process.env.OVC_OUTPUT_SUBDIR || "r3";
const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", OUTPUT_SUBDIR);
const DISPUTE_WINDOW = 100_000;

function parseSpectrum(envName, fallback) {
    const raw = process.env[envName];
    if (!raw) return fallback;
    return raw.split(",").map(v => Number(v.trim())).filter(v => Number.isFinite(v) && v > 0);
}

const CHUNK_SPECTRUM_KB = parseSpectrum(
    "R3_CHUNK_SPECTRUM_KB",
    [1, 4, 8, 12, 16, 64, 128, 256, 512, 1024, 5 * 1024, 10 * 1024, 25 * 1024, 50 * 1024]
);
const GCODE_SPECTRUM_KB = parseSpectrum(
    "R3_GCODE_SPECTRUM_KB",
    [64, 256, 1024, 5 * 1024, 10 * 1024, 25 * 1024, 50 * 1024]
);

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtSize(kb) {
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
}

function depositGasLimit(bytes) {
    return Math.ceil(bytes * 1500) + 100_000_000;
}

function estimateGasLimit(bytes) {
    return Math.ceil(bytes * 2500) + 200_000_000;
}

function extractClaimId(receipt, contract) {
    const parsed = receipt.logs
        .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find(event => event && event.name === "ClaimCommitted");
    return parsed.args.claimId;
}

function rollingKeccak(buffer, chunkSize) {
    let hash = ethers.ZeroHash;
    for (let offset = 0; offset < buffer.length; offset += chunkSize) {
        const chunk = buffer.slice(offset, Math.min(offset + chunkSize, buffer.length));
        hash = ethers.keccak256(ethers.concat([hash, chunk]));
    }
    return hash;
}

async function withHeartbeat(label, promise, intervalMs = 5000) {
    const start = Date.now();
    const timer = setInterval(() => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(0);
        console.log(`  ... ${label} still running (${elapsed}s)`);
    }, intervalMs);
    try {
        const result = await promise;
        clearInterval(timer);
        return result;
    } catch (err) {
        clearInterval(timer);
        throw err;
    }
}

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

describe("R3-F — OVC-Feature adjudication chunk-size spectrum", function () {
    it("measures per-process-chunk gas and derives the OVC-Feature adjudication matrix", async function () {
        this.timeout(0);

        const [claimant, provider] = await ethers.getSigners();

        const overheadWriter = createCsvReportWriter(
            __filename, "overheads-raw",
            ["measurement_group", "instance", "operation", "gas_used", "method", "note"],
            { subdir: OUTPUT_SUBDIR }
        );
        const perChunkWriter = createCsvReportWriter(
            __filename, "per-chunk-raw",
            ["measurement_group", "instance", "chunk_size_kb", "chunk_size_bytes", "per_chunk_gas", "effective_gas_per_byte", "method", "status", "note"],
            { subdir: OUTPUT_SUBDIR }
        );
        const matrixWriter = createCsvReportWriter(
            __filename, "matrix-raw",
            ["measurement_group", "instance", "chunk_size_kb", "gcode_size_kb", "chunk_count", "total_gas", "total_gigagas", "status", "note"],
            { subdir: OUTPUT_SUBDIR }
        );

        const contract = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(DISPUTE_WINDOW);
        await contract.waitForDeployment();

        const perChunkGas = {};
        const overheads   = {};

        // G-code payload. M83 puts the machine in relative extrusion so every motion
        // line contributes its E value to the accumulator — under absolute mode a
        // repeated constant E would contribute only once and exercise nothing.
        // claimValue is therefore 10mm per line, scaled by 1e5.
        const MODE_HEADER = "M83\n";
        const GCODE_LINE  = "G1 X10.0 Y10.0 E10\n";

        function buildPayload(bytes) {
            const body      = Math.max(0, bytes - MODE_HEADER.length);
            const repeats   = Math.max(1, Math.floor(body / GCODE_LINE.length));
            const plaintext = Buffer.from(
                (MODE_HEADER + GCODE_LINE.repeat(repeats)).padEnd(bytes, " ")
            );
            const claimValue = BigInt(10 * repeats) * 100000n;
            return { plaintext, claimValue };
        }

        // ── Overhead baseline (1 KB) ─────────────────────────────────────────
        // Feature: G is deposited AFTER dispute (not at binding).
        // Runs commit → dispute → depositChunk(G) → startAdjudication
        // → processChunk → finalizeAdjudication to capture O(1) costs.
        try {
            const baselineBytes = 1024;
            const { plaintext, claimValue } = buildPayload(baselineBytes);
            const commitment = rollingKeccak(plaintext, baselineBytes);

            const commitRec = await (await contract.connect(claimant).commitClaim(
                provider.address, commitment, ethers.ZeroHash, claimValue, ethers.ZeroHash
            )).wait();
            const claimId = extractClaimId(commitRec, contract);

            const disputeRec = await (await contract.connect(provider).disputeClaim(claimId)).wait();

            await (await contract.connect(claimant).depositChunk(
                claimId, plaintext, { gasLimit: depositGasLimit(baselineBytes) }
            )).wait();

            const startAdjRec  = await (await contract.connect(claimant).startAdjudication(claimId)).wait();

            await (await contract.connect(claimant).processChunk(
                claimId, { gasLimit: estimateGasLimit(baselineBytes) }
            )).wait();

            const finalizeRec  = await (await contract.connect(claimant).finalizeAdjudication(claimId)).wait();

            overheads.commitClaim          = Number(commitRec.gasUsed);
            overheads.disputeClaim         = Number(disputeRec.gasUsed);
            overheads.startAdjudication    = Number(startAdjRec.gasUsed);
            overheads.finalizeAdjudication = Number(finalizeRec.gasUsed);

            const overheadNote = "Measured on a 1 KB baseline claim; commit/dispute recorded for completeness, excluded from derived matrix.";
            for (const [operation, gas] of Object.entries(overheads)) {
                overheadWriter.appendRow({
                    measurement_group: "R3F-overhead",
                    instance: "OVC-Feature",
                    operation,
                    gas_used: gas,
                    method: "transaction",
                    note: overheadNote,
                });
            }
            console.log(`[R3b-F] Overhead baseline OK — startAdj=${overheads.startAdjudication?.toLocaleString()} finalize=${overheads.finalizeAdjudication?.toLocaleString()}`);
        } catch (error) {
            console.log(`[R3b-F] Overhead baseline FAIL: ${(error.shortMessage || error.message).slice(0, 120)}`);
        }

        // ── Per-chunk spectrum ───────────────────────────────────────────────
        // For each chunk size: commit → dispute → depositChunk(G) → startAdjudication
        // then estimateGas processChunk. Payload is G-code lines with integer E-values
        // to exercise numeric extraction logic.
        for (const chunkKb of CHUNK_SPECTRUM_KB) {
            const bytes = chunkKb * 1024;
            const { plaintext, claimValue } = buildPayload(bytes);
            const commitment = rollingKeccak(plaintext, bytes);

            try {
                const commitRec = await (await contract.connect(claimant).commitClaim(
                    provider.address, commitment, ethers.ZeroHash, claimValue, ethers.ZeroHash
                )).wait();
                const claimId = extractClaimId(commitRec, contract);

                await (await contract.connect(provider).disputeClaim(claimId)).wait();

                await (await contract.connect(claimant).depositChunk(
                    claimId, plaintext, { gasLimit: depositGasLimit(bytes) }
                )).wait();

                await (await contract.connect(claimant).startAdjudication(claimId)).wait();

                const processEstimate = await withHeartbeat(
                    `[R3b-F] ${fmtSize(chunkKb)} estimateGas`,
                    ethers.provider.estimateGas({
                        from:     claimant.address,
                        to:       await contract.getAddress(),
                        data:     contract.interface.encodeFunctionData("processChunk", [claimId]),
                        gasLimit: estimateGasLimit(bytes),
                    })
                );
                perChunkGas[chunkKb] = Number(processEstimate);

                perChunkWriter.appendRow({
                    measurement_group:      "R3F-per-chunk",
                    instance:               "OVC-Feature",
                    chunk_size_kb:          chunkKb,
                    chunk_size_bytes:       bytes,
                    per_chunk_gas:          perChunkGas[chunkKb],
                    effective_gas_per_byte: (perChunkGas[chunkKb] / bytes).toFixed(2),
                    method:                 "eth_estimateGas",
                    status:                 "OK",
                    note:                   "Numeric extraction over G-code-like lines with integer E-values.",
                });
                console.log(`[R3b-F] ${fmtSize(chunkKb)} processChunk = ${perChunkGas[chunkKb].toLocaleString()} gas`);
            } catch (error) {
                perChunkGas[chunkKb] = null;
                perChunkWriter.appendRow({
                    measurement_group:      "R3F-per-chunk",
                    instance:               "OVC-Feature",
                    chunk_size_kb:          chunkKb,
                    chunk_size_bytes:       bytes,
                    per_chunk_gas:          "",
                    effective_gas_per_byte: "",
                    method:                 "FAIL",
                    status:                 "FAIL",
                    note:                   (error.shortMessage || error.message).slice(0, 120),
                });
                console.log(`[R3b-F] ${fmtSize(chunkKb)} FAIL: ${(error.shortMessage || error.message).slice(0, 120)}`);
            }
        }

        overheadWriter.close();
        perChunkWriter.close();

        // ── Output ────────────────────────────────────────────────────────────
        const summaryLines = [];
        const emit = (line = "") => { console.log(line); summaryLines.push(line); };

        const totalOverheadGas =
            (overheads.startAdjudication   ?? 0) +
            (overheads.finalizeAdjudication ?? 0);

        emit(`\n${"=".repeat(88)}`);
        emit("R3-F — OVC-Feature adjudication chunk-size spectrum");
        emit("=".repeat(88));
        emit(
            `Measured O(1) adjudication overheads: ` +
            `startAdjudication=${overheads.startAdjudication?.toLocaleString() ?? "-"} | ` +
            `finalizeAdjudication=${overheads.finalizeAdjudication?.toLocaleString() ?? "-"}`
        );
        emit("G is deposited only after dispute. The derived matrix covers adjudication txs only: startAdjudication + N * processChunk + finalizeAdjudication.");

        // Per-chunk table
        emit(`\nTable R3a-F: OVC-Feature per-process-chunk gas vs chunk size`);
        emit("-".repeat(88));
        emit("| Chunk size | Per-process gas   | Effective gas/byte | Method          |");
        emit("|------------|-------------------|--------------------|-----------------|");
        for (const kb of CHUNK_SPECTRUM_KB) {
            const gas   = perChunkGas[kb];
            const bytes = kb * 1024;
            if (gas === null) {
                emit(`| ${fmtSize(kb).padEnd(10)} | ${"FAILED".padStart(17)} | ${"-".padStart(18)} | ${"FAIL".padEnd(15)} |`);
            } else {
                emit(`| ${fmtSize(kb).padEnd(10)} | ${gas.toLocaleString().padStart(17)} | ${(gas / bytes).toFixed(2).padStart(18)} | ${"eth_estimateGas".padEnd(15)} |`);
            }
        }

        // Derived matrix
        emit(`\nTable R3b-F: Total adjudication gas - OVC-Feature (gigagas, x10^9)`);
        const matrixNote = "Total includes startAdjudication + N * processChunk + finalizeAdjudication.";

        let header = "| Chunk \\ G-code |";
        for (const gcodeKb of GCODE_SPECTRUM_KB) header += ` ${fmtSize(gcodeKb).padStart(12)} |`;
        emit(header);

        let separator = "|----------------|";
        for (const _ of GCODE_SPECTRUM_KB) separator += "--------------|";
        emit(separator);

        for (const chunkKb of CHUNK_SPECTRUM_KB) {
            let row = `| ${fmtSize(chunkKb).padEnd(14)} |`;
            const chunkBytes = chunkKb * 1024;

            for (const gcodeKb of GCODE_SPECTRUM_KB) {
                const gcodeBytes = gcodeKb * 1024;

                if (chunkBytes > gcodeBytes) {
                    row += `${"-".padStart(12)} |`;
                    matrixWriter.appendRow({ measurement_group: "R3b-F", instance: "OVC-Feature", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: "", total_gas: "", total_gigagas: "", status: "DEGENERATE", note: matrixNote });
                    continue;
                }
                const gas = perChunkGas[chunkKb];
                if (gas === null) {
                    row += `${"FAIL".padStart(12)} |`;
                    matrixWriter.appendRow({ measurement_group: "R3b-F", instance: "OVC-Feature", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: "", total_gas: "", total_gigagas: "", status: "FAIL", note: matrixNote });
                    continue;
                }
                const chunkCount   = Math.ceil(gcodeBytes / chunkBytes);
                const totalGas     = totalOverheadGas + chunkCount * gas;
                const totalGigagas = (totalGas / 1e9).toFixed(3);
                row += `${`${totalGigagas}(N=${chunkCount})`.padStart(12)} |`;
                matrixWriter.appendRow({ measurement_group: "R3b-F", instance: "OVC-Feature", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: chunkCount, total_gas: totalGas, total_gigagas: totalGigagas, status: "OK", note: matrixNote });
            }
            emit(row);
        }

        emit(`\n${"=".repeat(88)}`);
        emit("Methodology: processChunk gas measured via eth_estimateGas after commit -> dispute -> depositChunk(G) -> startAdjudication. Finalize gas measured from a real tx on a 1 KB baseline claim.");
        emit("=".repeat(88));

        matrixWriter.close();
        writeSummaryArtifacts(__filename, "R3-F Summary", summaryLines);
    });
});
