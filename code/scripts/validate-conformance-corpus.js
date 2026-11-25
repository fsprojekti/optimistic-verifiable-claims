#!/usr/bin/env node
/**
 * T8 — the machine-profile conformance predicate on the whole frozen corpus (reference model).
 *
 * For every G-code file: run the predicate once with an unbounded height to find the highest
 * extruding Z, then declare exactly that height (the honest claim) and check that the file is
 * Valid, and that a declaration 1 um lower is Incorrect. Writes one JSON record per file.
 *
 * Usage: node scripts/validate-conformance-corpus.js <corpus gcode dir> <out.json>
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ref = require("../tests/lib/conformance-reference");

const [root, out] = process.argv.slice(2);
if (!root || !out) { console.error("usage: validate-conformance-corpus.js <dir> <out.json>"); process.exit(2); }

const profile = ref.machineProfile(ref.PRUSA_XL);
const PLA = { nozzle: [190, 230], bed: [50, 70] };

const files = [];
for (const slicer of fs.readdirSync(root).sort()) {
    const dir = path.join(root, slicer);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir).sort()) if (f.endsWith(".gcode")) files.push([slicer, f, path.join(dir, f)]);
}

const records = [];
for (const [slicer, name, file] of files) {
    const buf = fs.readFileSync(file);
    const t0 = Date.now();
    const probe = ref.conformance(buf, profile, ref.declaration({ height: 1e6, ...PLA }));
    const st = probe.state;
    const rec = {
        slicer, file: name, bytes: buf.length, lines: st.line,
        sha256: crypto.createHash("sha256").update(buf).digest("hex"),
        unbounded: probe.valid ? "Valid" : `Incorrect (${probe.reason}, line ${probe.line ?? "-"})`,
        max_extrude_z_mm: st.maxExtrudeZ === null ? null : st.maxExtrudeZ / ref.SCALE,
        peak_nozzle_c: st.peakNozzle / ref.SCALE,
        peak_bed_c: st.peakBed / ref.SCALE,
        extrusions_below_nozzle_window: st.coldExtrusions,
    };
    if (probe.valid) {
        const h = st.maxExtrudeZ / ref.SCALE;
        const exact = ref.conformance(buf, profile, ref.declaration({ height: h, ...PLA }));
        const lower = ref.conformance(buf, profile, ref.declaration({ height: h - 0.001, ...PLA }));
        rec.declared_height = exact.valid ? "Valid" : `Incorrect (${exact.reason})`;
        rec.height_minus_1um = lower.valid ? "Valid" : `Incorrect (${lower.reason})`;
    }
    rec.ms = Date.now() - t0;
    records.push(rec);
    console.log(`${slicer.padEnd(6)} ${name.padEnd(30)} ${rec.unbounded.padEnd(10)} H=${rec.max_extrude_z_mm} ` +
        `noz=${rec.peak_nozzle_c} bed=${rec.peak_bed_c} cold=${rec.extrusions_below_nozzle_window} ` +
        `${rec.declared_height ?? ""} / ${rec.height_minus_1um ?? ""}`);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({
    test: "T8", generated: new Date().toISOString(),
    profile: ref.PRUSA_XL, material_window: PLA, files: records,
}, null, 2));
const valid = records.filter((r) => r.unbounded === "Valid").length;
console.log(`\n${valid}/${records.length} Valid under the unbounded height`);
