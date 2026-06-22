const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OVC-Conformance: Stage-Level Structural Benchmarking", function () {
    let ovcConformance;
    let claimant, provider;

    const validGcode = ethers.toUtf8Bytes("G21\nG90\nM82\nG92 E0\nG1 X0 Y0 Z0.2");
    const validHash = ethers.keccak256(validGcode);

    const invalidGcode = ethers.toUtf8Bytes("INVALID DATA: NOT GCODE");
    const invalidHash = ethers.keccak256(invalidGcode);

    beforeEach(async function () {
        [claimant, provider] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("OVCConformance");
        ovcConformance = await Factory.deploy(100);
        await ovcConformance.waitForDeployment();
    });

    async function runScenario(title, commitment, revealData, isOptimistic = false) {
        // --- STAGE 1: NEGOTIATION (Commitment) ---
        const cTx = await ovcConformance.connect(claimant).commitClaim(
            provider.address, commitment, ethers.ZeroHash, 0, ethers.ZeroHash
        );
        const cRec = await cTx.wait();

        let stage2Gas = 0n;
        let stage3Gas = 0n;

        if (isOptimistic) {
            // --- STAGE 2: FINALIZATION (Acceptance) ---
            const aTx = await ovcConformance.connect(provider).acceptClaim(1);
            const aRec = await aTx.wait();
            stage2Gas = aRec.gasUsed;
        } else {
            // --- STAGE 2: CHALLENGE (Dispute Trigger) ---
            const dTx = await ovcConformance.connect(provider).disputeClaim(1);
            const dRec = await dTx.wait();
            stage2Gas = dRec.gasUsed;

            // --- STAGE 3: ADJUDICATION (Reveal & Parse) ---
            const rTx = await ovcConformance.connect(claimant).revealWitness(1, revealData);
            const rRec = await rTx.wait();
            stage3Gas = rRec.gasUsed;
        }

        const claim = await ovcConformance.claims(1);

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

    it("Outcome 1: OPTIMISTIC ACCEPTANCE", async function () {
        await runScenario("OPTIMISTIC PATH (STRUCTURAL TRUST)", validHash, null, true);
    });

    it("Outcome 2: HONEST ADJUDICATION", async function () {
        await runScenario("LITIGATED TRUTH (SYNTACTIC PASS)", validHash, validGcode);
    });

    it("Outcome 3: BAIT-AND-SWITCH", async function () {
        const fakeData = ethers.toUtf8Bytes("Mismatched Content");
        await runScenario("LITIGATED FRAUD (HASH MISMATCH)", validHash, fakeData);
    });

    it("Outcome 4: STRUCTURAL FAILURE", async function () {
        await runScenario("LITIGATED FRAUD (INVALID G-CODE)", invalidHash, invalidGcode);
    });
});