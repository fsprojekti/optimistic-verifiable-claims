const { expect } = require("chai");
const { ethers } = require("hardhat");
const { PLAINTEXT_DOMAIN, segmentedCommitment } = require("./lib/segmented-commitment");
const { netExtrusion, SCALE } = require("./lib/gcode-reference");

// Arc-fitted slicer output (OrcaSlicer, PrusaSlicer) extrudes on G2/G3 as well as G0/G1.
const GCODE = Buffer.from([
    "M83 ; relative extrusion",
    "G1 X10 Y10 E1.50000",
    "G2 X20 Y10 I5 J0 E2.25000",
    "G3 X10 Y10 I-5 J0 E.75000",
    "G1 E-0.80000 ; retract",
    "G1 E0.80000 ; re-prime",
    "M907 E538",
    "G1 X0 Y0 E1.00000",
    "",
].join("\n"));
const CHUNK = 16; // forces lines to split across chunk boundaries
const OUTCOME = { Valid: 2n, Incorrect: 4n };

describe("Stage 05 Feature: arc moves are commanded extrusion", function () {
    async function adjudicate(fClaim) {
        const [consumer, provider] = await ethers.getSigners();
        const feature = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(100);
        const hG = segmentedCommitment(GCODE, CHUNK, PLAINTEXT_DOMAIN);
        await feature.commitClaim(provider.address, hG, ethers.ZeroHash, fClaim, ethers.ZeroHash);
        const id = await feature.claimCount();
        await feature.configureWitnessTerms(id, GCODE.length, 0);
        await feature.configureDepositFormat(id, PLAINTEXT_DOMAIN, GCODE.length, CHUNK);
        await feature.connect(provider).disputeClaim(id);
        for (let offset = 0; offset < GCODE.length; offset += CHUNK) {
            await feature.depositChunk(id, GCODE.subarray(offset, offset + CHUNK));
        }
        await feature.startAdjudication(id);
        for (let offset = 0; offset < GCODE.length; offset += CHUNK) await feature.processChunk(id);
        await feature.finalizeAdjudication(id);
        return (await feature.claims(id)).outcome;
    }

    it("counts G2/G3 extrusion in the reference model", function () {
        expect(netExtrusion(GCODE.toString("utf8"))).to.equal(5n * SCALE + 50000n); // 5.5 mm
    });

    it("returns Valid for the declared total including arcs", async function () {
        expect(await adjudicate(netExtrusion(GCODE.toString("utf8")))).to.equal(OUTCOME.Valid);
    });

    it("returns Incorrect for a total that omits arc extrusion", async function () {
        expect(await adjudicate(2n * SCALE + 50000n)).to.equal(OUTCOME.Incorrect); // G0/G1 only
    });
});
