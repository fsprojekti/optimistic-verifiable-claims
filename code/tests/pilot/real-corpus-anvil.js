/**
 * Small real-corpus Anvil pilot for the segmented Demand -> OVC-Identity flow.
 *
 * Selects the N smallest genuine G-code files from the frozen corpus, encrypts
 * each complete artifact with RFC 8439 ChaCha20, uploads every ciphertext chunk,
 * binds a provider, and executes a complete Identity dispute/adjudication.
 *
 * Run:
 *   npx hardhat test tests/pilot/real-corpus-anvil.js --network localhost
 *
 * Environment:
 *   OVC_PILOT_FILES       number of smallest files (default 3)
 *   OVC_PILOT_CHUNK_BYTES ciphertext/adjudication chunk size (default 4096)
 *   OVC_PILOT_OUTPUT_SUBDIR result subdirectory (default pilot-anvil)
 *   OVC_PILOT_PREDICATES  identity or all (default identity)
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

const FILE_COUNT = Number(process.env.OVC_PILOT_FILES || 3);
const CHUNK_BYTES = Number(process.env.OVC_PILOT_CHUNK_BYTES || 4096);
const OUTPUT_SUBDIR = process.env.OVC_PILOT_OUTPUT_SUBDIR || "pilot-anvil";
const PREDICATE_MODE = process.env.OVC_PILOT_PREDICATES || "identity";
const REIMBURSEMENT = BigInt(process.env.OVC_REIMBURSEMENT_WEI || "1");
const DISPUTE_WINDOW = 100_000;

const STAGE_ROOT = path.join(__dirname, "..", "..", "..");
const CORPUS_ROOT = process.env.OVC_CORPUS_ROOT || path.join(
    STAGE_ROOT, "..", "stage-02-secure-real-corpus-validation", "data", "corpus", "generated"
);
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

function loadSmallestArtifacts() {
    const lines = fs.readFileSync(MANIFEST_PATH, "utf8").trim().split(/\r?\n/);
    const headers = parseCsvLine(lines.shift());
    return lines
        .map(line => Object.fromEntries(headers.map((h, i) => [h, parseCsvLine(line)[i]])))
        .sort((a, b) => Number(a.size_bytes) - Number(b.size_bytes))
        .slice(0, FILE_COUNT);
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
    return receipt;
}

describe("Anvil pilot â€” smallest genuine corpus artifacts", function () {
    it("runs complete Demand and OVC-Identity dispute flows", async function () {
        this.timeout(0);
        expect(FILE_COUNT).to.be.greaterThan(0);
        expect(CHUNK_BYTES).to.be.greaterThan(0);

        const network = await ethers.provider.getNetwork();
        const clientVersion = await ethers.provider.send("web3_clientVersion", []);
        if (!clientVersion.toLowerCase().includes("anvil")) this.skip();

        const artifacts = loadSmallestArtifacts();
        expect(artifacts).to.have.length(FILE_COUNT);
        const [consumer, provider] = await ethers.getSigners();
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
                        demandId, chunk, { gasLimit: 10_000_000 }
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
                    identity.processChunk(identityClaimId, { gasLimit: 30_000_000 }),
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
                        contract.connect(consumer).depositChunk(claimId, chunk, { gasLimit: 10_000_000 }),
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
                        contract.processChunk(claimId, { gasLimit: 30_000_000 }),
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
