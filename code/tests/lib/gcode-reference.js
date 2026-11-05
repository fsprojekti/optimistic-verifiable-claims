/**
 * Off-chain reference for the OVC-Feature predicate.
 *
 * Mirrors the on-chain G-code machine model in OVCBase._netExtrusion and
 * OVCFeatureSegmented._processChunk exactly, in integer arithmetic:
 *
 *   f(G) = Î£ Î”E over G0-G3 motion commands (linear and arc moves), where
 *     - M82 / M83 select absolute / relative mode (initial state: absolute)
 *     - G92 E<v> re-datums the axis without extruding
 *     - E is signed, so retraction and re-prime cancel
 *     - E fields on non-motion commands (M907 E538) are ignored
 *
 * Values are scaled by 1e5 (5 decimals), matching slicer output precision.
 * Used to derive the honest f_claim a Consumer would commit to, and as the
 * independent oracle the contracts are tested against.
 */

const SCALE = 100000n;

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

function netExtrusion(text) {
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
        if (code > 3 && code !== 92) continue; // G0-G3 extrude; G92 re-datums

        const em = /(?:^|[ \t])E(-?\+?\d*\.?\d+)/.exec(line);
        if (!em) continue;
        const value = parseScaled(em[1]);

        if (code === 92) { datum = value; continue; }
        if (absolute) { total += value - datum; datum = value; }
        else { total += value; }
    }
    return total;
}

// The slicer's own "; filament used [mm]" header, for cross-validation.
// Note it excludes start-G-code priming, so it will not match f(G) exactly.
function slicerFilamentUsed(text) {
    const m = /filament used \[mm\]\s*=\s*([\d.]+)/.exec(text);
    return m ? parseFloat(m[1]) : null;
}

module.exports = { SCALE, netExtrusion, parseScaled, slicerFilamentUsed };

