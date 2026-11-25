const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { PLAINTEXT_DOMAIN, segmentedCommitment } = require("./lib/segmented-commitment");
const { ref, registerMachine, declare } = require("./lib/conformance-claim");

const OUTCOME = { Valid: 2n, Incorrect: 4n };
const PROFILE = ref.machineProfile(ref.PRUSA_XL);
const PLA = { nozzle: [190, 230], bed: [50, 70] };
const declFor = (height) => ref.declaration({ height, ...PLA });

const HEADER = [
    "M140 S60", "M104 S215", "M190 S60", "M109 S215",
    "G28 ; home", "G90", "M83", "G1 Z0.2 F720",
];
const program = (...lines) => Buffer.from([...HEADER, ...lines, ""].join("\n"));
const HONEST = program(
    "G1 X10 Y10 E1.5", "G2 X20 Y10 I5 J0 E2.25", "G3 X10 Y10 I-5 J0 E.75",
    "G1 E-0.8 ; retract", "G1 Z1.2", "G1 E0.8", "G1 X0 Y0 E1", "M104 S0", "M140 S0",
);

describe("Stage 08 Conformance: machine-profile predicate", function () {
    this.timeout(600000);
    let conformance, consumer, provider, machineId;

    before(async function () {
        [consumer, provider] = await ethers.getSigners();
        conformance = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(1000);
        ({ id: machineId } = await registerMachine(conformance, PROFILE));
    });

    // Full dispute path; a fresh hG per call (salted by a comment) keeps declarations independent.
    let salt = 0;
    async function adjudicate(gcode, decl, chunk = 16, opts = {}) {
        const g = Buffer.concat([gcode, Buffer.from(`; case ${salt++}\n`)]);
        const hG = segmentedCommitment(g, chunk, PLAINTEXT_DOMAIN);
        if (!opts.skipDeclare) await declare(conformance, consumer, hG, machineId, decl);
        await conformance.commitClaim(provider.address, hG, ethers.ZeroHash, 0, ethers.ZeroHash);
        const id = await conformance.claimCount();
        await conformance.configureWitnessTerms(id, g.length, 0);
        await conformance.configureDepositFormat(id, PLAINTEXT_DOMAIN, g.length, chunk);
        await conformance.connect(provider).disputeClaim(id);
        for (let o = 0; o < g.length; o += chunk) await conformance.depositChunk(id, g.subarray(o, o + chunk));
        if (opts.skipDeclare) return { id, start: conformance.startAdjudication(id) };
        await conformance.startAdjudication(id);
        for (let o = 0; o < g.length; o += chunk) await conformance.processChunk(id);
        await conformance.finalizeAdjudication(id);
        const onchain = (await conformance.claims(id)).outcome;
        const expected = ref.conformance(g, PROFILE, decl).valid ? OUTCOME.Valid : OUTCOME.Incorrect;
        expect(onchain, "contract and reference disagree").to.equal(expected);
        return onchain;
    }

    describe("targeted cases", function () {
        const cases = [
            ["honest program", HONEST, 1.2, "Valid"],
            ["marker only in a comment (accepted by the Stage 07 predicate)",
                Buffer.from("M140 S60\nM104 S215\n; G1 X10 E5\nM107\n"), 10, "Incorrect"],
            ["command not in the profile (M600 filament change)", program("G1 X10 Y10 E1", "M600"), 10, "Incorrect"],
            ["malformed number", program("G1 X1.2.3 Y10 E1"), 10, "Incorrect"],
            ["non-G-code line", program("G1 X10 Y10 E1", "HELLO"), 10, "Incorrect"],
            ["lower-case word", program("G1 x10 Y10 E1"), 10, "Incorrect"],
            ["repeated word (X10 then X500)", program("G1 X10 X500 E1"), 10, "Incorrect"],
            ["glued words are accepted", program("G1X10Y10E1"), 10, "Valid"],
            ["arc touching the envelope edge", program("G1 X350 Y100", "G3 X350 Y120 I0 J10 E1"), 10, "Valid"],
            ["endpoint outside the envelope", program("G1 X10 Y10 E1", "G1 X400"), 10, "Incorrect"],
            ["arc bulging outside the envelope", program("G1 X355 Y100", "G3 X355 Y120 I0 J10 E1"), 10, "Incorrect"],
            ["the same chord swept the other way stays inside", program("G1 X355 Y100", "G2 X355 Y120 I0 J10 E1"), 10, "Valid"],
            ["full-turn arc checks the whole circle", program("G1 X355 Y100", "G2 X355 Y120 I0 J10 P1 E1"), 10, "Incorrect"],
            ["arc in radius form (R) is rejected", program("G1 X10 Y10", "G2 X20 Y10 R5 E1"), 10, "Incorrect"],
            ["extrusion above the declared height", program("G1 X10 Y10 E1", "G1 Z10.5", "G1 X20 E1"), 10, "Incorrect"],
            ["travel above the declared height is allowed", program("G1 X10 Y10 E1", "G1 Z50", "G1 X20"), 10, "Valid"],
            ["retraction above the declared height is allowed", program("G1 X10 Y10 E1", "G1 Z50 E-1"), 10, "Valid"],
            ["nozzle above the material window", program("G1 X10 Y10 E1", "M104 S280"), 10, "Incorrect"],
            ["peak nozzle below the material window", Buffer.from(
                ["M140 S60", "M109 S180", "G28", "G90", "M83", "G1 Z0.2", "G1 X10 Y10 E1", ""].join("\n")), 10, "Incorrect"],
            ["bed above the material window", program("G1 X10 Y10 E1", "M140 S110"), 10, "Incorrect"],
            ["G92 may set E only", program("G92 Z0", "G1 X10 Y10 E1"), 10, "Incorrect"],
            ["extrusion at unknown Z after homing", program("G28 Z", "G1 X10 Y10 E1"), 10, "Incorrect"],
            ["relative move from unknown position", Buffer.from(
                ["M140 S60", "M109 S215", "G91", "G1 X10 E1", ""].join("\n")), 10, "Incorrect"],
            ["relative positioning from a known position", program("G1 X5 Y5", "G91", "G1 X10 Y10 E1", "G90"), 10, "Valid"],
            ["no extrusion at all", program("G1 X10 Y10"), 10, "Incorrect"],
            ["free-text command (M486 object label)", program("M486 Apart one.stl", "G1 X10 Y10 E1"), 10, "Valid"],
        ];
        for (const [name, gcode, height, verdict] of cases) {
            it(`${verdict}: ${name}`, async function () {
                expect(await adjudicate(gcode, declFor(height))).to.equal(OUTCOME[verdict]);
            });
        }

        it("the verdict does not depend on the chunk size", async function () {
            const g = program("G1 X10 Y10 E1.5", "G2 X20 Y10 I5 J0 E2.25", "M104 S280");
            for (const chunk of [1, 7, 16, 64, g.length + 32]) {
                expect(await adjudicate(g, declFor(10), chunk)).to.equal(OUTCOME.Incorrect);
                expect(await adjudicate(HONEST, declFor(1.2), chunk)).to.equal(OUTCOME.Valid);
            }
        });
    });

    describe("claim statement", function () {
        it("an undeclared claim cannot start adjudication", async function () {
            const { start } = await adjudicate(HONEST, declFor(10), 16, { skipDeclare: true });
            await expect(start).to.be.revertedWith("Not declared");
        });

        it("a declaration cannot be changed", async function () {
            const hG = ethers.id("immutable declaration");
            await declare(conformance, consumer, hG, machineId, declFor(10));
            await expect(declare(conformance, consumer, hG, machineId, declFor(20))).to.be.revertedWith("Already declared");
        });

        it("a declaration must name a registered machine", async function () {
            await expect(declare(conformance, consumer, ethers.id("x"), ethers.id("no machine"), declFor(10)))
                .to.be.revertedWith("Unknown machine");
        });

        it("registering the same machine twice returns the same id", async function () {
            const { id } = await registerMachine(conformance, PROFILE);
            expect(id).to.equal(machineId);
        });
    });

    describe("differential test against the reference", function () {
        // Deterministic generator of near-valid programs: each line is valid or one mutation away.
        let seed = 20261125;
        const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
        const pick = (a) => a[Math.floor(rnd() * a.length)];
        const num = (lo, hi) => (lo + rnd() * (hi - lo)).toFixed(pick([0, 1, 3, 5]));
        const LINES = [
            () => `G1 X${num(-20, 380)} Y${num(-20, 380)} E${num(-1, 2)}`,
            () => `G0 X${num(0, 360)} Y${num(0, 360)} F9000`,
            () => `G1 Z${num(0, 14)}`,
            () => `G${pick([2, 3])} X${num(300, 360)} Y${num(0, 40)} I${num(-30, 30)} J${num(-30, 30)} E${num(0, 1)}`,
            () => `M104 S${num(150, 260)}`,
            () => `M140 S${num(40, 90)}`,
            () => pick(["G91", "G90", "M82", "M83", "G92 E0", "G28 XY", "M107", "M600", "G4 P10"]),
            () => pick(["; comment G1 X1", "", "   ", "G1 X10 X20", "g1 X1", "G1 X.", "G1 X-", "M862.3 P \"XL\"", "G1X5Y5E.5"]),
        ];
        it("agrees with the reference on 120 generated programs at chunk sizes 7, 23 and whole", async function () {
            let valid = 0;
            for (let p = 0; p < 120; p++) {
                const body = Array.from({ length: 4 + Math.floor(rnd() * 10) }, () => pick(LINES)());
                const g = program("G1 X100 Y100 E1", ...body);
                const height = pick([5, 10, 14]);
                const chunk = pick([7, 23, g.length + 64]);
                if ((await adjudicate(g, declFor(height), chunk)) === OUTCOME.Valid) valid++;
            }
            // Both verdicts must be exercised for the agreement to mean anything.
            expect(valid).to.be.within(10, 110);
        });
    });

    describe("genuine slicer output (rackstack_hinge)", function () {
        const root = process.env.OVC_CORPUS_ROOT ||
            path.resolve(__dirname, "../../../stage-02-secure-real-corpus-validation/data/corpus/generated/gcode");
        for (const slicer of ["cura", "orca", "prusa"]) {
            it(`${slicer}: Valid at the declared height, Incorrect 1 um lower`, async function () {
                const file = path.join(root, slicer, "rackstack_hinge.gcode");
                if (!fs.existsSync(file)) this.skip();
                const g = fs.readFileSync(file);
                const h = ref.conformance(g, PROFILE, declFor(1e6)).state.maxExtrudeZ / ref.SCALE;
                expect(await adjudicate(g, declFor(h), 4160)).to.equal(OUTCOME.Valid);
                expect(await adjudicate(g, declFor(h - 0.001), 4160)).to.equal(OUTCOME.Incorrect);
            });
        }
    });
});
