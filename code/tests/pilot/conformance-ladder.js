/**
 * Stage 08 conformance ladder: the machine-profile OVC-Conformance dispute on genuine corpus
 * files, isolated from the other three instances.
 *
 * Only OVCConformanceSegmented changed between Stage 07 and Stage 08 (T0: every other contract
 * has identical executable bytecode), so posting, publication, binding and the Identity, Access
 * and Feature disputes keep their Stage 05 receipts. This driver measures what changed: the
 * one-time machine registration, the Consumer's declaration at posting, and the five
 * operations of a Conformance dispute (disputeClaim, depositChunk, startAdjudication,
 * processChunk, finalizeAdjudication), recorded under the operation names of the Stage 05
 * campaigns so the result builder can substitute them per (artifact, chunk size).
 *
 * The claim is committed directly by the Consumer instead of through BindingPhase. The
 * commitment and the witness terms are the ones bindProvider writes; bindProvider itself is
 * unchanged and keeps its measured gas. Sweeps are mined OVC_BATCH per block, as in
 * corpus-ladder-batched.js (per-transaction gas is unaffected). Isolated local Anvil only.
 *
 * Environment: OVC_ARTIFACT_KEYS, OVC_PILOT_CHUNK_BYTES, OVC_PILOT_OUTPUT_SUBDIR,
 * OVC_R1_WHOLE_FILE, OVC_KERNEL_GAS_LIMIT, OVC_BATCH, OVC_PORT, OVC_CORPUS_ROOT.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { PLAINTEXT_DOMAIN, segmentedCommitment } = require("../lib/segmented-commitment");
const { ref, registerMachine, declare } = require("../lib/conformance-claim");
const { writeCsvReport } = require("../../scripts/benchmarkCsv");

let CHUNK_BYTES = Number(process.env.OVC_PILOT_CHUNK_BYTES || 4160);
const WHOLE_FILE = process.env.OVC_R1_WHOLE_FILE === "1";
const KERNEL_GAS_LIMIT = Number(process.env.OVC_KERNEL_GAS_LIMIT || 3_000_000_000);
const BATCH = Number(process.env.OVC_BATCH || 100);
const PORT = process.env.OVC_PORT || "19545";
const OUTPUT_SUBDIR = process.env.OVC_PILOT_OUTPUT_SUBDIR || "conformance-pilot";
const REIMBURSEMENT = BigInt(process.env.OVC_REIMBURSEMENT_WEI || "1");
const DISPUTE_WINDOW = 100_000;
// The corpus profile and material window (T8): Prusa XL, generic PLA.
const PROFILE = ref.machineProfile(ref.PRUSA_XL);
const PLA = { nozzle: [190, 230], bed: [50, 70] };

const STAGE_ROOT = path.join(__dirname, "..", "..", "..");
const CORPUS_ROOT = process.env.OVC_CORPUS_ROOT || path.join(STAGE_ROOT, "data", "corpus", "generated");
const ARTIFACT_KEYS = (process.env.OVC_ARTIFACT_KEYS || "").split(",").filter(Boolean);

function loadSelectedArtifacts() {
    const lines = fs.readFileSync(path.join(CORPUS_ROOT, "gcode-manifest.csv"), "utf8")
        .replace(/^﻿/, "").trim().split(/\r?\n/);
    const split = (line) => {                       // RFC 4180 fields, as in corpus-ladder-batched.js
        const out = []; let cur = "", quoted = false;
        for (let i = 0; i < line.length; ++i) {
            const ch = line[i];
            if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; ++i; } else quoted = !quoted; }
            else if (ch === "," && !quoted) { out.push(cur); cur = ""; }
            else cur += ch;
        }
        out.push(cur);
        return out;
    };
    const headers = split(lines.shift());
    const rows = lines.map((line) => Object.fromEntries(headers.map((h, i) => [h, split(line)[i]])));
    return ARTIFACT_KEYS.map((key) => {
        const matches = rows.filter((row) => `${row.model_id}:${row.slicer}` === key);
        if (matches.length !== 1) throw new Error(`Artifact ${key} not found exactly once in the frozen manifest`);
        return matches[0];
    });
}

const sumGas = (rows, key, ops) => rows.filter((r) => r.artifact_key === key && ops.includes(r.operation))
    .reduce((t, r) => t + BigInt(r.gas_used), 0n);
const maxGas = (rows, key, op) => rows.filter((r) => r.artifact_key === key && r.operation === op)
    .reduce((m, r) => Math.max(m, Number(r.gas_used)), 0);

function pushRow(rows, artifact, operation, receipt, chunkIndex) {
    rows.push({
        artifact_key: artifact ? `${artifact.model_id}:${artifact.slicer}` : "setup",
        model_id: artifact?.model_id || "", slicer: artifact?.slicer || "",
        output_sha256: artifact?.output_sha256 || "", size_bytes: artifact?.size_bytes || "",
        chunk_size_bytes: artifact ? CHUNK_BYTES : "", chunk_index: chunkIndex, operation,
        gas_used: receipt.gasUsed, tx_hash: receipt.hash, block_number: receipt.blockNumber, status: receipt.status,
    });
    const outputDir = path.join(STAGE_ROOT, "results", "raw-data", OUTPUT_SUBDIR);
    fs.appendFileSync(path.join(outputDir, "receipts.jsonl"),
        JSON.stringify(rows[rows.length - 1], (_, v) => typeof v === "bigint" ? v.toString() : v) + "\n");
    return receipt;
}

async function recordTx(rows, artifact, operation, txPromise, chunkIndex = "") {
    const receipt = await (await txPromise).wait();
    return pushRow(rows, artifact, operation, receipt, chunkIndex);
}

async function sweep(rows, artifact, operation, count, makeTx) {
    await ethers.provider.send("evm_setAutomine", [false]);
    try {
        for (let start = 0; start < count; start += BATCH) {
            const pending = [];
            for (let i = start; i < Math.min(count, start + BATCH); ++i) pending.push([i, await makeTx(i)]);
            await ethers.provider.send("evm_mine", []);
            for (const [i, tx] of pending) {
                let receipt = await ethers.provider.getTransactionReceipt(tx.hash);
                for (let extra = 0; !receipt && extra < 20; ++extra) {
                    await ethers.provider.send("evm_mine", []);
                    receipt = await ethers.provider.getTransactionReceipt(tx.hash);
                }
                if (!receipt || receipt.status !== 1) throw new Error(`${operation} ${i} not mined successfully`);
                pushRow(rows, artifact, operation, receipt, i);
            }
            console.log(`[progress] ${new Date().toISOString()} ${artifact.model_id}:${artifact.slicer} ${operation} ${Math.min(count, start + BATCH)}/${count}`);
        }
    } finally {
        await ethers.provider.send("evm_setAutomine", [true]);
    }
}

describe("Anvil conformance ladder (Stage 08 machine-profile predicate)", function () {
    it("measures the Conformance dispute on complete genuine files", async function () {
        this.timeout(0);
        if (process.env.OVC_LADDER_ENABLED !== "1") this.skip();
        const endpoint = new URL(process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545");
        expect(["127.0.0.1", "localhost"]).to.include(endpoint.hostname);
        expect(endpoint.port).to.equal(PORT);
        const clientVersion = await ethers.provider.send("web3_clientVersion", []);
        expect(clientVersion.toLowerCase()).to.include("anvil");
        const network = await ethers.provider.getNetwork();
        expect(network.chainId).to.equal(31337n);

        const artifacts = loadSelectedArtifacts();
        expect(artifacts.length).to.be.greaterThan(0);
        const [consumer, provider] = await ethers.getSigners();
        const outputDir = path.join(STAGE_ROOT, "results", "raw-data", OUTPUT_SUBDIR);
        fs.mkdirSync(outputDir, { recursive: true });
        if (fs.existsSync(path.join(outputDir, "receipts.jsonl"))) throw new Error("Refusing to overwrite existing evidence");
        const metadata = {
            started_at: new Date().toISOString(), client_version: clientVersion, chain_id: String(network.chainId),
            hardfork: "cancun", block_gas_limit: String((await ethers.provider.getBlock("latest")).gasLimit),
            kernel_gas_limit: KERNEL_GAS_LIMIT, mode: WHOLE_FILE ? "whole-file-single-chunk" : "segmented",
            chunk_size_bytes: WHOLE_FILE ? null : CHUNK_BYTES, consumer: consumer.address, provider: provider.address,
            machine_profile: ref.PRUSA_XL, material_window: PLA,
            artifacts: artifacts.map((a) => ({ artifact: `${a.model_id}:${a.slicer}`, bytes: Number(a.size_bytes), sha256: a.output_sha256 })),
        };
        fs.writeFileSync(path.join(outputDir, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
        const rawRows = [], predicateRows = [];

        const conformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(DISPUTE_WINDOW);
        await conformance.waitForDeployment();
        const { id: machineId, tx: registerTx } = await registerMachine(conformance, PROFILE, consumer);
        pushRow(rawRows, null, "registerMachine", await registerTx.wait(), "");

        for (const artifact of artifacts) {
            const key = `${artifact.model_id}:${artifact.slicer}`;
            const g = fs.readFileSync(path.join(CORPUS_ROOT, artifact.output_file));
            expect(g.length).to.equal(Number(artifact.size_bytes));
            expect(crypto.createHash("sha256").update(g).digest("hex")).to.equal(artifact.output_sha256);
            if (WHOLE_FILE) CHUNK_BYTES = g.length;

            // The honest declaration: the file's highest extruding Z (reference model, T8).
            const height = ref.conformance(g, PROFILE, ref.declaration({ height: 1e6, ...PLA })).state.maxExtrudeZ / ref.SCALE;
            const decl = ref.declaration({ height, ...PLA });
            expect(ref.conformance(g, PROFILE, decl).valid).to.equal(true);
            const hG = segmentedCommitment(g, CHUNK_BYTES, PLAINTEXT_DOMAIN);
            const chunks = Math.ceil(g.length / CHUNK_BYTES);

            await recordTx(rawRows, artifact, "declareConformance", declare(conformance, consumer, hG, machineId, decl));
            // Claim set-up as bindProvider performs it (bindProvider's gas is unchanged; diagnostic rows).
            await recordTx(rawRows, artifact, "conformanceCommitClaim",
                conformance.connect(consumer).commitClaim(provider.address, hG, ethers.ZeroHash, 0, ethers.ZeroHash));
            const claimId = await conformance.claimCount();
            await recordTx(rawRows, artifact, "conformanceConfigureWitnessTerms",
                conformance.connect(consumer).configureWitnessTerms(claimId, g.length, REIMBURSEMENT));
            await recordTx(rawRows, artifact, "conformanceConfigureDepositFormat",
                conformance.connect(consumer).configureDepositFormat(claimId, PLAINTEXT_DOMAIN, g.length, CHUNK_BYTES));

            await recordTx(rawRows, artifact, "conformanceDisputeClaim",
                conformance.connect(provider).disputeClaim(claimId, { value: REIMBURSEMENT }));
            await sweep(rawRows, artifact, "conformanceDepositChunk", chunks, (i) =>
                conformance.connect(consumer).depositChunk(claimId,
                    g.subarray(i * CHUNK_BYTES, Math.min((i + 1) * CHUNK_BYTES, g.length)), { gasLimit: KERNEL_GAS_LIMIT }));
            await recordTx(rawRows, artifact, "conformanceStartAdjudication",
                conformance.connect(consumer).startAdjudication(claimId));
            await sweep(rawRows, artifact, "conformanceProcessChunk", chunks, () =>
                conformance.processChunk(claimId, { gasLimit: KERNEL_GAS_LIMIT }));
            await recordTx(rawRows, artifact, "conformanceFinalizeAdjudication", conformance.finalizeAdjudication(claimId));
            expect((await conformance.claims(claimId)).outcome).to.equal(2n); // Valid

            const ops = ["conformanceDisputeClaim", "conformanceDepositChunk", "conformanceStartAdjudication",
                "conformanceProcessChunk", "conformanceFinalizeAdjudication"];
            predicateRows.push({
                artifact_key: key, predicate: "Conformance", size_bytes: g.length, chunk_size_bytes: CHUNK_BYTES,
                chunk_count: chunks, declared_height_mm: height,
                declare_gas: sumGas(rawRows, key, ["declareConformance"]),
                deposit_gas: sumGas(rawRows, key, ["conformanceDepositChunk"]),
                process_gas: sumGas(rawRows, key, ["conformanceProcessChunk"]),
                adjudication_gas: sumGas(rawRows, key, ops),
                max_process_tx_gas: maxGas(rawRows, key, "conformanceProcessChunk"), outcome: "Valid",
            });
            console.log(`${key.padEnd(30)} ${g.length.toLocaleString().padStart(11)} B | ${String(chunks).padStart(5)} chunks | ` +
                `process ${sumGas(rawRows, key, ["conformanceProcessChunk"]).toLocaleString()} gas | Valid`);
        }

        metadata.completed_at = new Date().toISOString();
        metadata.successful_receipts = rawRows.length;
        fs.writeFileSync(path.join(outputDir, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
        writeCsvReport(__filename, "transactions", ["artifact_key", "model_id", "slicer", "output_sha256", "size_bytes",
            "chunk_size_bytes", "chunk_index", "operation", "gas_used", "tx_hash", "block_number", "status"],
            rawRows, { subdir: OUTPUT_SUBDIR });
        writeCsvReport(__filename, "predicates", ["artifact_key", "predicate", "size_bytes", "chunk_size_bytes",
            "chunk_count", "declared_height_mm", "declare_gas", "deposit_gas", "process_gas", "adjudication_gas",
            "max_process_tx_gas", "outcome"], predicateRows, { subdir: OUTPUT_SUBDIR });
    });
});
