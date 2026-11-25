/**
 * Helpers that state a Stage 08 conformance claim on-chain from the reference objects:
 * register the machine profile and declare (H, nozzle window, bed window) for hG.
 */
const ref = require("./conformance-reference");

function machineArgs(profile) {
    const envelope = [profile.xMin, profile.xMax, profile.yMin, profile.yMax, profile.zMin, profile.zMax];
    const keys = [...profile.allowed.keys()];
    const kinds = keys.map((k) => profile.allowed.get(k));
    return [envelope, keys, kinds];
}

async function registerMachine(conformance, profile, signer) {
    const c = signer ? conformance.connect(signer) : conformance;
    const args = machineArgs(profile);
    const id = await c.registerMachine.staticCall(...args);
    const tx = await c.registerMachine(...args);
    return { id, tx };
}

function declarationArgs(decl) {
    return [decl.hMax, [decl.nozzleMin, decl.nozzleMax, decl.bedMin, decl.bedMax]];
}

async function declare(conformance, consumer, hG, machineId, decl) {
    return conformance.connect(consumer).declare(hG, machineId, ...declarationArgs(decl));
}

module.exports = { ref, machineArgs, registerMachine, declarationArgs, declare };
