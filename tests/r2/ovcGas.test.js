const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { createCsvReportWriter } = require("../../scripts/benchmarkCsv");

/**
 * R2 — Optimistic path: Accepted outcome across all four OVC instances.
 *
 * Measures the minimum per-run cost beyond binding: Consumer commits,
 * Provider accepts, no dispute raised. All values are O(1) and independent
 * of G-code size.
 *
 * Run: npx hardhat test tests/r2/ovcGas.test.js
 */
const SUMMARY_DIR = path.join(__dirname, "..", "..", "experiments", "reports", "r2");

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

describe("OVC gas usage — R2: Optimistic path (Accepted outcome)", function () {
    it("records commitClaim + acceptClaim gas for all four OVC instances", async function () {
        this.timeout(0);
        const [claimant, provider] = await ethers.getSigners();
        const rawWriter = createCsvReportWriter(
            __filename,
            "raw",
            ["measurement_group", "instance", "operation", "gas_used", "artifact_size_bytes", "method", "status", "note"],
            { subdir: "r2" }
        );

        const access      = await (await ethers.getContractFactory("OVCAccess")).deploy(100);
        const identity    = await (await ethers.getContractFactory("OVCIdentity")).deploy(100);
        const conformance = await (await ethers.getContractFactory("OVCConformance")).deploy(100);
        const feature     = await (await ethers.getContractFactory("OVCFeature")).deploy(100);
        await Promise.all([access, identity, conformance, feature].map(c => c.waitForDeployment()));

        // G-code payload
        const gcodeLines = [
            "G21 ; Set units to mm",
            "G90 ; Absolute positioning",
            "M82 ; Absolute extrusion mode",
            "G92 E0 ; Reset extruder",
            "G1 X0 Y0 Z0.2 F3000 ; Move to start position",
            "G1 X20 Y0 E1.5 F1500 ; Print first segment",
            "G1 X20 Y20 E3.0 ; Print second segment",
            "G1 X0 Y20 E4.5 ; Print third segment",
            "G1 X0 Y0 E6.0 ; Print final segment",
        ];
        const gcodeBytes  = ethers.toUtf8Bytes(gcodeLines.join("\n"));
        const gcodeCommit = ethers.keccak256(gcodeBytes);

        // OVC-Access material
        const key             = ethers.toUtf8Bytes("secret-key");
        const keyCommit       = ethers.keccak256(key);
        const providerKeyHash = ethers.keccak256(ethers.toUtf8Bytes("provider-pubkey"));
        const wrapperHash     = ethers.keccak256(
            ethers.solidityPacked(["bytes", "bytes32"], [key, providerKeyHash])
        );

        // OVC-Identity material: commitment = H(K‖G‖C), C = G XOR K
        const secretK    = ethers.randomBytes(32);
        const ciphertext = new Uint8Array(gcodeBytes.length);
        for (let i = 0; i < gcodeBytes.length; i++)
            ciphertext[i] = gcodeBytes[i] ^ secretK[i % 32];
        const identityCommit = ethers.keccak256(ethers.concat([secretK, gcodeBytes, ciphertext]));

        // OVC-Feature: last E value in G-code × 1000
        const EXTRUSION_VALID = 6000n;

        const getClaimId = (receipt, contract) => {
            const parsed = receipt.logs
                .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "ClaimCommitted");
            return parsed.args.claimId;
        };

        const results = [];

        // OVC-Access
        {
            const commitRec = await (await access.connect(claimant).commitClaim(
                provider.address, keyCommit, wrapperHash, 0, providerKeyHash
            )).wait();
            const claimId   = getClaimId(commitRec, access);
            const acceptRec = await (await access.connect(provider).acceptClaim(claimId)).wait();
            results.push({ instance: "OVC-Access", accept: acceptRec.gasUsed });
            rawWriter.appendRow({
                measurement_group: "R2",
                instance: "OVC-Access",
                operation: "acceptClaim",
                gas_used: acceptRec.gasUsed,
                artifact_size_bytes: gcodeBytes.length,
                method: "transaction",
                status: "OK",
                note: "optimistic path — Provider acceptance cost only; commitClaim cost is in R1",
            });
            console.log(`[R2] OVC-Access acceptClaim = ${acceptRec.gasUsed.toLocaleString()} gas`);
        }

        // OVC-Identity
        {
            const commitRec = await (await identity.connect(claimant).commitIdentityClaim(
                provider.address, identityCommit, ciphertext
            )).wait();
            const claimId   = getClaimId(commitRec, identity);
            const acceptRec = await (await identity.connect(provider).acceptClaim(claimId)).wait();
            results.push({ instance: "OVC-Identity", accept: acceptRec.gasUsed });
            rawWriter.appendRow({
                measurement_group: "R2",
                instance: "OVC-Identity",
                operation: "acceptClaim",
                gas_used: acceptRec.gasUsed,
                artifact_size_bytes: gcodeBytes.length,
                method: "transaction",
                status: "OK",
                note: "optimistic path — Provider acceptance cost only; commitClaim + depositChunk cost is in R1",
            });
            console.log(`[R2] OVC-Identity acceptClaim = ${acceptRec.gasUsed.toLocaleString()} gas`);
        }

        // OVC-Conformance
        {
            const commitRec = await (await conformance.connect(claimant).commitClaim(
                provider.address, gcodeCommit, ethers.ZeroHash, 0, ethers.ZeroHash
            )).wait();
            const claimId   = getClaimId(commitRec, conformance);
            const acceptRec = await (await conformance.connect(provider).acceptClaim(claimId)).wait();
            results.push({ instance: "OVC-Conformance", accept: acceptRec.gasUsed });
            rawWriter.appendRow({
                measurement_group: "R2",
                instance: "OVC-Conformance",
                operation: "acceptClaim",
                gas_used: acceptRec.gasUsed,
                artifact_size_bytes: gcodeBytes.length,
                method: "transaction",
                status: "OK",
                note: "optimistic path — Provider acceptance cost only; commitClaim cost is in R1",
            });
            console.log(`[R2] OVC-Conformance acceptClaim = ${acceptRec.gasUsed.toLocaleString()} gas`);
        }

        // OVC-Feature
        {
            const commitRec = await (await feature.connect(claimant).commitClaim(
                provider.address, gcodeCommit, ethers.ZeroHash, EXTRUSION_VALID, ethers.ZeroHash
            )).wait();
            const claimId   = getClaimId(commitRec, feature);
            const acceptRec = await (await feature.connect(provider).acceptClaim(claimId)).wait();
            results.push({ instance: "OVC-Feature", accept: acceptRec.gasUsed });
            rawWriter.appendRow({
                measurement_group: "R2",
                instance: "OVC-Feature",
                operation: "acceptClaim",
                gas_used: acceptRec.gasUsed,
                artifact_size_bytes: gcodeBytes.length,
                method: "transaction",
                status: "OK",
                note: "optimistic path — Provider acceptance cost only; commitClaim cost is in R1",
            });
            console.log(`[R2] OVC-Feature acceptClaim = ${acceptRec.gasUsed.toLocaleString()} gas`);
        }

        rawWriter.close();

        const summaryLines = [];
        const emitSummary = (line = "") => {
            console.log(line);
            summaryLines.push(line);
        };

        emitSummary("\n" + "=".repeat(56));
        emitSummary("R2 — Optimistic path: Provider acceptClaim gas");
        emitSummary("=".repeat(56));
        emitSummary("| Instance         | acceptClaim  |");
        emitSummary("|------------------|--------------|");
        for (const r of results) {
            emitSummary(
                `| ${r.instance.padEnd(16)} | ` +
                `${r.accept.toString().padStart(12)} |`
            );
        }
        emitSummary("=".repeat(56));
        emitSummary("All values are O(1) — independent of G-code size.");
        emitSummary("Consumer commitClaim cost is covered in R1.");
        emitSummary("=".repeat(56));

        writeSummaryArtifacts(__filename, "R2 Summary", summaryLines);
    });
});
