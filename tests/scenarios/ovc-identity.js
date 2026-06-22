const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("OVC-Identity: Stage-Level Cryptographic Benchmarking", function () {
    let ovcIdentity;
    let claimant, provider;

    const gcodeLines = ["G21", "G90", "M82", "G92 E0", "G1 X0 Y0 Z0.2 F3000", "G1 X20 Y0 E1.5 F1500"];
    const baseGcode = ethers.toUtf8Bytes(gcodeLines.join("\n"));
    const secretK = ethers.randomBytes(32);                 // K — 32-byte XOR key

    // C = G XOR K
    const encryptedBlob = new Uint8Array(baseGcode.length);
    for (let i = 0; i < baseGcode.length; i++) {
        encryptedBlob[i] = baseGcode[i] ^ secretK[i % 32];
    }

    // Witness triple: K || G || C
    const validWitness = ethers.concat([secretK, baseGcode, encryptedBlob]);

    // Commitment: H(K || G || C)
    const validCommitment = ethers.keccak256(validWitness);

    beforeEach(async function () {
        [claimant, provider] = await ethers.getSigners();
        const Factory = await ethers.getContractFactory("OVCIdentity");
        ovcIdentity = await Factory.deploy(100);
        await ovcIdentity.waitForDeployment();
    });

    /**
     * @param title        Scenario label.
     * @param ciphertext   C stored on-chain at binding.
     * @param commitment   H(K || G || C) committed at binding.
     * @param witness      Bytes revealed at dispute; null for optimistic path.
     * @param isOptimistic True → provider accepts without dispute.
     */
    async function runScenario(title, ciphertext, commitment, witness, isOptimistic = false) {
        // --- STAGE 1: BINDING ---
        const cTx = await ovcIdentity.connect(claimant).commitIdentityClaim(
            provider.address, commitment, ciphertext
        );
        const cRec = await cTx.wait();

        let stage2Gas = 0n;
        let stage3Gas = 0n;

        if (isOptimistic) {
            // --- STAGE 2: ACCEPTANCE ---
            const aTx = await ovcIdentity.connect(provider).acceptClaim(1);
            const aRec = await aTx.wait();
            stage2Gas = aRec.gasUsed;
        } else {
            // --- STAGE 2: DISPUTE ---
            const dTx = await ovcIdentity.connect(provider).disputeClaim(1);
            const dRec = await dTx.wait();
            stage2Gas = dRec.gasUsed;

            // --- STAGE 3: REVEAL WITNESS (K || G || C) ---
            const rTx = await ovcIdentity.connect(claimant).revealWitness(1, witness);
            const rRec = await rTx.wait();
            stage3Gas = rRec.gasUsed;
        }

        const claim = await ovcIdentity.claims(1);

        console.log(`\n[REPORT: ${title}]`);
        console.log(`  - STAGE 1: BINDING       | ${cRec.gasUsed.toString().padEnd(8)} units`);
        console.log(`  - STAGE 2: CHALLENGE     | ${stage2Gas.toString().padEnd(8)} units`);
        console.log(`  - STAGE 3: ADJUDICATION  | ${stage3Gas.toString().padEnd(8)} units`);
        console.log(`  ---------------------------------------------------`);
        console.log(`  - TOTAL PROTOCOL COST    : ${(cRec.gasUsed + stage2Gas + stage3Gas).toString()} units`);
        console.log(`  - TERMINAL OUTCOME       : ${isOptimistic ? "1 (Accepted)" : claim.outcome.toString()}`);
        console.log("=".repeat(55));

        return claim;
    }

    it("Outcome 1: OPTIMISTIC ACCEPTANCE", async function () {
        const claim = await runScenario(
            "OPTIMISTIC PATH",
            encryptedBlob, validCommitment,
            null, true
        );
        expect(claim.outcome).to.equal(1n); // Accepted
    });

    it("Outcome 2: HONEST ADJUDICATION", async function () {
        // Consumer reveals correct triple (K, G, C) → hash matches → G XOR K == C → VALID
        const claim = await runScenario(
            "LITIGATED TRUTH (TRIPLE WITNESS)",
            encryptedBlob, validCommitment,
            validWitness
        );
        expect(claim.outcome).to.equal(2n); // Valid
    });

    it("Outcome 3: WITNESS FRAUD (wrong key in triple)", async function () {
        // Consumer reveals wrong K' — keccak256(K'||G||C) != commitment → INCONSISTENT
        const wrongK = ethers.randomBytes(32);
        const wrongWitness = ethers.concat([wrongK, baseGcode, encryptedBlob]);
        const claim = await runScenario(
            "LITIGATED FRAUD (WRONG KEY — INCONSISTENT)",
            encryptedBlob, validCommitment,
            wrongWitness
        );
        expect(claim.outcome).to.equal(3n); // Inconsistent
    });

    it("Outcome 4: INVALID TRIPLE (hashes match but G XOR K != C)", async function () {
        // Consumer commits an internally inconsistent triple: H(K, G, C_fake) where G XOR K != C_fake
        // Hash check passes (Consumer reveals exactly what they committed) but XOR check fails → INCORRECT
        const fakeC = ethers.randomBytes(baseGcode.length); // C_fake ≠ G XOR K
        const invalidWitness = ethers.concat([secretK, baseGcode, fakeC]);
        const invalidCommitment = ethers.keccak256(invalidWitness);

        const claim = await runScenario(
            "LITIGATED FRAUD (INVALID TRIPLE — INCORRECT)",
            fakeC, invalidCommitment,
            invalidWitness
        );
        expect(claim.outcome).to.equal(4n); // Incorrect
    });
});