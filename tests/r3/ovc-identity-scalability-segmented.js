/**
 * R3-I — OVC-Identity adjudication chunk-size spectrum.
 *
 * Measures OVC-Identity dispute-path adjudication in the same report-oriented
 * format used by R1 and R2: raw CSV outputs plus txt/md summary artifacts.
 *
 * Env overrides (comma-separated KB values):
 *   R3_CHUNK_SPECTRUM_KB   default: 1,4,16,64,128,256,512,1024,5120,10240,25600,51200
 *   R3_GCODE_SPECTRUM_KB   default: 64,256,1024,5120,10240,25600,51200
 *
 * Run: npx hardhat test tests/r3/ovc-identity-scalability-segmented.js --network localhost
 */

const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

// ── Constants ──────────────────────────────────────────────────────────────────

const OUTPUT_SUBDIR = process.env.OVC_OUTPUT_SUBDIR || "r3";
const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", OUTPUT_SUBDIR);
const SECRET_K = Buffer.alloc(32, 0x42);
const KEY_HASH = ethers.keccak256(SECRET_K);
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

// Upper bound handed to eth_estimateGas. Identity's processChunk allocates a
// decrypted buffer per chunk, so its memory-expansion cost grows quadratically and
// the effective gas/byte climbs with chunk size (~800 at 16 KB, ~1800 at 25 MB).
// 4000/byte keeps the 50 MB point inside the allowance while staying under anvil's
// 300 Ggas node limit. This is only a ceiling — it does not affect the estimate.
function estimateGasLimit(bytes) {
    return Math.ceil(bytes * 4000) + 200_000_000;
}

function extractClaimId(receipt, contract) {
    const parsed = receipt.logs
        .map(log => { try { return contract.interface.parseLog(log); } catch { return null; } })
        .find(event => event && event.name === "ClaimCommitted");
    return parsed.args.claimId;
}

function xorEncrypt(buffer, key32) {
    const out = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i++) out[i] = buffer[i] ^ key32[i % 32];
    return out;
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

describe("R3-I — OVC-Identity adjudication chunk-size spectrum", function () {
    it("measures per-process-chunk gas and derives the OVC-Identity adjudication matrix", async function () {
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

        // C15: ciphertext lives in the Demand store (posted at bidding); OVC-Identity
        // reads it cross-contract during adjudication. Deploy the Demand, wire Identity
        // to it, and let the claimant act as coordinator so it can call setDemand.
        const demand   = await (await (await ethers.getContractFactory("Demand")).deploy()).waitForDeployment();
        const contract = await (await ethers.getContractFactory("OVCIdentitySegmented"))
            .deploy(DISPUTE_WINDOW, await demand.getAddress());
        await contract.waitForDeployment();
        await (await contract.setCoordinator(claimant.address)).wait();

        // Bidding + binding setup for a single ciphertext chunk, left in Adjudicating
        // state ready for a processChunk gas estimate. Returns the Identity claimId.
        async function setupDispute(ciphertext, hG) {
            await (await demand.connect(claimant).postDemand(hG, 0)).wait();
            const demandId = await demand.demandCount();
            await (await demand.connect(claimant).depositCiphertextChunk(
                demandId, ciphertext, { gasLimit: depositGasLimit(ciphertext.length) }
            )).wait();
            await (await demand.connect(claimant).seal(demandId)).wait();
            const hC = await demand.ciphertextRollingHash(demandId);

            const commitRec = await (await contract.connect(claimant).commitClaim(
                provider.address, hC, hG, 0, KEY_HASH
            )).wait();
            const claimId = extractClaimId(commitRec, contract);
            await (await contract.connect(claimant).setDemand(claimId, demandId)).wait();
            await (await contract.connect(provider).disputeClaim(claimId)).wait();
            await (await contract.connect(claimant).revealKey(claimId, SECRET_K)).wait();
            await (await contract.connect(claimant).startAdjudication(claimId)).wait();
            return claimId;
        }

        const perChunkGas = {};
        const overheads   = {};

        // ── Overhead baseline (1 KB) ─────────────────────────────────────────
        // Runs a complete commit → deposit → dispute → revealKey → startAdjudication
        // → processChunk → finalizeAdjudication cycle to capture O(1) costs.
        try {
            const baselineBytes  = 1024;
            const plaintext      = Buffer.alloc(baselineBytes, 0x47);
            const ciphertext     = xorEncrypt(plaintext, SECRET_K);
            const auxHash        = rollingKeccak(plaintext, baselineBytes);

            // Bidding: post + upload one chunk + seal.
            await (await demand.connect(claimant).postDemand(auxHash, 0)).wait();
            const demandId = await demand.demandCount();
            await (await demand.connect(claimant).depositCiphertextChunk(
                demandId, ciphertext, { gasLimit: depositGasLimit(baselineBytes) }
            )).wait();
            await (await demand.connect(claimant).seal(demandId)).wait();
            const commitment = await demand.ciphertextRollingHash(demandId);

            // Binding: commit Identity, link the demand.
            const commitRec      = await (await contract.connect(claimant).commitClaim(
                provider.address, commitment, auxHash, 0, KEY_HASH
            )).wait();
            const claimId        = extractClaimId(commitRec, contract);
            await (await contract.connect(claimant).setDemand(claimId, demandId)).wait();

            const disputeRec       = await (await contract.connect(provider).disputeClaim(claimId)).wait();
            const revealKeyRec     = await (await contract.connect(claimant).revealKey(claimId, SECRET_K)).wait();
            const startAdjRec      = await (await contract.connect(claimant).startAdjudication(claimId)).wait();

            await (await contract.connect(claimant).processChunk(
                claimId, { gasLimit: estimateGasLimit(baselineBytes) }
            )).wait();

            const finalizeRec      = await (await contract.connect(claimant).finalizeAdjudication(claimId)).wait();

            overheads.commitClaim         = Number(commitRec.gasUsed);
            overheads.disputeClaim        = Number(disputeRec.gasUsed);
            overheads.revealKey           = Number(revealKeyRec.gasUsed);
            overheads.startAdjudication   = Number(startAdjRec.gasUsed);
            overheads.finalizeAdjudication = Number(finalizeRec.gasUsed);

            const overheadNote = "Measured on a 1 KB baseline claim; commit/dispute recorded for completeness, excluded from derived matrix.";
            for (const [operation, gas] of Object.entries(overheads)) {
                overheadWriter.appendRow({
                    measurement_group: "R3I-overhead",
                    instance: "OVC-Identity",
                    operation,
                    gas_used: gas,
                    method: "transaction",
                    note: overheadNote,
                });
            }
            console.log(`[R3b-I] Overhead baseline OK — revealKey=${overheads.revealKey?.toLocaleString()} startAdj=${overheads.startAdjudication?.toLocaleString()} finalize=${overheads.finalizeAdjudication?.toLocaleString()}`);
        } catch (error) {
            console.log(`[R3b-I] Overhead baseline FAIL: ${(error.shortMessage || error.message).slice(0, 120)}`);
        }

        // ── Per-chunk spectrum ───────────────────────────────────────────────
        // For each chunk size: create a fresh claim, deposit ciphertext, trigger
        // dispute, reveal key, start adjudication, then estimateGas processChunk.
        for (const chunkKb of CHUNK_SPECTRUM_KB) {
            const bytes      = chunkKb * 1024;
            const plaintext  = Buffer.alloc(bytes, 0x47);
            const ciphertext = xorEncrypt(plaintext, SECRET_K);
            const auxHash    = rollingKeccak(plaintext, bytes);

            try {
                const claimId = await setupDispute(ciphertext, auxHash);

                const processEstimate = await withHeartbeat(
                    `[R3b-I] ${fmtSize(chunkKb)} estimateGas`,
                    ethers.provider.estimateGas({
                        from:     claimant.address,
                        to:       await contract.getAddress(),
                        data:     contract.interface.encodeFunctionData("processChunk", [claimId]),
                        gasLimit: estimateGasLimit(bytes),
                    })
                );
                perChunkGas[chunkKb] = Number(processEstimate);

                perChunkWriter.appendRow({
                    measurement_group:    "R3I-per-chunk",
                    instance:             "OVC-Identity",
                    chunk_size_kb:        chunkKb,
                    chunk_size_bytes:     bytes,
                    per_chunk_gas:        perChunkGas[chunkKb],
                    effective_gas_per_byte: (perChunkGas[chunkKb] / bytes).toFixed(2),
                    method:               "eth_estimateGas",
                    status:               "OK",
                    note:                 "Ciphertext C posted to the Demand at bidding; processChunk reads it cross-contract from the Demand and decrypts against revealed K.",
                });
                console.log(`[R3b-I] ${fmtSize(chunkKb)} processChunk = ${perChunkGas[chunkKb].toLocaleString()} gas`);
            } catch (error) {
                perChunkGas[chunkKb] = null;
                perChunkWriter.appendRow({
                    measurement_group:      "R3I-per-chunk",
                    instance:               "OVC-Identity",
                    chunk_size_kb:          chunkKb,
                    chunk_size_bytes:       bytes,
                    per_chunk_gas:          "",
                    effective_gas_per_byte: "",
                    method:                 "FAIL",
                    status:                 "FAIL",
                    note:                   (error.shortMessage || error.message).slice(0, 120),
                });
                console.log(`[R3b-I] ${fmtSize(chunkKb)} FAIL: ${(error.shortMessage || error.message).slice(0, 120)}`);
            }
        }

        overheadWriter.close();
        perChunkWriter.close();

        // ── Output ────────────────────────────────────────────────────────────
        const summaryLines = [];
        const emit = (line = "") => { console.log(line); summaryLines.push(line); };

        const totalOverheadGas =
            (overheads.revealKey           ?? 0) +
            (overheads.startAdjudication   ?? 0) +
            (overheads.finalizeAdjudication ?? 0);

        emit(`\n${"=".repeat(88)}`);
        emit("R3-I — OVC-Identity adjudication chunk-size spectrum");
        emit("=".repeat(88));
        emit(
            `Measured O(1) adjudication overheads: ` +
            `revealKey=${overheads.revealKey?.toLocaleString() ?? "-"} | ` +
            `startAdjudication=${overheads.startAdjudication?.toLocaleString() ?? "-"} | ` +
            `finalizeAdjudication=${overheads.finalizeAdjudication?.toLocaleString() ?? "-"}`
        );
        emit("C is posted to the Demand at bidding and read cross-contract. The derived matrix covers adjudication txs only: revealKey + startAdjudication + N * processChunk + finalizeAdjudication.");

        // Per-chunk table
        emit(`\nTable R3a-I: OVC-Identity per-process-chunk gas vs chunk size`);
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
        emit(`\nTable R3b-I: Total adjudication gas - OVC-Identity (gigagas, x10^9)`);
        const matrixNote = "Total includes revealKey + startAdjudication + N * processChunk + finalizeAdjudication.";

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
                    matrixWriter.appendRow({ measurement_group: "R3b-I", instance: "OVC-Identity", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: "", total_gas: "", total_gigagas: "", status: "DEGENERATE", note: matrixNote });
                    continue;
                }
                const gas = perChunkGas[chunkKb];
                if (gas === null) {
                    row += `${"FAIL".padStart(12)} |`;
                    matrixWriter.appendRow({ measurement_group: "R3b-I", instance: "OVC-Identity", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: "", total_gas: "", total_gigagas: "", status: "FAIL", note: matrixNote });
                    continue;
                }
                const chunkCount   = Math.ceil(gcodeBytes / chunkBytes);
                const totalGas     = totalOverheadGas + chunkCount * gas;
                const totalGigagas = (totalGas / 1e9).toFixed(3);
                row += `${`${totalGigagas}(N=${chunkCount})`.padStart(12)} |`;
                matrixWriter.appendRow({ measurement_group: "R3b-I", instance: "OVC-Identity", chunk_size_kb: chunkKb, gcode_size_kb: gcodeKb, chunk_count: chunkCount, total_gas: totalGas, total_gigagas: totalGigagas, status: "OK", note: matrixNote });
            }
            emit(row);
        }

        emit(`\n${"=".repeat(88)}`);
        emit("Methodology: processChunk gas measured via eth_estimateGas after bidding (Demand.postDemand -> depositCiphertextChunk -> seal) then binding (commitClaim -> setDemand -> dispute -> revealKey -> startAdjudication). processChunk reads C cross-contract from the Demand. Finalize gas measured from a real tx on a 1 KB baseline claim.");
        emit("=".repeat(88));

        matrixWriter.close();
        writeSummaryArtifacts(__filename, "R3-I Summary", summaryLines);
    });
});
