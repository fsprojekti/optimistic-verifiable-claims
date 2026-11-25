/**
 * Off-chain reference for the OVC-Conformance predicate (Stage 08, machine-profile conformance).
 *
 * The claim is: "G is a program for machine profile M, prints within the material window
 * declared in D, and deposits no material above the declared height H". The predicate
 * accepts iff, reading G line by line,
 *
 *   (1) grammar    every line parses under the line grammar below;
 *   (2) commands   every command word is in M's command list;
 *   (3) envelope   every motion endpoint lies in M's travel envelope, and so does every arc:
 *                  an axis extreme of the arc's circle is checked whenever the arc sweeps it
 *                  (exact in integers, no trigonometry; a full turn P >= 1 sweeps all four);
 *   (4) height     every extruding move starts and ends at Z <= H;
 *   (5) material   no nozzle (bed) setpoint exceeds D's maximum, and the highest nozzle
 *                  (bed) setpoint reaches D's minimum;
 *   (6) extrusion  at least one move extrudes.
 *
 * Height counts every extruding move, priming included: Cura's stock start G-code primes at
 * Z = 15 mm, so a Cura file for a 10 mm part declares H >= 15 mm.
 *
 * Line grammar (bytes; ws = space, tab or CR):
 *   line    := ws* [ command ( ws* word )* ws* ] [ ';' any* ]
 *   command := ('G' | 'M' | 'T') digit{1,4} [ '.' digit ]
 *   word    := 'A'..'Z' [ number ]                       (each letter at most once per line)
 *   number  := ['+'|'-'] ( digit{1,9} ['.' digit*] | '.' digit+ )
 * A command listed as free-text in M takes the rest of the line up to ';' as printable ASCII
 * (M486 A<name>, M862.3 P "XL", M115 U<version>) and has no further effect.
 *
 * Machine model (Marlin semantics):
 *   G0-G3 move; G2/G3 need I or J (centre form, R is rejected); motion words X Y Z E F,
 *   arcs also I J P. G90/G91 set absolute/relative positioning for XYZ and E; M82/M83 set E
 *   alone. G92 may set E only. G28 [X][Y][Z] homes axes and makes their position unknown
 *   until an absolute move sets it. M104/M109 S|R set the nozzle, M140/M190 S|R the bed.
 *   A relative move or an arc from an unknown position, and an extruding move at unknown Z,
 *   are violations.
 *
 * Values are fixed point scaled by 1e5, truncating beyond 5 decimals; integer parts are at
 * most 9 digits, so every value is exact in a JS Number. Arc squares use BigInt.
 * The on-chain implementation (OVCConformanceSegmented.sol) mirrors this file step by step.
 */

const SCALE = 100000;

const WS = new Set([0x20, 0x09, 0x0d]);
const isDigit = (b) => b >= 0x30 && b <= 0x39;
const isUpper = (b) => b >= 0x41 && b <= 0x5a;

const LETTER = { G: 0x47, M: 0x4d, T: 0x54 };

// Command key: letter << 24 | code << 4 | (sub + 1, or 0 without a sub-code)
function commandKey(letter, code, sub) {
    return letter * 2 ** 24 + code * 16 + (sub === null ? 0 : sub + 1);
}

function parseCommandName(name) {
    const m = /^([GMT])(\d{1,4})(?:\.(\d))?$/.exec(name);
    if (!m) throw new Error(`bad command ${name}`);
    return commandKey(LETTER[m[1]], parseInt(m[2], 10), m[3] === undefined ? null : parseInt(m[3], 10));
}

/** Build a machine profile. Lengths in mm, as Numbers; commands as names. */
function machineProfile({ x, y, z, commands, freeText = [] }) {
    const s = (v) => Math.round(v * SCALE);
    const allowed = new Map();
    for (const c of commands) allowed.set(parseCommandName(c), 1);
    for (const c of freeText) allowed.set(parseCommandName(c), 2);
    return {
        xMin: s(x[0]), xMax: s(x[1]), yMin: s(y[0]), yMax: s(y[1]), zMin: s(z[0]), zMax: s(z[1]),
        allowed,
    };
}

/** Build a design declaration. Height in mm, temperatures in degrees C. */
function declaration({ height, nozzle, bed }) {
    const s = (v) => Math.round(v * SCALE);
    return {
        hMax: s(height),
        nozzleMin: s(nozzle[0]), nozzleMax: s(nozzle[1]),
        bedMin: s(bed[0]), bedMax: s(bed[1]),
    };
}

const BIT = (letter) => 1 << (letter - 0x41);
const MOTION_WORDS = BIT(0x58) | BIT(0x59) | BIT(0x5a) | BIT(0x45) | BIT(0x46);            // XYZEF
const ARC_WORDS = MOTION_WORDS | BIT(0x49) | BIT(0x4a) | BIT(0x50);                         // + IJP
const HOME_WORDS = BIT(0x58) | BIT(0x59) | BIT(0x5a);                                       // XYZ
const SETPOS_WORDS = BIT(0x45);                                                             // E

function newState() {
    return {
        violation: null,      // first violation, as { line, reason }
        line: 0,
        posRel: false, eRel: false,
        known: 0,             // bit 0 X, 1 Y, 2 Z
        x: 0, y: 0, z: 0, eDatum: 0,
        peakNozzle: 0, peakBed: 0,
        extruded: false,
        maxExtrudeZ: null,
        // diagnostic only: extruding moves commanded below the nozzle window
        coldExtrusions: 0, nozzleSetpoint: 0,
    };
}

function fail(st, reason) {
    if (!st.violation) st.violation = { line: st.line, reason };
}

/**
 * Parse one number at buf[i..end). Returns [value, nextIndex] or null on a grammar error.
 */
function parseNumber(buf, i, end) {
    let neg = false;
    if (i < end && (buf[i] === 0x2d || buf[i] === 0x2b)) { neg = buf[i] === 0x2d; i++; }
    let intPart = 0, intDigits = 0, frac = 0, fracDigits = 0, any = false;
    while (i < end && isDigit(buf[i])) {
        if (++intDigits > 9) return null;
        intPart = intPart * 10 + (buf[i] - 0x30); i++; any = true;
    }
    if (i < end && buf[i] === 0x2e) {
        i++;
        while (i < end && isDigit(buf[i])) {
            if (fracDigits < 5) { frac = frac * 10 + (buf[i] - 0x30); fracDigits++; }
            i++; any = true;
        }
    }
    if (!any) return null;
    while (fracDigits < 5) { frac *= 10; fracDigits++; }
    const v = intPart * SCALE + frac;
    return [neg ? -v : v, i];
}

function processLine(buf, start, end, profile, decl, st) {
    st.line++;
    if (st.violation) return;
    for (let i = start; i < end; i++) if (buf[i] === 0x3b) { end = i; break; }   // ';'
    let i = start;
    while (i < end && WS.has(buf[i])) i++;
    if (i >= end) return;                                                         // blank

    // command
    const letter = buf[i];
    if (letter !== LETTER.G && letter !== LETTER.M && letter !== LETTER.T) return fail(st, "command letter");
    i++;
    let code = 0, digits = 0;
    while (i < end && isDigit(buf[i])) {
        if (++digits > 4) return fail(st, "command code");
        code = code * 10 + (buf[i] - 0x30); i++;
    }
    if (digits === 0) return fail(st, "command code");
    let sub = null;
    if (i < end && buf[i] === 0x2e) {
        i++;
        if (!(i < end && isDigit(buf[i]))) return fail(st, "sub-code");
        sub = buf[i] - 0x30; i++;
        if (i < end && isDigit(buf[i])) return fail(st, "sub-code");
    }
    const kind = profile.allowed.get(commandKey(letter, code, sub)) || 0;
    if (kind === 0) return fail(st, "command not in profile");
    if (kind === 2) {
        for (; i < end; i++) if (buf[i] < 0x20 && buf[i] !== 0x09 && buf[i] !== 0x0d || buf[i] > 0x7e) return fail(st, "free text");
        return;
    }
    if (i < end && !WS.has(buf[i]) && !isUpper(buf[i])) return fail(st, "word");

    // words
    let seen = 0;
    const val = {};
    while (true) {
        while (i < end && WS.has(buf[i])) i++;
        if (i >= end) break;
        const w = buf[i];
        if (!isUpper(w)) return fail(st, "word");
        if (seen & BIT(w)) return fail(st, "repeated word");
        seen |= BIT(w);
        i++;
        if (i < end && (isDigit(buf[i]) || buf[i] === 0x2d || buf[i] === 0x2b || buf[i] === 0x2e)) {
            const r = parseNumber(buf, i, end);
            if (!r) return fail(st, "number");
            val[w] = r[0]; i = r[1];
        } else {
            val[w] = null;                                                          // flag word
        }
    }

    const has = (c) => (seen & BIT(c)) !== 0;
    const num = (c) => val[c];

    if (letter === LETTER.G) {
        if (code <= 3 && sub === null) return motion(code, seen, val, profile, decl, st);
        if (sub !== null) return;
        if (code === 90) { st.posRel = false; st.eRel = false; return; }
        if (code === 91) { st.posRel = true; st.eRel = true; return; }
        if (code === 92) {
            if (seen & ~SETPOS_WORDS) return fail(st, "G92 sets E only");
            if (has(0x45)) { if (num(0x45) === null) return fail(st, "G92 E value"); st.eDatum = num(0x45); }
            return;
        }
        if (code === 28) {
            if (seen & ~HOME_WORDS) return fail(st, "G28 words");
            st.known &= seen === 0 ? 0 : ~(((seen >> 23) & 1) | (((seen >> 24) & 1) << 1) | (((seen >> 25) & 1) << 2));
            return;
        }
        return;
    }
    if (letter === LETTER.M && sub === null) {
        if (code === 82) { st.eRel = false; return; }
        if (code === 83) { st.eRel = true; return; }
        const nozzle = code === 104 || code === 109;
        const bed = code === 140 || code === 190;
        if (nozzle || bed) {
            for (const c of [0x53, 0x52]) {                                          // S, R
                if (!has(c)) continue;
                const v = num(c);
                if (v === null) return fail(st, "temperature value");
                if (nozzle) { if (v > st.peakNozzle) st.peakNozzle = v; st.nozzleSetpoint = v; }
                else if (v > st.peakBed) st.peakBed = v;
            }
        }
    }
}

const AXIS = [0x58, 0x59, 0x5a];

const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];

/**
 * Does the counter-clockwise sweep from direction u to direction v pass direction d?
 * Exact in integers. Directions equal to an endpoint count as swept (conservative: the
 * endpoint is checked anyway). Coincident u and v are a full circle, as in Marlin.
 */
function ccwSweeps(u, v, d) {
    const uv = cross(u, v);
    if (uv > 0n) return cross(u, d) >= 0n && cross(d, v) >= 0n;           // less than 180 deg
    if (uv < 0n) return !(cross(v, d) > 0n && cross(d, u) > 0n);           // more than 180 deg
    if (dot(u, v) > 0n) return true;                                        // full circle
    return cross(u, d) >= 0n;                                               // exactly 180 deg
}

function motion(code, seen, val, profile, decl, st) {
    const arc = code >= 2;
    if (seen & ~(arc ? ARC_WORDS : MOTION_WORDS)) return fail(st, "motion words");
    for (const c of [0x58, 0x59, 0x5a, 0x45, 0x49, 0x4a, 0x50, 0x46]) {
        if ((seen & BIT(c)) && val[c] === null) return fail(st, "motion value");
    }
    const startZ = st.z, startZKnown = (st.known & 4) !== 0;
    const sx = st.x, sy = st.y, startXYKnown = (st.known & 3) === 3;

    const lo = [profile.xMin, profile.yMin, profile.zMin];
    const hi = [profile.xMax, profile.yMax, profile.zMax];
    const pos = [st.x, st.y, st.z];
    for (let a = 0; a < 3; a++) {
        const c = AXIS[a];
        if (!(seen & BIT(c))) continue;
        let t = val[c];
        if (st.posRel) {
            if (!(st.known & (1 << a))) return fail(st, "relative move from unknown position");
            t = pos[a] + t;
        }
        if (t < lo[a] || t > hi[a]) return fail(st, "outside envelope");
        pos[a] = t;
        st.known |= 1 << a;
    }

    if (arc) {
        if (!(seen & (BIT(0x49) | BIT(0x4a)))) return fail(st, "arc without centre");
        if (!startXYKnown) return fail(st, "arc from unknown position");
        const I = BigInt((seen & BIT(0x49)) ? val[0x49] : 0);
        const J = BigInt((seen & BIT(0x4a)) ? val[0x4a] : 0);
        const cx = BigInt(sx) + I, cy = BigInt(sy) + J;
        const r2 = I * I + J * J;
        // Start and end relative to the centre; G2 (clockwise) from u to v is G3 from v to u.
        let u = [-I, -J], v = [BigInt(pos[0]) - cx, BigInt(pos[1]) - cy];
        if (code === 2) [u, v] = [v, u];
        const full = (seen & BIT(0x50)) !== 0 && val[0x50] !== 0;
        // Axis extremes in the order +x, -x, +y, -y, with the room the envelope leaves there.
        const extremes = [
            [[1n, 0n], BigInt(profile.xMax) - cx], [[-1n, 0n], cx - BigInt(profile.xMin)],
            [[0n, 1n], BigInt(profile.yMax) - cy], [[0n, -1n], cy - BigInt(profile.yMin)],
        ];
        for (const [d, room] of extremes) {
            if (!(full || ccwSweeps(u, v, d))) continue;
            if (room < 0n || room * room < r2) return fail(st, "arc outside envelope");
        }
    }

    let extruding = false;
    if (seen & BIT(0x45)) {
        const e = val[0x45];
        const delta = st.eRel ? e : e - st.eDatum;
        if (!st.eRel) st.eDatum = e;
        extruding = delta > 0;
    }
    if (extruding) {
        if (!startZKnown || !(st.known & 4)) return fail(st, "extrusion at unknown Z");
        if (startZ > decl.hMax || pos[2] > decl.hMax) return fail(st, "extrusion above declared height");
        st.extruded = true;
        if (st.maxExtrudeZ === null || pos[2] > st.maxExtrudeZ) st.maxExtrudeZ = pos[2];
        if (st.nozzleSetpoint < decl.nozzleMin) st.coldExtrusions++;
    }
    [st.x, st.y, st.z] = pos;
}

function finalize(decl, st) {
    if (st.violation) return { valid: false, reason: st.violation.reason, line: st.violation.line };
    if (!st.extruded) return { valid: false, reason: "no extrusion" };
    if (st.peakNozzle < decl.nozzleMin || st.peakNozzle > decl.nozzleMax) return { valid: false, reason: "nozzle window" };
    if (st.peakBed < decl.bedMin || st.peakBed > decl.bedMax) return { valid: false, reason: "bed window" };
    return { valid: true };
}

/** Evaluate the predicate on a whole buffer (lines split on '\n', last line may be unterminated). */
function conformance(buf, profile, decl) {
    const st = newState();
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0a) { processLine(buf, start, i, profile, decl, st); start = i + 1; }
    }
    if (start < buf.length) processLine(buf, start, buf.length, profile, decl, st);
    return { ...finalize(decl, st), state: st };
}

// The machine profile of the corpus: Original Prusa XL single-tool (bed_shape 0x0-360x360,
// max_print_height 360), with Y extended to -10 mm for the purge line that the stock start
// G-code draws at Y = -8. Commands: those the stock XL start/end G-code and the three slicers
// emit for it.
const PRUSA_XL = {
    x: [0, 360], y: [-10, 360], z: [0, 360],
    commands: [
        "G0", "G1", "G2", "G3", "G17", "G21", "G28", "G29", "G90", "G91", "G92",
        "M17", "M73", "M82", "M83", "M84", "M104", "M105", "M106", "M107", "M109", "M140",
        "M142", "M190", "M201", "M203", "M204", "M205", "M221", "M302", "M555", "M862.1", "M900",
    ],
    freeText: ["M115", "M486", "M862.3"],
};

module.exports = {
    SCALE, commandKey, parseCommandName, machineProfile, declaration, conformance,
    newState, processLine, finalize, PRUSA_XL,
};
