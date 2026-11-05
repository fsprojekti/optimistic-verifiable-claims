/**
 * Stage 05 corpus-ladder measurement, derived unchanged from r1-chunk-selection.js
 * except for artifact selection and the stage-local corpus root.
 * Isolated local Anvil only. Enable explicitly with OVC_LADDER_ENABLED=1.
 *
 * Executes the complete four-claim path (posting, deferred ciphertext upload,
 * binding, and Identity, Access, Conformance and Feature disputes) for the
 * frozen corpus artifacts named in OVC_ARTIFACT_KEYS.
 *
 * Environment:
 *   OVC_ARTIFACT_KEYS       comma-separated model_id:slicer keys (required)
 *   OVC_PILOT_CHUNK_BYTES   ciphertext/adjudication chunk size
 *   OVC_PILOT_OUTPUT_SUBDIR result subdirectory under results/raw-data
 *   OVC_KERNEL_GAS_LIMIT    gas limit for chunk transactions (default 3e9; whole-file runs raise it)
 *   OVC_ACCEPT_PATH=1       undisputed path: the Provider accepts all four claims after binding
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { chacha20 } = require("../lib/chacha20");
const { createAccessKeyPair, encryptAccessKey, decryptAccessKey, accessLinkCommitment } = require("../lib/access-envelope");
const { netExtrusion } = require("../lib/gcode-reference");
const {
    PLAINTEXT_DOMAIN,
    CIPHERTEXT_DOMAIN,
    segmentedCommitment,
} = require("../lib/segmented-commitment");
const { writeCsvReport } = require("../../scripts/benchmarkCsv");

let CHUNK_BYTES = Number(process.env.OVC_PILOT_CHUNK_BYTES || 4096);
const WHOLE_FILE = process.env.OVC_R1_WHOLE_FILE === "1";
const KERNEL_GAS_LIMIT = Number(process.env.OVC_KERNEL_GAS_LIMIT || 3_000_000_000);
const ACCEPT_PATH = process.env.OVC_ACCEPT_PATH === "1";
const OUTPUT_SUBDIR = process.env.OVC_PILOT_OUTPUT_SUBDIR || "pilot-anvil";
const PREDICATE_MODE = "all";
const REIMBURSEMENT = BigInt(process.env.OVC_REIMBURSEMENT_WEI || "1");
const DISPUTE_WINDOW = 100_000;

const STAGE_ROOT = path.join(__dirname, "..", "..", "..");
const CORPUS_ROOT = process.env.OVC_CORPUS_ROOT || path.join(STAGE_ROOT, "data", "corpus", "generated");
const ARTIFACT_KEYS = (process.env.OVC_ARTIFACT_KEYS || "").split(",").filter(Boolean);
const MANIFEST_PATH = path.join(CORPUS_ROOT, "gcode-manifest.csv");

function parseCsvLine(line) {
    const values = [];
    let current = "";
    let quoted = false;
    for (let i = 0; i < line.length; ++i) {
        const ch = line[i];
        if (ch === '"') {
            if (quoted && line[i + 1] === '"') {
                current += '"';
                ++i;
            } else {
                quoted = !quoted;
            }
        } else if (ch === "," && !quoted) {
            values.push(current);
            current = "";
        } else {
            current += ch;
        }
    }
    values.push(current);
    return values;
}

function loadSelectedArtifacts() {
    const lines = fs.readFileSync(MANIFEST_PATH, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
    const headers = parseCsvLine(lines.shift());
    const rows = lines.map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i]])));
    return ARTIFACT_KEYS.map(key => {
        const matches = rows.filter(row => `${row.model_id}:${row.slicer}` === key);
        if (matches.length !== 1) throw new Error(`Artifact ${key} not found exactly once in the frozen manifest`);
        return matches[0];
    });
}

function benchmarkSecret(domain, outputSha256, length) {
    return crypto.createHash("sha256")
        .update(`OVC-ANVIL-PILOT-V1:${domain}:`)
        .update(outputSha256)
        .digest()
        .subarray(0, length);
}

function sumGas(rows, artifactKey, operations) {
    const wanted = new Set(operations);
    return rows
        .filter(row => row.artifact_key === artifactKey && wanted.has(row.operation))
        .reduce((total, row) => total + BigInt(row.gas_used), 0n);
}

function maxGas(rows, artifactKey, operation) {
    return rows
        .filter(row => row.artifact_key === artifactKey && row.operation === operation)
        .reduce((maximum, row) => Math.max(maximum, Number(row.gas_used)), 0);
}

async function recordTx(rows, artifact, operation, txPromise, chunkIndex = "") {
    const tx = await txPromise;
    const receipt = await tx.wait();
    rows.push({
        artifact_key: artifact ? `${artifact.model_id}:${artifact.slicer}` : "setup",
        model_id: artifact?.model_id || "",
        slicer: artifact?.slicer || "",
        output_sha256: artifact?.output_sha256 || "",
        size_bytes: artifact?.size_bytes || "",
        chunk_size_bytes: artifact ? CHUNK_BYTES : "",
        chunk_index: chunkIndex,
        operation,
        gas_used: receipt.gasUsed,
        tx_hash: receipt.hash,
        block_number: receipt.blockNumber,
        status: receipt.status,
    });
    const outputDir = path.join(STAGE_ROOT, "results", "raw-data", OUTPUT_SUBDIR);
    fs.mkdirSync(outputDir, { recursive: true });
    fs.appendFileSync(path.join(outputDir, "receipts.jsonl"), JSON.stringify(rows[rows.length - 1], (_, value) => typeof value === "bigint" ? value.toString() : value) + "\n");
    if (rows.length % 50 === 0 || /Finalize|finalize|sealCiphertext|bindProvider/.test(operation)) {
        console.log(`[progress] ${new Date().toISOString()} ${artifact?.slicer || "setup"} chunk=${CHUNK_BYTES} ${operation} index=${chunkIndex} receipts=${rows.length}`);
    }
    return receipt;
}

describe("Anvil corpus ladder - selected genuine corpus artifacts", function () {
    it("measures complete files across all production predicates", async function () {
        this.timeout(0);
        if (process.env.OVC_LADDER_ENABLED !== "1") this.skip();
        const endpoint = new URL(process.env.LOCALHOST_RPC_URL || "http://127.0.0.1:8545");
        expect(["127.0.0.1", "localhost"]).to.include(endpoint.hostname);
        expect(endpoint.port).to.equal("19545");
        expect(ARTIFACT_KEYS.length).to.be.greaterThan(0);
        expect(CHUNK_BYTES).to.be.greaterThan(0);

        const network = await ethers.provider.getNetwork();
        const clientVersion = await ethers.provider.send("web3_clientVersion", []);
        expect(clientVersion.toLowerCase()).to.include("anvil");
        expect(network.chainId).to.equal(31337n);

        const artifacts = loadSelectedArtifacts();
        expect(artifacts).to.have.length(ARTIFACT_KEYS.length);
        const [consumer, provider] = await ethers.getSigners();
        if (WHOLE_FILE) CHUNK_BYTES = Math.max(...artifacts.map(a => Number(a.size_bytes)));
        const outputDir = path.join(STAGE_ROOT, "results", "raw-data", OUTPUT_SUBDIR);
        fs.mkdirSync(outputDir, { recursive: true });
        if (fs.existsSync(path.join(outputDir, "receipts.jsonl"))) throw new Error("Refusing to overwrite existing R1 evidence");
        const metadata = { started_at: new Date().toISOString(), client_version: clientVersion,
            chain_id: String(network.chainId), hardfork: "cancun", block_gas_limit: String((await ethers.provider.getBlock("latest")).gasLimit),
            kernel_gas_limit: KERNEL_GAS_LIMIT, mode: WHOLE_FILE ? "whole-file-single-chunk" : "segmented",
            chunk_size_bytes: WHOLE_FILE ? null : CHUNK_BYTES, consumer: consumer.address, provider: provider.address,
            artifacts: artifacts.map(a => ({ artifact: `${a.model_id}:${a.slicer}`, bytes: Number(a.size_bytes), sha256: a.output_sha256 })) };
        fs.writeFileSync(path.join(outputDir, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");
        const rawRows = [];
        const summaryRows = [];
        const predicateRows = [];

        const demand = await (await ethers.getContractFactory("Demand")).deploy(CHUNK_BYTES);
        await demand.waitForDeployment();
        const access = await (await ethers.getContractFactory("OVCAccess")).deploy(DISPUTE_WINDOW);
        const identity = await (await ethers.getContractFactory("OVCIdentitySegmented"))
            .deploy(DISPUTE_WINDOW, await demand.getAddress());
        const conformance = await (await ethers.getContractFactory("OVCConformanceSegmented"))
            .deploy(DISPUTE_WINDOW);
        const feature = await (await ethers.getContractFactory("OVCFeatureSegmented"))
            .deploy(DISPUTE_WINDOW);
        await Promise.all([access, identity, conformance, feature].map(c => c.waitForDeployment()));
        const binding = await (await ethers.getContractFactory("BindingPhase")).deploy(
            await access.getAddress(),
            await identity.getAddress(),
            await conformance.getAddress(),
            await feature.getAddress(),
            await demand.getAddress()
        );
        await binding.waitForDeployment();

        const accessKeys = createAccessKeyPair();
        await recordTx(rawRows, null, "registerAccessPublicKey", binding.connect(provider).registerAccessPublicKey(accessKeys.publicKey));
        for (const contract of [access, identity, conformance, feature]) {
            await recordTx(rawRows, null, "setCoordinator", contract.setCoordinator(await binding.getAddress()));
        }

        console.log(`\nAnvil ${clientVersion}; chain ${network.chainId}; ${CHUNK_BYTES}-byte chunks`);

        for (const artifact of artifacts) {
            const artifactKey = `${artifact.model_id}:${artifact.slicer}`;
            const artifactPath = path.join(CORPUS_ROOT, artifact.output_file);
            const plaintext = fs.readFileSync(artifactPath);
            if (WHOLE_FILE) CHUNK_BYTES = plaintext.length;
            expect(plaintext.length).to.equal(Number(artifact.size_bytes));
            expect(crypto.createHash("sha256").update(plaintext).digest("hex"))
                .to.equal(artifact.output_sha256);

            // Deterministic benchmark fixtures only. Production must use random keys.
            const key = benchmarkSecret("KEY", artifact.output_sha256, 32);
            const nonce = benchmarkSecret("NONCE", artifact.output_sha256, 12);
            const ciphertext = chacha20(plaintext, key, nonce);
            const hG = segmentedCommitment(plaintext, CHUNK_BYTES, PLAINTEXT_DOMAIN);
            const hC = segmentedCommitment(ciphertext, CHUNK_BYTES, CIPHERTEXT_DOMAIN);
            const hK = ethers.keccak256(key);
            const fClaim = netExtrusion(plaintext.toString("utf8"));
            const startedAt = Date.now();

            await recordTx(rawRows, artifact, "postDemand",
                demand.connect(consumer).postDemand(
                    hG, hC, fClaim, nonce, ciphertext.length, CHUNK_BYTES
                ));
            const demandId = await demand.demandCount();

            await recordTx(rawRows, artifact, "prepareBinding",
                demand.connect(consumer).prepareBinding(demandId, provider.address));

            let chunkIndex = 0;
            for (let offset = 0; offset < ciphertext.length; offset += CHUNK_BYTES) {
                const chunk = ciphertext.subarray(offset, Math.min(offset + CHUNK_BYTES, ciphertext.length));
                await recordTx(
                    rawRows,
                    artifact,
                    "depositCiphertextChunk",
                    demand.connect(consumer).depositCiphertextChunk(
                        demandId, chunk, { gasLimit: KERNEL_GAS_LIMIT }
                    ),
                    chunkIndex
                );
                ++chunkIndex;
            }

            await recordTx(rawRows, artifact, "sealCiphertext",
                demand.connect(consumer).sealCiphertext(demandId));
            expect(await demand.computedCiphertextCommitment(demandId)).to.equal(hC);

            const accessSeed = crypto.randomBytes(32);
            const encryptedKeyFixture = encryptAccessKey(key, accessKeys.publicKey, provider.address, demandId, accessSeed);
            const accessLink = accessLinkCommitment(key, accessKeys.publicKey, encryptedKeyFixture);
            const recoveredKey = decryptAccessKey(encryptedKeyFixture, accessKeys.privateKey, provider.address, demandId, hK);
            expect(recoveredKey.equals(key)).to.equal(true);
            await recordTx(rawRows, artifact, "bindProvider", binding.connect(consumer).bindProvider(
                demandId,
                provider.address,
                hK,
                encryptedKeyFixture,
                accessLink,
                [REIMBURSEMENT, REIMBURSEMENT, REIMBURSEMENT],
                { gasLimit: 5_000_000 }
            ));
            const bindingId = await binding.bindingCount();
            const [accessClaimId, identityClaimId, conformanceClaimId, featureClaimId] =
                await binding.getClaimIds(bindingId);

            if (ACCEPT_PATH) {
                await recordTx(rawRows, artifact, "acceptBinding", binding.connect(provider).accept(bindingId));
                const verifiers = [[access, accessClaimId, "Access"], [identity, identityClaimId, "Identity"],
                    [conformance, conformanceClaimId, "Conformance"], [feature, featureClaimId, "Feature"]];
                for (const [verifier, claimId, label] of verifiers) {
                    expect((await verifier.claims(claimId)).outcome).to.equal(1n); // Accepted
                    predicateRows.push({
                        artifact_key: artifactKey, predicate: label, size_bytes: plaintext.length,
                        chunk_size_bytes: CHUNK_BYTES, chunk_count: 0, deposit_gas: 0, process_gas: 0,
                        adjudication_gas: 0, max_process_tx_gas: 0, outcome: "Accepted",
                    });
                }
                summaryRows.push({
                    artifact_key: artifactKey, model_id: artifact.model_id, slicer: artifact.slicer,
                    slicer_version: artifact.slicer_version, output_sha256: artifact.output_sha256,
                    size_bytes: plaintext.length, line_count: artifact.line_count, chunk_size_bytes: CHUNK_BYTES,
                    chunk_count: chunkIndex, upload_gas: sumGas(rawRows, artifactKey, ["depositCiphertextChunk"]),
                    identity_processing_gas: 0,
                    lifecycle_gas: sumGas(rawRows, artifactKey, ["postDemand", "prepareBinding",
                        "depositCiphertextChunk", "sealCiphertext", "bindProvider", "acceptBinding"]),
                    upload_gas_per_byte: "", processing_gas_per_byte: "", lifecycle_gas_per_byte: "",
                    local_elapsed_seconds_diagnostic_only: ((Date.now() - startedAt) / 1000).toFixed(3),
                    outcome: "Accepted", client_version: clientVersion, chain_id: network.chainId,
                });
                continue;
            }

            await recordTx(rawRows, artifact, "disputeClaim",
                identity.connect(provider).disputeClaim(
                    identityClaimId, { value: REIMBURSEMENT }
                ));
            await recordTx(rawRows, artifact, "revealKey",
                identity.connect(consumer).revealKey(identityClaimId, key));
            await recordTx(rawRows, artifact, "startAdjudication",
                identity.connect(consumer).startAdjudication(identityClaimId));

            for (let i = 0; i < chunkIndex; ++i) {
                await recordTx(
                    rawRows,
                    artifact,
                    "processChunk",
                    identity.processChunk(identityClaimId, { gasLimit: KERNEL_GAS_LIMIT }),
                    i
                );
            }
            await recordTx(rawRows, artifact, "finalizeAdjudication",
                identity.finalizeAdjudication(identityClaimId));

            const claim = await identity.claims(identityClaimId);
            expect(claim.outcome).to.equal(2n); // Valid

            const identityAdjudicationGas = sumGas(rawRows, artifactKey, [
                "disputeClaim", "revealKey", "startAdjudication", "processChunk",
                "finalizeAdjudication",
            ]);
            predicateRows.push({
                artifact_key: artifactKey,
                predicate: "Identity",
                size_bytes: plaintext.length,
                chunk_size_bytes: CHUNK_BYTES,
                chunk_count: chunkIndex,
                deposit_gas: 0,
                process_gas: sumGas(rawRows, artifactKey, ["processChunk"]),
                adjudication_gas: identityAdjudicationGas,
                max_process_tx_gas: maxGas(rawRows, artifactKey, "processChunk"),
                outcome: "Valid",
            });

            async function adjudicatePlaintextPredicate(label, contract, claimId) {
                const prefix = label.toLowerCase();
                await recordTx(rawRows, artifact, `${prefix}DisputeClaim`,
                    contract.connect(provider).disputeClaim(
                        claimId, { value: REIMBURSEMENT }
                    ));
                let index = 0;
                for (let offset = 0; offset < plaintext.length; offset += CHUNK_BYTES) {
                    const chunk = plaintext.subarray(offset, Math.min(offset + CHUNK_BYTES, plaintext.length));
                    await recordTx(
                        rawRows,
                        artifact,
                        `${prefix}DepositChunk`,
                        contract.connect(consumer).depositChunk(claimId, chunk, { gasLimit: KERNEL_GAS_LIMIT }),
                        index
                    );
                    ++index;
                }
                await recordTx(rawRows, artifact, `${prefix}StartAdjudication`,
                    contract.connect(consumer).startAdjudication(claimId));
                for (let i = 0; i < index; ++i) {
                    await recordTx(
                        rawRows,
                        artifact,
                        `${prefix}ProcessChunk`,
                        contract.processChunk(claimId, { gasLimit: KERNEL_GAS_LIMIT }),
                        i
                    );
                }
                await recordTx(rawRows, artifact, `${prefix}FinalizeAdjudication`,
                    contract.finalizeAdjudication(claimId));
                expect((await contract.claims(claimId)).outcome).to.equal(2n);

                const depositOperation = `${prefix}DepositChunk`;
                const processOperation = `${prefix}ProcessChunk`;
                const operations = [
                    `${prefix}DisputeClaim`, depositOperation, `${prefix}StartAdjudication`,
                    processOperation, `${prefix}FinalizeAdjudication`,
                ];
                predicateRows.push({
                    artifact_key: artifactKey,
                    predicate: label,
                    size_bytes: plaintext.length,
                    chunk_size_bytes: CHUNK_BYTES,
                    chunk_count: index,
                    deposit_gas: sumGas(rawRows, artifactKey, [depositOperation]),
                    process_gas: sumGas(rawRows, artifactKey, [processOperation]),
                    adjudication_gas: sumGas(rawRows, artifactKey, operations),
                    max_process_tx_gas: maxGas(rawRows, artifactKey, processOperation),
                    outcome: "Valid",
                });
            }

            if (PREDICATE_MODE === "all") {
                await recordTx(rawRows, artifact, "accessDisputeClaim", access.connect(provider).disputeClaim(accessClaimId));
                await recordTx(rawRows, artifact, "accessRevealWitness", access.connect(consumer).revealWitness(
                    accessClaimId, ethers.concat([key, accessSeed])
                ));
                expect((await access.claims(accessClaimId)).outcome).to.equal(2n);
                predicateRows.push({
                    artifact_key: artifactKey, predicate: "Access", size_bytes: plaintext.length,
                    chunk_size_bytes: CHUNK_BYTES, chunk_count: 0, deposit_gas: 0,
                    process_gas: sumGas(rawRows, artifactKey, ["accessRevealWitness"]),
                    adjudication_gas: sumGas(rawRows, artifactKey, ["accessDisputeClaim", "accessRevealWitness"]),
                    max_process_tx_gas: maxGas(rawRows, artifactKey, "accessRevealWitness"), outcome: "Valid",
                });
                await adjudicatePlaintextPredicate(
                    "Conformance", conformance.connect(consumer), conformanceClaimId
                );
                await adjudicatePlaintextPredicate(
                    "Feature", feature.connect(consumer), featureClaimId
                );
            }

            const uploadGas = sumGas(rawRows, artifactKey, ["depositCiphertextChunk"]);
            const processingGas = sumGas(rawRows, artifactKey, ["processChunk"]);
            const lifecycleGas = sumGas(rawRows, artifactKey, [
                "postDemand", "prepareBinding", "depositCiphertextChunk", "sealCiphertext", "bindProvider",
                "disputeClaim", "revealKey", "startAdjudication", "processChunk",
                "finalizeAdjudication",
            ]);
            const elapsedSeconds = (Date.now() - startedAt) / 1000;

            summaryRows.push({
                artifact_key: artifactKey,
                model_id: artifact.model_id,
                slicer: artifact.slicer,
                slicer_version: artifact.slicer_version,
                output_sha256: artifact.output_sha256,
                size_bytes: plaintext.length,
                line_count: artifact.line_count,
                chunk_size_bytes: CHUNK_BYTES,
                chunk_count: chunkIndex,
                upload_gas: uploadGas,
                identity_processing_gas: processingGas,
                lifecycle_gas: lifecycleGas,
                upload_gas_per_byte: (Number(uploadGas) / plaintext.length).toFixed(3),
                processing_gas_per_byte: (Number(processingGas) / plaintext.length).toFixed(3),
                lifecycle_gas_per_byte: (Number(lifecycleGas) / plaintext.length).toFixed(3),
                local_elapsed_seconds_diagnostic_only: elapsedSeconds.toFixed(3),
                outcome: "Valid",
                client_version: clientVersion,
                chain_id: network.chainId,
            });

            console.log(
                `${artifactKey.padEnd(28)} ${plaintext.length.toLocaleString().padStart(9)} B | ` +
                `${String(chunkIndex).padStart(3)} chunks | upload ${uploadGas.toLocaleString()} | ` +
                `identity ${processingGas.toLocaleString()} | total ${lifecycleGas.toLocaleString()} gas`
            );
        }

        metadata.completed_at = new Date().toISOString();
        metadata.successful_receipts = rawRows.length;
        fs.writeFileSync(path.join(outputDir, "run-metadata.json"), JSON.stringify(metadata, null, 2) + "\n");

        const rawHeaders = [
            "artifact_key", "model_id", "slicer", "output_sha256", "size_bytes",
            "chunk_size_bytes", "chunk_index", "operation", "gas_used", "tx_hash",
            "block_number", "status",
        ];
        const summaryHeaders = [
            "artifact_key", "model_id", "slicer", "slicer_version", "output_sha256",
            "size_bytes", "line_count", "chunk_size_bytes", "chunk_count", "upload_gas",
            "identity_processing_gas", "lifecycle_gas", "upload_gas_per_byte",
            "processing_gas_per_byte", "lifecycle_gas_per_byte",
            "local_elapsed_seconds_diagnostic_only", "outcome", "client_version", "chain_id",
        ];
        writeCsvReport(__filename, "transactions", rawHeaders, rawRows, { subdir: OUTPUT_SUBDIR });
        writeCsvReport(__filename, "summary", summaryHeaders, summaryRows, { subdir: OUTPUT_SUBDIR });
        writeCsvReport(
            __filename,
            "predicates",
            [
                "artifact_key", "predicate", "size_bytes", "chunk_size_bytes", "chunk_count",
                "deposit_gas", "process_gas", "adjudication_gas", "max_process_tx_gas", "outcome",
            ],
            predicateRows,
            { subdir: OUTPUT_SUBDIR }
        );
    });
});
