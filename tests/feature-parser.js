/**
 * OVC-Feature parser correctness.
 *
 * Validates the on-chain predicate against an independent JS reference over real
 * FDM G-code, and pins the machine-model behaviours that a context-free byte scan
 * gets wrong (G92 re-datum, M-code E fields, retractions, mid-file mode switches).
 *
 * Run: npx hardhat test tests/feature-parser.js
 */

const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");

const SCALE = 100000n;
const DISPUTE_WINDOW = 100_000;

const GCODE_PLA = path.join(__dirname, "3dbenchy_015mm_pla_mk3_2h.gcode");
const GCODE_ABS = path.join(__dirname, "3dbenchy_0.15mm_ABS_MK3_1h58m.gcode");

// ── Independent reference implementation (integer, mirrors the Solidity model) ──

function referenceTotal(text) {
    let absolute = true, datum = 0n, total = 0n;

    for (const raw of text.split("\n")) {
        const line = raw.split(";")[0].trim();
        if (!line) continue;
        const m = /^([GM])(\d+)/.exec(line);
        if (!m) continue;
        const letter = m[1], code = parseInt(m[2], 10);

        if (letter === "M") {
            if (code === 82) absolute = true;
            else if (code === 83) absolute = false;
            continue;
        }
        if (code !== 0 && code !== 1 && code !== 92) continue;

        const em = /(?:^|[ \t])E(-?\+?\d*\.?\d+)/.exec(line);
        if (!em) continue;
        const value = parseScaled(em[1]);

        if (code === 92) { datum = value; continue; }
        if (absolute) { total += value - datum; datum = value; }
        else { total += value; }
    }
    return total;
}

// "-0.04000" / ".91934" -> integer scaled by 1e5, truncating beyond 5 decimals
function parseScaled(s) {
    let negative = false;
    if (s[0] === "-") { negative = true; s = s.slice(1); }
    else if (s[0] === "+") { s = s.slice(1); }
    const [i, f = ""] = s.split(".");
    const frac = (f + "00000").slice(0, 5);
    const v = BigInt(i || "0") * SCALE + BigInt(frac);
    return negative ? -v : v;
}

// ── Harness ───────────────────────────────────────────────────────────────────

function rollingKeccak(chunks) {
    let hash = ethers.ZeroHash;
    for (const c of chunks) hash = ethers.keccak256(ethers.concat([hash, c]));
    return hash;
}

function splitFixed(buf, size) {
    const out = [];
    for (let o = 0; o < buf.length; o += size) out.push(buf.slice(o, Math.min(o + size, buf.length)));
    return out;
}

async function adjudicate(contract, claimant, provider, chunks, claimValue) {
    const commitment = rollingKeccak(chunks);
    const rec = await (await contract.connect(claimant).commitClaim(
        provider.address, commitment, ethers.ZeroHash, claimValue, ethers.ZeroHash
    )).wait();
    const claimId = rec.logs
        .map(l => { try { return contract.interface.parseLog(l); } catch { return null; } })
        .find(e => e && e.name === "ClaimCommitted").args.claimId;

    await (await contract.connect(provider).disputeClaim(claimId)).wait();
    for (const c of chunks) {
        await (await contract.connect(claimant).depositChunk(claimId, c, {
            gasLimit: c.length * 1500 + 100_000_000,
        })).wait();
    }
    await (await contract.connect(claimant).startAdjudication(claimId)).wait();
    for (const c of chunks) {
        await (await contract.connect(claimant).processChunk(claimId, {
            gasLimit: c.length * 2500 + 200_000_000,
        })).wait();
    }
    return claimId;
}

async function totalFor(contract, claimant, provider, buf, chunkSize, claimValue = 0) {
    const chunks = splitFixed(buf, chunkSize);
    const claimId = await adjudicate(contract, claimant, provider, chunks, claimValue);
    const st = await contract.featureState(claimId);
    return { total: st.total, claimId };
}

describe("OVC-Feature — G-code machine model", function () {
    this.timeout(0);

    let feature, claimant, provider;

    beforeEach(async function () {
        [claimant, provider] = await ethers.getSigners();
        feature = await (await (await ethers.getContractFactory("OVCFeatureSegmented"))
            .deploy(DISPUTE_WINDOW)).waitForDeployment();
    });

    // ── Machine-model unit cases ──────────────────────────────────────────────

    it("ignores E fields on non-motion commands (M907 E538)", async function () {
        const g = "M82\nG1 X0 Y0 E1.0\nM907 E538\nM221 S95\n";
        const { total } = await totalFor(feature, claimant, provider, Buffer.from(g), 4096);
        expect(total).to.equal(1n * SCALE); // not 538
    });

    it("treats G92 as a re-datum, not an extrusion", async function () {
        const g = "M82\nG1 E5.0\nG92 E0\nG1 E5.0\n";
        const { total } = await totalFor(feature, claimant, provider, Buffer.from(g), 4096);
        expect(total).to.equal(10n * SCALE); // 5 + 5, not 5 or 0
    });

    it("nets retraction against re-prime", async function () {
        const g = "M83\nG1 E2.0\nG1 E-0.8\nG1 E0.8\n";
        const { total } = await totalFor(feature, claimant, provider, Buffer.from(g), 4096);
        expect(total).to.equal(2n * SCALE);
    });

    it("honours a mid-file M82/M83 switch", async function () {
        const g = "M83\nG1 E1.0\nM82\nG92 E0\nG1 E3.0\n";
        const { total } = await totalFor(feature, claimant, provider, Buffer.from(g), 4096);
        expect(total).to.equal(4n * SCALE);
    });

    it("parses a leading-dot value (E.91934) as slicers emit it", async function () {
        const g = "M83\nG1 X1 Y1 E.91934\n";
        const { total } = await totalFor(feature, claimant, provider, Buffer.from(g), 4096);
        expect(total).to.equal(91934n);
    });

    // ── Real artifact ─────────────────────────────────────────────────────────

    for (const [label, file] of [["relative/M83 (PLA)", GCODE_PLA], ["absolute/M82 (ABS)", GCODE_ABS]]) {
        it(`matches the reference on real G-code — ${label}`, async function () {
            if (!fs.existsSync(file)) this.skip();
            const whole = fs.readFileSync(file);
            // line-aligned 1 MB prefix keeps the test quick; chunk-invariance is covered below
            const cut = whole.lastIndexOf(0x0a, 256 * 1024) + 1;
            const buf = whole.slice(0, cut);

            const expected = referenceTotal(buf.toString());
            const { total } = await totalFor(feature, claimant, provider, buf, 64 * 1024);

            console.log(`    ${label}: contract ${total} vs reference ${expected}` +
                        `  (${Number(total) / 1e5} mm)`);
            expect(total).to.equal(expected);
        });
    }

    it("is invariant under chunking, including boundaries mid-command", async function () {
        if (!fs.existsSync(GCODE_PLA)) this.skip();
        const whole = fs.readFileSync(GCODE_PLA);
        const cut = whole.lastIndexOf(0x0a, 256 * 1024) + 1;
        const buf = whole.slice(0, cut);

        // 7919 is prime — boundaries land inside commands and E-numbers
        const a = await totalFor(feature, claimant, provider, buf, 64 * 1024);
        const b = await totalFor(feature, claimant, provider, buf, 7919);
        const c = await totalFor(feature, claimant, provider, buf, 1024);

        expect(a.total).to.equal(b.total);
        expect(b.total).to.equal(c.total);
        expect(a.total).to.equal(referenceTotal(buf.toString()));
    });

    // ── Monolithic / segmented agreement ──────────────────────────────────────

    it("monolithic OVCFeature agrees with the segmented predicate on real G-code", async function () {
        if (!fs.existsSync(GCODE_PLA)) this.skip();
        const whole = fs.readFileSync(GCODE_PLA);
        const cut = whole.lastIndexOf(0x0a, 128 * 1024) + 1;
        const buf = whole.slice(0, cut);
        const expected = referenceTotal(buf.toString());

        // Segmented
        const seg = await totalFor(feature, claimant, provider, buf, 32 * 1024);
        expect(seg.total).to.equal(expected);

        // Monolithic: witness arrives whole in calldata, so a truthful claim must
        // resolve Valid and a claim off by one unit must resolve Incorrect.
        const mono = await (await (await ethers.getContractFactory("OVCFeature"))
            .deploy(DISPUTE_WINDOW)).waitForDeployment();

        for (const [claimValue, wantOutcome, label] of [[expected, 2, "Valid"], [expected + 1n, 4, "Incorrect"]]) {
            const rec = await (await mono.connect(claimant).commitClaim(
                provider.address, ethers.keccak256(buf), ethers.ZeroHash, claimValue, ethers.ZeroHash
            )).wait();
            const id = rec.logs
                .map(l => { try { return mono.interface.parseLog(l); } catch { return null; } })
                .find(e => e && e.name === "ClaimCommitted").args.claimId;

            await (await mono.connect(provider).disputeClaim(id)).wait();
            await (await mono.connect(claimant).revealWitness(id, buf, {
                gasLimit: buf.length * 2500 + 200_000_000,
            })).wait();

            expect((await mono.claims(id)).outcome, label).to.equal(wantOutcome);
        }
        console.log(`    both implementations agree: ${expected} (${Number(expected) / 1e5} mm)`);
    });

    it("resolves Valid on a truthful claim and Incorrect on a false one", async function () {
        const g = "M83\nG1 E1.5\nG1 E2.5\n";
        const buf = Buffer.from(g);
        const truth = referenceTotal(g);

        const ok = await totalFor(feature, claimant, provider, buf, 4096, truth);
        await (await feature.finalizeAdjudication(ok.claimId)).wait();
        expect((await feature.claims(ok.claimId)).outcome).to.equal(2); // Valid

        const bad = await totalFor(feature, claimant, provider, buf, 4096, truth + 1n);
        await (await feature.finalizeAdjudication(bad.claimId)).wait();
        expect((await feature.claims(bad.claimId)).outcome).to.equal(4); // Incorrect
    });
});
