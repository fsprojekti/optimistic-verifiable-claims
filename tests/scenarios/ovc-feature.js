const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OVC-Feature: Stage-Level Forensic Benchmarking", function () {
    let ovcFeature;
    let claimant, provider;

    // --- ARTIFACT DATA: 6.0mm Extrusion ---
    const validGcode = ethers.toUtf8Bytes(
        "G21\nG90\nM82\nG92 E0\nG1 X20 Y0 E1.5\nG1 X20 Y20 E3.0\nG1 X0 Y20 E4.5\nG1 X0 Y0 E6.0"
    );
    const validHash = ethers.keccak256(validGcode);
    // Absolute mode: G92 E0 datums the axis, then four deltas of 1.5mm → 6.0mm net.
    const bidESum = 600000; // 6.0mm scaled by 1e5

    // --- FRAUDULENT DATA: 5.0mm Extrusion ---
    const fraudGcode = ethers.toUtf8Bytes(
        "G21\nG90\nM82\nG92 E0\nG1 X20 Y0 E1.5\nG1 X20 Y20 E3.0\nG1 X0 Y20 E4.5\nG1 X0 Y0 E5.0"
    );
    const fraudHash = ethers.keccak256(fraudGcode);

    beforeEach(async function () {
        [claimant, provider] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("OVCFeature");
        ovcFeature = await Factory.deploy(100);
        await ovcFeature.waitForDeployment();
    });

    async function runScenario(title, hash, bidValue, revealData, isOptimistic = false) {
        // --- STAGE 1: NEGOTIATION (Commitment) ---
        const cTx = await ovcFeature.connect(claimant).commitClaim(
            provider.address, hash, ethers.ZeroHash, bidValue, ethers.ZeroHash
        );
        const cRec = await cTx.wait();

        let stage2Gas = 0n;
        let stage3Gas = 0n;

        if (isOptimistic) {
            // --- STAGE 2: FINALIZATION ---
            const aTx = await ovcFeature.connect(provider).acceptClaim(1);
            const aRec = await aTx.wait();
            stage2Gas = aRec.gasUsed;
        } else {
            // --- STAGE 2: CHALLENGE (Audit Request) ---
            const dTx = await ovcFeature.connect(provider).disputeClaim(1);
            const dRec = await dTx.wait();
            stage2Gas = dRec.gasUsed;

            // --- STAGE 3: ADJUDICATION (Forensic Reveal) ---
            const rTx = await ovcFeature.connect(claimant).revealWitness(1, revealData);
            const rRec = await rTx.wait();
            stage3Gas = rRec.gasUsed;
        }

        const claim = await ovcFeature.claims(1);

        console.log(`\n[REPORT: ${title}]`);
        console.log(`  - STAGE 1: NEGOTIATION   | ${cRec.gasUsed.toString().padEnd(8)} units`);
        console.log(`  - STAGE 2: CHALLENGE     | ${stage2Gas.toString().padEnd(8)} units`);
        console.log(`  - STAGE 3: ADJUDICATION  | ${stage3Gas.toString().padEnd(8)} units`);
        console.log(`  ---------------------------------------------------`);
        console.log(`  - TOTAL PROTOCOL COST    : ${(cRec.gasUsed + stage2Gas + stage3Gas).toString()} units`);
        console.log(`  - TERMINAL OUTCOME       : ${isOptimistic ? "1 (Accepted)" : claim.outcome.toString()}`);
        console.log("=".repeat(55));

        return claim;
    }

    it("Outcome 1: OPTIMISTIC PATH", async function () {
        await runScenario("OPTIMISTIC PATH (PHYSICAL TRUST)", validHash, bidESum, null, true);
    });

    it("Outcome 2: HONEST ADJUDICATION", async function () {
        await runScenario("LITIGATED TRUTH (MATERIAL MATCH)", validHash, bidESum, validGcode);
    });

    it("Outcome 3: BAIT-AND-SWITCH", async function () {
        await runScenario("LITIGATED FRAUD (HASH MISMATCH)", validHash, bidESum, fraudGcode);
    });

    it("Outcome 4: FEATURE MISMATCH", async function () {
        await runScenario("LITIGATED FRAUD (UNDER-EXTRUSION)", fraudHash, bidESum, fraudGcode);
    });
});