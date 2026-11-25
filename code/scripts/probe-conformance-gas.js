/**
 * Quick in-process probe (Hardhat network): per-transaction gas of the Stage 08 Conformance
 * sweep against the Feature sweep, on the same chunks. Answers whether the new predicate can
 * become the binding process for the operating chunk c* (it must stay below Identity).
 * Not a measurement of record; the campaign runs on Anvil (tests/pilot/conformance-ladder.js).
 *
 * Usage: OVC_PROBE_FILES=rackstack_hinge:prusa,... OVC_PROBE_CHUNKS=4160,8000 npx hardhat run scripts/probe-conformance-gas.js
 */
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");
const { PLAINTEXT_DOMAIN, segmentedCommitment } = require("../tests/lib/segmented-commitment");
const { ref, registerMachine, declare } = require("../tests/lib/conformance-claim");
const { netExtrusion } = require("../tests/lib/gcode-reference");

const ROOT = process.env.OVC_CORPUS_ROOT ||
    path.resolve(__dirname, "../../../stage-02-secure-real-corpus-validation/data/corpus/generated/gcode");
const FILES = (process.env.OVC_PROBE_FILES || "rackstack_hinge:cura,rackstack_hinge:orca,rackstack_hinge:prusa").split(",");
const CHUNKS = (process.env.OVC_PROBE_CHUNKS || "4160").split(",").map(Number);
const PROFILE = ref.machineProfile(ref.PRUSA_XL);

async function sweepGas(contract, consumer, provider, g, chunk, claimValue, prepare) {
    const hG = segmentedCommitment(g, chunk, PLAINTEXT_DOMAIN);
    if (prepare) await prepare(hG);
    await contract.commitClaim(provider.address, hG, ethers.ZeroHash, claimValue, ethers.ZeroHash);
    const id = await contract.claimCount();
    await contract.configureWitnessTerms(id, g.length, 0);
    await contract.configureDepositFormat(id, PLAINTEXT_DOMAIN, g.length, chunk);
    await contract.connect(provider).disputeClaim(id);
    for (let o = 0; o < g.length; o += chunk) await contract.depositChunk(id, g.subarray(o, o + chunk));
    await contract.startAdjudication(id);
    const gas = [];
    for (let o = 0; o < g.length; o += chunk) {
        const r = await (await contract.processChunk(id, { gasLimit: 3_000_000_000 })).wait();
        gas.push(Number(r.gasUsed));
    }
    await contract.finalizeAdjudication(id);
    const outcome = (await contract.claims(id)).outcome;
    return { total: gas.reduce((a, b) => a + b, 0), max: Math.max(...gas), n: gas.length, outcome };
}

async function main() {
    const [consumer, provider] = await ethers.getSigners();
    const conf = await (await ethers.getContractFactory("OVCConformanceSegmented")).deploy(1_000_000);
    const feat = await (await ethers.getContractFactory("OVCFeatureSegmented")).deploy(1_000_000);
    const { id: machineId } = await registerMachine(conf, PROFILE);
    for (const key of FILES) {
        const [model, slicer] = key.split(":");
        const g = fs.readFileSync(path.join(ROOT, slicer, `${model}.gcode`));
        const h = ref.conformance(g, PROFILE, ref.declaration({ height: 1e6, nozzle: [190, 230], bed: [50, 70] })).state.maxExtrudeZ / ref.SCALE;
        const decl = ref.declaration({ height: h, nozzle: [190, 230], bed: [50, 70] });
        for (const chunk of CHUNKS) {
            const c = await sweepGas(conf, consumer, provider, g, chunk, 0, (hG) => declare(conf, consumer, hG, machineId, decl));
            const f = await sweepGas(feat, consumer, provider, g, chunk, netExtrusion(g.toString("utf8")));
            console.log(`${key.padEnd(30)} ${String(g.length).padStart(9)} B chunk ${String(chunk).padStart(6)} | ` +
                `conformance ${c.total.toLocaleString().padStart(14)} max/tx ${c.max.toLocaleString().padStart(12)} (${c.outcome}) | ` +
                `feature ${f.total.toLocaleString().padStart(14)} max/tx ${f.max.toLocaleString().padStart(12)} (${f.outcome}) | ` +
                `ratio ${(c.total / f.total).toFixed(3)}`);
        }
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
