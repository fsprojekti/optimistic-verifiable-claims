const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OVC-Access: Stage-Level Economic Analysis", function () {
    let ovcAccess;
    let claimant, provider;

    const secretKey = ethers.encodeBytes32String("3d-print-aes-key-2024");
    const providerKeyHash = ethers.keccak256(ethers.toUtf8Bytes("provider-id-001"));
    const validAuxHash = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32"],
        [secretKey, providerKeyHash]
    );

    beforeEach(async function () {
        [claimant, provider] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("OVCAccess");
        ovcAccess = await Factory.deploy(100);
        await ovcAccess.waitForDeployment();
    });

    async function runScenario(title, commitment, aux, revealData, isOptimistic = false) {
        // --- STAGE 1: NEGOTIATION (Commitment) ---
        const cTx = await ovcAccess.connect(claimant).commitClaim(
            provider.address, commitment, aux, 0, providerKeyHash
        );
        const cRec = await cTx.wait();

        let challengeGas = 0n;
        let adjudicationGas = 0n;

        if (isOptimistic) {
            // --- STAGE 2: FINALIZATION (Acceptance) ---
            const aTx = await ovcAccess.connect(provider).acceptClaim(1);
            const aRec = await aTx.wait();
            challengeGas = aRec.gasUsed;
        } else {
            // --- STAGE 2: CHALLENGE (Dispute Trigger) ---
            const dTx = await ovcAccess.connect(provider).disputeClaim(1);
            const dRec = await dTx.wait();
            challengeGas = dRec.gasUsed;

            // --- STAGE 3: ADJUDICATION (Reveal & Verify) ---
            const rTx = await ovcAccess.connect(claimant).revealWitness(1, revealData);
            const rRec = await rTx.wait();
            adjudicationGas = rRec.gasUsed;
        }

        const claim = await ovcAccess.claims(1);

        console.log(`\n[REPORT: ${title}]`);
        console.log(`  - STAGE 1: NEGOTIATION   | ${cRec.gasUsed.toString().padEnd(8)} units`);
        console.log(`  - STAGE 2: CHALLENGE     | ${challengeGas.toString().padEnd(8)} units`);
        console.log(`  - STAGE 3: ADJUDICATION  | ${adjudicationGas.toString().padEnd(8)} units`);
        console.log(`  ---------------------------------------------------`);
        console.log(`  - TOTAL PROTOCOL COST    : ${(cRec.gasUsed + challengeGas + adjudicationGas).toString()} units`);
        console.log(`  - TERMINAL OUTCOME       : ${isOptimistic ? "1 (Accepted)" : claim.outcome.toString()}`);
        console.log("=".repeat(55));

        return claim;
    }

    it("Outcome 1: OPTIMISTIC PATH", async function () {
        await runScenario("OPTIMISTIC (NEGOTIATION ONLY)", ethers.keccak256(secretKey), validAuxHash, null, true);
    });

    it("Outcome 2: HONEST ADJUDICATION", async function () {
        await runScenario("LITIGATED TRUTH (SUCCESSFUL ADJUDICATION)", ethers.keccak256(secretKey), validAuxHash, secretKey);
    });

    it("Outcome 3: BAIT-AND-SWITCH", async function () {
        const wrongKey = ethers.encodeBytes32String("garbage-data-123");
        await runScenario("LITIGATED FRAUD (HASH MISMATCH)", ethers.keccak256(secretKey), validAuxHash, wrongKey);
    });

    it("Outcome 4: INVALID LINKAGE", async function () {
        const secKey = ethers.encodeBytes32String("diff-key");
        await runScenario("LITIGATED FRAUD (AUX MISMATCH)", ethers.keccak256(secKey), validAuxHash, secKey);
    });
});