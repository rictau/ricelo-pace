#!/usr/bin/env node
/**
 * Standalone, zero-Firestore, zero-dependency US calibration & validation
 * reproduction CLI for the Ricelo-Pace Model (closed-form path-consistent
 * integral + Ricelo-Pace v1).
 *
 * Reproduces:
 *   1. Vickers & Vertosick (2016) Model 1 float32 parity check
 *   2. Ricelo-Pace joint 3-parameter Huber fit (path-consistent integral,
 *      no 110 km/wk upper cap, no dead 0.16 upper clip) across Full Raw,
 *      groups 1+2 raw/adj, Full Adj, runner-weighted check, and 5-fold
 *      runner-level CV
 *   3. Held-out `group == 3` & 5-fold CV benchmarks on FM, HM, zero-shot 10K,
 *      and quantitative downward conversion (FM -> HM, N = 717)
 *   4. Critical ablations:
 *      - Clamped V&V Model 1 (`max(T_VV, T_Riegel106)`)
 *      - Ricelo-Pace v1 (`D* = max(D1, D2)`, `V <= 110 km/wk`) vs. Ricelo-Pace
 *      - US FM error stratified by basis distance (HM, 10mi/10K, 5mi/5K)
 *      - US FM error stratified by weekly mileage tier (including >110 km/wk)
 *        and finish-time regime (<3:15, 3:15-4:15, >4:15)
 *      - Huber delta sensitivity (`0.02, 0.035, 0.05, 0.10, Inf`)
 *      - Monotonicity audit on FM cohort and all valid survey runners
 *      - Runner D (FM 4:54:17, V = 38.2 km/wk) transitivity check
 *
 * Uses Vickers & Vertosick's (2016) public-domain (CC0) Additional file 2:
 *   `13102_2016_52_MOESM2_ESM.xlsx`
 *   (BMC Sports Sci Med Rehabil 8:26, doi:10.1186/s13102-016-0052-y;
 *    Figshare article 4442066, MD5 1357a14b7a78f5cad3dc9108f148dc06).
 *
 * Zero external or repository dependencies beyond Node.js built-ins
 * (`fs`, `path`, `zlib`). Supports `.xlsx`, `.csv`, and `.json` inputs.
 *
 * Usage:
 *   node reproduceUsBenchmark.js --file=/path/to/13102_2016_52_MOESM2_ESM.xlsx
 *   node reproduceUsBenchmark.js --file=... --boot=10000
 *   node reproduceUsBenchmark.js --file=... --json
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const RIEGEL_STANDARD_EXPONENT = 1.06;
const KM_PER_MILE = 1.609344;
const BASE_METERS = 5000;
const MARATHON_METERS = 42195;
const HM_METERS = 21097.5;
const TENK_METERS = 10000;
const LN_FM_OVER_5K = Math.log(MARATHON_METERS / BASE_METERS);

const MIN_MILEAGE_KM = 10;
const LEGACY_MAX_MILEAGE_KM = 110;
const LEGACY_MAX_DELTA = 0.16;
const HUBER_DELTA = 0.035;

const DISTANCE_COLUMNS = Object.freeze([
    { key: 'k5', label: '5K', meters: 5000, rawCol: 'k5_ti', adjCol: 'k5_ti_adj', diffCol: 'k5_di' },
    { key: 'm5', label: '5mi', meters: 8045, rawCol: 'm5_ti', adjCol: 'm5_ti_adj', diffCol: 'm5_di' },
    { key: 'k10', label: '10K', meters: 10000, rawCol: 'k10_ti', adjCol: 'k10_ti_adj', diffCol: 'k10_di' },
    { key: 'm10', label: '10mi', meters: 16090, rawCol: 'm10_ti', adjCol: 'm10_ti_adj', diffCol: 'm10_di' },
    { key: 'mh', label: 'HM', meters: 21097.5, rawCol: 'mh_ti', adjCol: 'mh_ti_adj', diffCol: 'mh_di' },
    { key: 'mf', label: 'FM', meters: 42195, rawCol: 'mf_ti', adjCol: 'mf_ti_adj', diffCol: 'mf_di' },
]);

// ── Minimal zero-dependency XLSX / CSV / JSON reader ─────────────────────────

function decodeXmlEntities(str) {
    return String(str)
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, '\'')
        .replace(/&amp;/g, '&');
}

function readZipEntries(buffer) {
    let eocdOffset = -1;
    const minOffset = Math.max(0, buffer.length - 65557);
    for (let i = buffer.length - 22; i >= minOffset; i--) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }
    if (eocdOffset < 0) {
        throw new Error('Invalid ZIP/XLSX archive: End of Central Directory not found.');
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
    const entries = new Map();

    let ptr = cdOffset;
    for (let n = 0; n < totalEntries; n++) {
        if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
            throw new Error(`Invalid ZIP central directory signature at offset ${ptr}.`);
        }
        const method = buffer.readUInt16LE(ptr + 10);
        const compressedSize = buffer.readUInt32LE(ptr + 20);
        const nameLen = buffer.readUInt16LE(ptr + 28);
        const extraLen = buffer.readUInt16LE(ptr + 30);
        const commentLen = buffer.readUInt16LE(ptr + 32);
        const localHeaderOffset = buffer.readUInt32LE(ptr + 42);
        const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen);

        if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
            throw new Error(`Invalid ZIP local header for entry "${name}".`);
        }
        const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
        const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

        let content;
        if (method === 0) {
            content = Buffer.from(compressed);
        } else if (method === 8) {
            content = zlib.inflateRawSync(compressed);
        } else {
            throw new Error(`Unsupported ZIP compression method ${method} for "${name}".`);
        }
        entries.set(name, content);
        ptr += 46 + nameLen + extraLen + commentLen;
    }

    return entries;
}

function colLettersToIndex(letters) {
    let idx = 0;
    for (let i = 0; i < letters.length; i++) {
        idx = idx * 26 + (letters.charCodeAt(i) - 64);
    }
    return idx - 1;
}

function parseSharedStrings(xml) {
    const out = [];
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let siMatch;
    while ((siMatch = siRegex.exec(xml)) !== null) {
        const inner = siMatch[1];
        const parts = [];
        const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
        let tMatch;
        while ((tMatch = tRegex.exec(inner)) !== null) {
            parts.push(decodeXmlEntities(tMatch[1]));
        }
        out.push(parts.join(''));
    }
    return out;
}

function resolveFirstSheetPath(entries) {
    if (entries.has('xl/workbook.xml') && entries.has('xl/_rels/workbook.xml.rels')) {
        const wbXml = entries.get('xl/workbook.xml').toString('utf8');
        const relsXml = entries.get('xl/_rels/workbook.xml.rels').toString('utf8');
        const sheetMatch = wbXml.match(/<sheet\b[^>]*r:id="([^"]+)"/);
        if (sheetMatch) {
            const rid = sheetMatch[1];
            const relRegex = /<Relationship\b[^>]*>/g;
            let relMatch;
            while ((relMatch = relRegex.exec(relsXml)) !== null) {
                const tag = relMatch[0];
                const idM = tag.match(/\bId="([^"]+)"/);
                const targetM = tag.match(/\bTarget="([^"]+)"/);
                if (idM && idM[1] === rid && targetM) {
                    const target = targetM[1].replace(/^\/+/, '');
                    const candidate = target.startsWith('xl/') ? target : `xl/${target}`;
                    if (entries.has(candidate)) return candidate;
                }
            }
        }
    }
    if (entries.has('xl/worksheets/sheet1.xml')) return 'xl/worksheets/sheet1.xml';
    for (const key of entries.keys()) {
        if (/^xl\/worksheets\/sheet\d+\.xml$/i.test(key)) return key;
    }
    throw new Error('Could not locate worksheet XML inside XLSX archive.');
}

function parseXlsxBuffer(buffer) {
    const entries = readZipEntries(buffer);
    const sharedStrings = entries.has('xl/sharedStrings.xml')
        ? parseSharedStrings(entries.get('xl/sharedStrings.xml').toString('utf8'))
        : [];
    const sheetPath = resolveFirstSheetPath(entries);
    const sheetXml = entries.get(sheetPath).toString('utf8');

    const rawRows = [];
    const rowRegex = /<row\b[^>]*>([\s\S]*?)<\/row>/g;
    let rowMatch;
    while ((rowMatch = rowRegex.exec(sheetXml)) !== null) {
        const rowInner = rowMatch[1];
        const cells = [];
        const cellRegex = /<c\b([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g;
        let cellMatch;
        let fallbackCol = 0;
        while ((cellMatch = cellRegex.exec(rowInner)) !== null) {
            const attrs = cellMatch[1] || '';
            const body = cellMatch[2] || '';
            const refM = attrs.match(/\br="([A-Z]+)\d+"/);
            const colIdx = refM ? colLettersToIndex(refM[1]) : fallbackCol;
            fallbackCol = colIdx + 1;

            const typeM = attrs.match(/\bt="([^"]+)"/);
            const cellType = typeM ? typeM[1] : null;
            let val = null;

            if (cellType === 'inlineStr') {
                const parts = [];
                const tRegex = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
                let tMatch;
                while ((tMatch = tRegex.exec(body)) !== null) {
                    parts.push(decodeXmlEntities(tMatch[1]));
                }
                val = parts.join('');
            } else {
                const vM = body.match(/<v>([\s\S]*?)<\/v>/);
                if (vM) {
                    const rawV = vM[1];
                    if (cellType === 's') {
                        const idx = parseInt(rawV, 10);
                        val = Number.isFinite(idx) && idx >= 0 && idx < sharedStrings.length
                            ? sharedStrings[idx]
                            : null;
                    } else if (cellType === 'str') {
                        val = decodeXmlEntities(rawV);
                    } else if (cellType === 'b') {
                        val = rawV === '1' ? 1 : 0;
                    } else if (cellType === 'e') {
                        val = null;
                    } else {
                        const num = Number(rawV);
                        val = Number.isFinite(num) ? num : decodeXmlEntities(rawV);
                    }
                }
            }
            cells[colIdx] = val;
        }
        rawRows.push(cells);
    }

    if (rawRows.length < 2) return [];
    const headers = rawRows[0].map((h) => (h == null ? '' : String(h).trim()));
    const objects = [];
    for (let r = 1; r < rawRows.length; r++) {
        const rowCells = rawRows[r];
        if (!rowCells || rowCells.every((v) => v == null || v === '')) continue;
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            if (!headers[c]) continue;
            const v = rowCells[c];
            obj[headers[c]] = (v === '' || v === undefined) ? null : v;
        }
        objects.push(obj);
    }
    return objects;
}

function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inQuotes) {
            if (ch === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += ch;
            }
        } else if (ch === '"') {
            inQuotes = true;
        } else if (ch === ',') {
            row.push(field);
            field = '';
        } else if (ch === '\n' || ch === '\r') {
            if (ch === '\r' && text[i + 1] === '\n') i += 1;
            row.push(field);
            if (row.some((cell) => cell !== '')) rows.push(row);
            row = [];
            field = '';
        } else {
            field += ch;
        }
    }
    if (field !== '' || row.length > 0) {
        row.push(field);
        if (row.some((cell) => cell !== '')) rows.push(row);
    }
    if (rows.length < 2) return [];
    const headers = rows[0].map((h) => h.trim());
    return rows.slice(1).map((vals) => {
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            const raw = (vals[c] ?? '').trim();
            if (raw === '' || raw.toUpperCase() === 'NA' || raw.toLowerCase() === 'null') {
                obj[headers[c]] = null;
            } else {
                const num = Number(raw);
                obj[headers[c]] = Number.isFinite(num) ? num : raw;
            }
        }
        return obj;
    });
}

function loadWorkbookRows(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    }
    if (ext === '.csv') {
        return parseCsvText(fs.readFileSync(filePath, 'utf8'));
    }
    return parseXlsxBuffer(fs.readFileSync(filePath));
}

// ── Deterministic PRNG & statistical helpers ─────────────────────────────────

function createRng(seed = 20261124) {
    let a = seed >>> 0;
    return () => {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function quantile(sorted, q) {
    if (!sorted.length) return null;
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function huberLoss(residual, delta = HUBER_DELTA) {
    const a = Math.abs(residual);
    if (!Number.isFinite(delta)) return 0.5 * a * a;
    return a <= delta ? 0.5 * a * a : delta * (a - 0.5 * delta);
}

function formatClock(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds <= 0) return '-';
    const s = Math.round(totalSeconds);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const two = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

// ── Core distance physics & competitor equations ─────────────────────────────

function distUnit(meters) {
    if (!(meters > BASE_METERS)) return 0;
    return Math.max(0, Math.min(1, Math.log(meters / BASE_METERS) / LN_FM_OVER_5K));
}

/**
 * Smooth C^1 cumulative excess-exponent integral Psi(D; gamma) = int_{ln 5K}^{ln D} u(s)^gamma d(ln s):
 *   - D <= 5K:      0 (pure Riegel 1.06 below 5K)
 *   - 5K < D < FM:  L * u(D)^(gamma + 1) / (gamma + 1)
 *   - D >= FM:      L / (gamma + 1) + ln(D / FM)
 *
 * For D1, D2 in [5K, FM], (Psi(D2) - Psi(D1)) / ln(D2 / D1) reduces identically to
 * (u2^(gamma + 1) - u1^(gamma + 1)) / ((gamma + 1) * (u2 - u1)).
 */
function cumulativeExcessIntegral(meters, gamma) {
    if (!(meters > BASE_METERS)) return 0;
    if (meters >= MARATHON_METERS) {
        return (LN_FM_OVER_5K / (gamma + 1)) + Math.log(meters / MARATHON_METERS);
    }
    const u = Math.log(meters / BASE_METERS) / LN_FM_OVER_5K;
    return LN_FM_OVER_5K * (Math.pow(u, gamma + 1) / (gamma + 1));
}

function integralDistanceWeight(basisMeters, targetMeters, gamma) {
    if (!(basisMeters > 0) || !(targetMeters > 0)) return 0;
    const lnRatio = Math.log(targetMeters / basisMeters);
    if (Math.abs(lnRatio) < 1e-12) {
        const u = distUnit(basisMeters);
        return u <= 0 ? 0 : Math.pow(u, gamma);
    }
    return (cumulativeExcessIntegral(targetMeters, gamma) - cumulativeExcessIntegral(basisMeters, gamma)) / lnRatio;
}

/**
 * Ricelo-Pace v2.2 marginal durability penalty at FM endpoint (no 110 km/wk cap,
 * no dead 0.16 upper clip). Lower mileage floor V >= 10 km/wk prevents ln(0)
 * singularity; lower penalty floor 0 activates naturally at V* = exp(b0 / b1).
 */
function computeDeltaMarV22(volKm, b0, b1, { minMileageKm = MIN_MILEAGE_KM } = {}) {
    const effV = Math.max(minMileageKm, volKm);
    return Math.max(0, b0 - b1 * Math.log(effV));
}

/**
 * Ricelo-Pace v2.2 closed-form path-consistent integral exponent.
 * Guarantees for ALL D1, D2, D3 > 0 and all V >= 0:
 *   - Physical lower bound: x_int >= 1.06
 *   - Exact bidirectionality: x_int(V, D1, D2) == x_int(V, D2, D1)
 *   - Exact multi-step transitivity: (D1 -> D2 -> D3) == (D1 -> D3)
 *   - Natural elite 1.06 crossover at V* = exp(b0 / b1)
 */
function predictIntegralExponentV22({ volKm, basisMeters, targetMeters, b0, b1, gamma }) {
    if (!(basisMeters > 0) || !(targetMeters > 0)) return RIEGEL_STANDARD_EXPONENT;
    const w = integralDistanceWeight(basisMeters, targetMeters, gamma);
    return RIEGEL_STANDARD_EXPONENT + w * computeDeltaMarV22(volKm, b0, b1);
}

// Legacy v2.1 endpoint helpers kept solely for v2.1 vs. v2.2 ablation comparison.
function clampLegacyMileage(volKm) {
    return Math.max(MIN_MILEAGE_KM, Math.min(LEGACY_MAX_MILEAGE_KM, volKm));
}

function computeLegacyDeltaFm(volKm, b0, b1) {
    const raw = b0 - b1 * Math.log(clampLegacyMileage(volKm));
    return Math.max(0, Math.min(LEGACY_MAX_DELTA, raw));
}

function predictEndpointExponent({ volKm, basisMeters, targetMeters, b0, b1, gamma }) {
    const hi = Math.max(basisMeters, targetMeters);
    const lo = Math.min(basisMeters, targetMeters);
    if (!(hi > lo * 1.05) || hi <= BASE_METERS) return RIEGEL_STANDARD_EXPONENT;
    const u = distUnit(hi);
    const w = u <= 0 ? 0 : Math.pow(u, gamma);
    return RIEGEL_STANDARD_EXPONENT + w * computeLegacyDeltaFm(volKm, b0, b1);
}

// Backwards-compatible alias kept for existing tests referencing predictIntegralExponent.
function predictIntegralExponent(args) {
    return predictIntegralExponentV22(args);
}

function predictTimeSeconds(basisSec, basisMeters, targetMeters, exponent) {
    return basisSec * Math.pow(targetMeters / basisMeters, exponent);
}

function predictVickersVertosickModel1Seconds({ basisSeconds, basisMeters, avgWeeklyKm, round = false }) {
    if (!(basisSeconds > 0) || !(basisMeters > 0) || basisMeters >= MARATHON_METERS) return null;
    const tRiegel107 = basisSeconds * Math.pow(MARATHON_METERS / basisMeters, 1.07);
    const v = MARATHON_METERS / tRiegel107;
    const effectiveKm = (Number.isFinite(avgWeeklyKm) && avgWeeklyKm >= 0) ? avgWeeklyKm : 45;
    const milesPerWeek = effectiveKm / KM_PER_MILE;
    const vAdj = 0.16018617 + 0.83076202 * v + 0.06423826 * (milesPerWeek / 10);
    if (!(vAdj > 0)) return null;
    const sec = MARATHON_METERS / vAdj;
    return round ? Math.round(sec) : sec;
}

/**
 * Critical ablation: Vickers & Vertosick (2016) Model 1 floored at Classic
 * Riegel 1.06 (`max(T_VV, T_Riegel106)`), separating monotonicity clamping from
 * the log-mileage power-law functional form.
 */
function predictClampedVickersVertosickSeconds({ basisSeconds, basisMeters, avgWeeklyKm, round = false }) {
    const vvSec = predictVickersVertosickModel1Seconds({ basisSeconds, basisMeters, avgWeeklyKm, round: false });
    if (vvSec == null) return null;
    const r106Sec = predictTimeSeconds(basisSeconds, basisMeters, MARATHON_METERS, RIEGEL_STANDARD_EXPONENT);
    const clamped = Math.max(vvSec, r106Sec);
    return round ? Math.round(clamped) : clamped;
}

// ── Ricelo-Pace v2.2 Joint 3-Parameter Huber Optimizer ─────────────────────────

/**
 * Given fixed gamma, solve the 2-parameter Huber regression for (b0, b1):
 *   min sum_i weight_i * huber_delta(W_i(gamma) * max(0, b0 - b1 * ln(max(10, V_i))) - y_i)
 * where W_i(gamma) = Psi(D2_i; gamma) - Psi(D1_i; gamma) and
 *       y_i = ln(T2_i / T1_i) - 1.06 * ln(D2_i / D1_i).
 */
function fitDeltaMarGivenGamma(
    pairs,
    gamma,
    {
        delta = HUBER_DELTA,
        initB0 = 0.35,
        initB1 = 0.065,
        maxIter = 60,
        refinePattern = false,
        pairWeights = null,
    } = {},
) {
    const n = pairs.length;
    if (!n) return { b0: 0.35, b1: 0.065, loss: 0 };

    const W = new Float64Array(n);
    const lnV = new Float64Array(n);
    const y = new Float64Array(n);
    const pw = new Float64Array(n);

    for (let i = 0; i < n; i++) {
        const p = pairs[i];
        W[i] = cumulativeExcessIntegral(p.targetMeters, gamma) - cumulativeExcessIntegral(p.basisMeters, gamma);
        lnV[i] = Math.log(Math.max(MIN_MILEAGE_KM, p.avgWeeklyKm));
        y[i] = p.r * (p.empiricalExp - RIEGEL_STANDARD_EXPONENT);
        pw[i] = pairWeights ? pairWeights[i] : 1;
    }

    const lossOf = (b0, b1) => {
        let sum = 0;
        for (let i = 0; i < n; i++) {
            const d = b0 - b1 * lnV[i];
            const predDelta = d > 0 ? d : 0;
            sum += pw[i] * huberLoss(W[i] * predDelta - y[i], delta);
        }
        return sum;
    };

    let b0 = initB0;
    let b1 = initB1;
    for (let iter = 0; iter < maxIter; iter++) {
        let s00 = 0;
        let s01 = 0;
        let s11 = 0;
        let rhs0 = 0;
        let rhs1 = 0;
        for (let i = 0; i < n; i++) {
            const wi = W[i];
            if (!(wi > 0)) continue;
            const raw = b0 - b1 * lnV[i];
            if (raw <= 0) continue;
            const res = wi * raw - y[i];
            const absRes = Math.abs(res);
            const hw = (!Number.isFinite(delta) || absRes <= delta) ? 1 : delta / absRes;
            const wt = pw[i] * hw;
            const x0 = wi;
            const x1 = -wi * lnV[i];
            s00 += wt * x0 * x0;
            s01 += wt * x0 * x1;
            s11 += wt * x1 * x1;
            rhs0 += wt * x0 * y[i];
            rhs1 += wt * x1 * y[i];
        }
        const det = s00 * s11 - s01 * s01;
        if (!(Math.abs(det) > 1e-14)) break;
        const nextB0 = Math.max(0, Math.min(1.5, (rhs0 * s11 - rhs1 * s01) / det));
        const nextB1 = Math.max(0, Math.min(0.4, (s00 * rhs1 - s01 * rhs0) / det));
        const diff = Math.max(Math.abs(nextB0 - b0), Math.abs(nextB1 - b1));
        b0 = nextB0;
        b1 = nextB1;
        if (diff < 1e-11) break;
    }

    let best = lossOf(b0, b1);
    if (refinePattern) {
        let step0 = 0.005;
        let step1 = 0.001;
        for (let iter = 0; iter < 120; iter++) {
            let moved = false;
            for (const [d0, d1] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
                const c0 = Math.max(0, Math.min(1.5, b0 + d0 * step0));
                const c1 = Math.max(0, Math.min(0.4, b1 + d1 * step1));
                const val = lossOf(c0, c1);
                if (val + 1e-14 < best) {
                    best = val;
                    b0 = c0;
                    b1 = c1;
                    moved = true;
                }
            }
            if (!moved) {
                step0 *= 0.5;
                step1 *= 0.5;
                if (step0 < 1e-10 && step1 < 1e-10) break;
            }
        }
    }

    return { b0, b1, loss: best };
}

/**
 * Joint 3-parameter Huber fit for Ricelo-Pace v2.2 on combined US FM + HM pairs:
 *   min_{b0, b1, gamma} sum_{i in FM U HM} weight_i * huber_delta(ln(T_hat_i / T_i))
 *
 * Uses a 1D profile search over gamma in [minGamma, maxGamma] (exact IRLS for
 * (b0, b1) at every gamma), golden-section refinement, and a final 3D pattern
 * polish to verify global first-order optimality.
 */
function fitJointIntegralHuber(
    fmPairs,
    hmPairs,
    {
        delta = HUBER_DELTA,
        minGamma = 0.20,
        maxGamma = 10.0,
        runnerWeighted = false,
    } = {},
) {
    const allPairs = [...fmPairs, ...hmPairs];
    if (!allPairs.length) {
        return { b0: 0.35, b1: 0.065, gamma: 2.0, loss: 0, maxGrad: 0, weights: {} };
    }

    let pairWeights = null;
    if (runnerWeighted) {
        const countById = new Map();
        for (const p of allPairs) {
            countById.set(p.id, (countById.get(p.id) || 0) + 1);
        }
        pairWeights = allPairs.map((p) => 1 / countById.get(p.id));
    }

    // Build dense grid over gamma (finer near 0.2..4.0 where u^gamma varies fastest)
    const grid = [];
    for (let i = 0; i <= 38; i++) grid.push(minGamma + ((4.0 - minGamma) * i) / 38);
    for (let i = 1; i <= 20; i++) grid.push(4.0 + ((maxGamma - 4.0) * i) / 20);

    let bestIdx = 0;
    let bestFit = { b0: 0.35, b1: 0.065, loss: Infinity };
    let warmB0 = 0.35;
    let warmB1 = 0.065;

    for (let i = 0; i < grid.length; i++) {
        const fit = fitDeltaMarGivenGamma(allPairs, grid[i], {
            delta,
            initB0: warmB0,
            initB1: warmB1,
            maxIter: 40,
            pairWeights,
        });
        warmB0 = fit.b0;
        warmB1 = fit.b1;
        if (fit.loss < bestFit.loss) {
            bestFit = fit;
            bestIdx = i;
        }
    }

    let lo = bestIdx > 0 ? grid[bestIdx - 1] : minGamma;
    let hi = bestIdx < grid.length - 1 ? grid[bestIdx + 1] : maxGamma;
    const phi = (Math.sqrt(5) - 1) / 2;

    const evalGamma = (g) => fitDeltaMarGivenGamma(allPairs, g, {
        delta,
        initB0: bestFit.b0,
        initB1: bestFit.b1,
        maxIter: 60,
        refinePattern: true,
        pairWeights,
    });

    let c = hi - phi * (hi - lo);
    let d = lo + phi * (hi - lo);
    let fc = evalGamma(c);
    let fd = evalGamma(d);

    for (let iter = 0; iter < 55; iter++) {
        if (fc.loss < fd.loss) {
            hi = d;
            d = c;
            fd = fc;
            c = hi - phi * (hi - lo);
            fc = evalGamma(c);
        } else {
            lo = c;
            c = d;
            fc = fd;
            d = lo + phi * (hi - lo);
            fd = evalGamma(d);
        }
        if (hi - lo < 1e-6) break;
    }

    let gamma = (lo + hi) / 2;
    const final2D = evalGamma(gamma);
    let b0 = final2D.b0;
    let b1 = final2D.b1;

    // Final joint 3D loss & gradient check
    const totalLoss = (tb0, tb1, tg) => {
        let sum = 0;
        for (let i = 0; i < allPairs.length; i++) {
            const p = allPairs[i];
            const W = cumulativeExcessIntegral(p.targetMeters, tg) - cumulativeExcessIntegral(p.basisMeters, tg);
            const raw = tb0 - tb1 * Math.log(Math.max(MIN_MILEAGE_KM, p.avgWeeklyKm));
            const predDelta = raw > 0 ? raw : 0;
            const y = p.r * (p.empiricalExp - RIEGEL_STANDARD_EXPONENT);
            const pw = pairWeights ? pairWeights[i] : 1;
            sum += pw * huberLoss(W * predDelta - y, delta);
        }
        return sum;
    };

    let bestLoss = totalLoss(b0, b1, gamma);
    let s0 = 1e-3;
    let s1 = 2e-4;
    let sg = 5e-3;
    for (let iter = 0; iter < 90; iter++) {
        let moved = false;
        for (const [d0, d1, dg] of [
            [1, 0, 0], [-1, 0, 0],
            [0, 1, 0], [0, -1, 0],
            [0, 0, 1], [0, 0, -1],
            [1, 1, 0], [-1, -1, 0],
            [1, 0, 1], [-1, 0, -1],
            [0, 1, 1], [0, -1, -1],
            [1, 1, 1], [-1, -1, -1],
        ]) {
            const cb0 = Math.max(0, Math.min(1.5, b0 + d0 * s0));
            const cb1 = Math.max(0, Math.min(0.4, b1 + d1 * s1));
            const cg = Math.max(minGamma, Math.min(maxGamma, gamma + dg * sg));
            const v = totalLoss(cb0, cb1, cg);
            if (v + 1e-15 < bestLoss) {
                bestLoss = v;
                b0 = cb0;
                b1 = cb1;
                gamma = cg;
                moved = true;
            }
        }
        if (!moved) {
            s0 *= 0.5;
            s1 *= 0.5;
            sg *= 0.5;
            if (s0 < 1e-10 && s1 < 1e-10 && sg < 1e-9) break;
        }
    }

    const h = 1e-6;
    const b0Lo = Math.max(0, b0 - h);
    const b1Lo = Math.max(0, b1 - h);
    const gLo = Math.max(minGamma, gamma - h);
    const g0 = (totalLoss(b0 + h, b1, gamma) - totalLoss(b0Lo, b1, gamma)) / (b0 + h - b0Lo);
    const g1 = (totalLoss(b0, b1 + h, gamma) - totalLoss(b0, b1Lo, gamma)) / (b1 + h - b1Lo);
    const gg = (totalLoss(b0, b1, gamma + h) - totalLoss(b0, b1, gLo)) / (gamma + h - gLo);

    const impliedCrossoverKm = b1 > 1e-8 ? Math.exp(b0 / b1) : null;
    const deltaAt10 = computeDeltaMarV22(10, b0, b1);
    const wHmFm = integralDistanceWeight(HM_METERS, MARATHON_METERS, gamma);
    const w10kFm = integralDistanceWeight(TENK_METERS, MARATHON_METERS, gamma);
    const w5kFm = integralDistanceWeight(BASE_METERS, MARATHON_METERS, gamma);
    const w10kHm = integralDistanceWeight(TENK_METERS, HM_METERS, gamma);
    const w5kHm = integralDistanceWeight(BASE_METERS, HM_METERS, gamma);
    const w5k10k = integralDistanceWeight(BASE_METERS, TENK_METERS, gamma);

    return {
        b0,
        b1,
        gamma,
        loss: bestLoss,
        maxGrad: Math.max(Math.abs(g0), Math.abs(g1), Math.abs(gg)),
        impliedCrossoverKm,
        maxExpHmToFmAt10Km: RIEGEL_STANDARD_EXPONENT + wHmFm * deltaAt10,
        maxLocalExpAt10Km: RIEGEL_STANDARD_EXPONENT + deltaAt10,
        weights: {
            w5k10k,
            w5kHm,
            w10kHm,
            w5kFm,
            w10kFm,
            wHmFm,
        },
    };
}

/**
 * Unconstrained 2-parameter standalone HM baseline (`x_HM = 1.06 + max(0, b0 - b1 ln max(10, V))`)
 * to test whether sharing (b0, b1) across FM and HM sacrifices any HM accuracy.
 */
function fitDirectHmUncapped(hmPairs, { delta = HUBER_DELTA } = {}) {
    const n = hmPairs.length;
    if (!n) return { b0: 0.09, b1: 0.019 };
    const rArr = new Float64Array(n);
    const lnV = new Float64Array(n);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        rArr[i] = hmPairs[i].r;
        lnV[i] = Math.log(Math.max(MIN_MILEAGE_KM, hmPairs[i].avgWeeklyKm));
        y[i] = hmPairs[i].r * (hmPairs[i].empiricalExp - RIEGEL_STANDARD_EXPONENT);
    }
    let b0 = 0.09;
    let b1 = 0.019;
    for (let iter = 0; iter < 80; iter++) {
        let s00 = 0;
        let s01 = 0;
        let s11 = 0;
        let rhs0 = 0;
        let rhs1 = 0;
        for (let i = 0; i < n; i++) {
            const raw = b0 - b1 * lnV[i];
            if (raw <= 0) continue;
            const res = rArr[i] * raw - y[i];
            const absRes = Math.abs(res);
            const w = (!Number.isFinite(delta) || absRes <= delta) ? 1 : delta / absRes;
            const x0 = rArr[i];
            const x1 = -rArr[i] * lnV[i];
            s00 += w * x0 * x0;
            s01 += w * x0 * x1;
            s11 += w * x1 * x1;
            rhs0 += w * x0 * y[i];
            rhs1 += w * x1 * y[i];
        }
        const det = s00 * s11 - s01 * s01;
        if (!(Math.abs(det) > 1e-14)) break;
        const nextB0 = Math.max(0, Math.min(0.5, (rhs0 * s11 - rhs1 * s01) / det));
        const nextB1 = Math.max(0, Math.min(0.18, (s00 * rhs1 - s01 * rhs0) / det));
        const diff = Math.max(Math.abs(nextB0 - b0), Math.abs(nextB1 - b1));
        b0 = nextB0;
        b1 = nextB1;
        if (diff < 1e-11) break;
    }
    return { b0, b1 };
}

// ── Legacy v2.1 Two-Stage Optimizer (kept for v2.1 vs. v2.2 ablation) ────────

function fitStage1FmIrls(fmPairs, { delta = HUBER_DELTA, maxIter = 200 } = {}) {
    if (!fmPairs.length) return { b0: 0.2457, b1: 0.0461, maxGrad: 0 };

    const obs = fmPairs.map((p) => ({
        r: p.r,
        lnV: Math.log(clampLegacyMileage(p.avgWeeklyKm)),
        y: p.r * (p.empiricalExp - RIEGEL_STANDARD_EXPONENT),
    }));

    const lossOf = (b0, b1) => {
        let sum = 0;
        for (const o of obs) {
            const predDelta = Math.max(0, Math.min(LEGACY_MAX_DELTA, b0 - b1 * o.lnV));
            sum += huberLoss(o.r * predDelta - o.y, delta);
        }
        return sum;
    };

    let b0 = 0.24;
    let b1 = 0.045;
    for (let iter = 0; iter < maxIter; iter++) {
        let s00 = 0;
        let s01 = 0;
        let s11 = 0;
        let rhs0 = 0;
        let rhs1 = 0;
        for (const o of obs) {
            const raw = b0 - b1 * o.lnV;
            const predDelta = Math.max(0, Math.min(LEGACY_MAX_DELTA, raw));
            const res = o.r * predDelta - o.y;
            const absRes = Math.abs(res);
            const w = (!Number.isFinite(delta) || absRes <= delta) ? 1 : delta / absRes;
            if (raw <= 0 || raw >= LEGACY_MAX_DELTA) continue;
            const x0 = o.r;
            const x1 = -o.r * o.lnV;
            s00 += w * x0 * x0;
            s01 += w * x0 * x1;
            s11 += w * x1 * x1;
            rhs0 += w * x0 * o.y;
            rhs1 += w * x1 * o.y;
        }
        const det = s00 * s11 - s01 * s01;
        if (!(Math.abs(det) > 1e-14)) break;
        const nextB0 = Math.max(0, Math.min(0.50, (rhs0 * s11 - rhs1 * s01) / det));
        const nextB1 = Math.max(0, Math.min(0.18, (s00 * rhs1 - s01 * rhs0) / det));
        const diff = Math.max(Math.abs(nextB0 - b0), Math.abs(nextB1 - b1));
        b0 = nextB0;
        b1 = nextB1;
        if (diff < 1e-12) break;
    }

    let best = lossOf(b0, b1);
    let step0 = 0.01;
    let step1 = 0.002;
    for (let iter = 0; iter < 120; iter++) {
        let moved = false;
        for (const [d0, d1] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
            const c0 = Math.max(0, Math.min(0.50, b0 + d0 * step0));
            const c1 = Math.max(0, Math.min(0.18, b1 + d1 * step1));
            const val = lossOf(c0, c1);
            if (val + 1e-14 < best) {
                best = val;
                b0 = c0;
                b1 = c1;
                moved = true;
            }
        }
        if (!moved) {
            step0 *= 0.5;
            step1 *= 0.5;
            if (step0 < 1e-10 && step1 < 1e-10) break;
        }
    }

    let g0 = 0;
    let g1 = 0;
    for (const o of obs) {
        const raw = b0 - b1 * o.lnV;
        if (raw <= 0 || raw >= LEGACY_MAX_DELTA) continue;
        const res = o.r * raw - o.y;
        const psi = (!Number.isFinite(delta) || Math.abs(res) <= delta) ? res : delta * Math.sign(res);
        g0 += psi * o.r;
        g1 += psi * (-o.r * o.lnV);
    }

    return {
        b0,
        b1,
        impliedCrossoverKm: b1 > 1e-8 ? Math.exp(b0 / b1) : null,
        maxGrad: Math.max(Math.abs(g0), Math.abs(g1)),
    };
}

function fitStage2Gamma(
    hmPairs,
    { b0, b1, delta = HUBER_DELTA, minGamma = 0.20, maxGamma = 10.0, ridgeLambda = 0, gammaPrior = 1.5 } = {},
) {
    if (!hmPairs.length) return { gamma: 3.384 };

    const lossOf = (gamma) => {
        let sum = 0;
        for (const p of hmPairs) {
            const predExp = predictEndpointExponent({
                volKm: p.avgWeeklyKm,
                basisMeters: p.basisMeters,
                targetMeters: p.targetMeters,
                b0,
                b1,
                gamma,
            });
            sum += huberLoss(p.r * (predExp - p.empiricalExp), delta);
        }
        if (ridgeLambda > 0) sum += ridgeLambda * ((gamma - gammaPrior) ** 2);
        return sum;
    };

    const gridN = 200;
    let bestG = minGamma;
    let bestVal = Infinity;
    for (let i = 0; i <= gridN; i++) {
        const g = minGamma + ((maxGamma - minGamma) * i) / gridN;
        const v = lossOf(g);
        if (v < bestVal) {
            bestVal = v;
            bestG = g;
        }
    }

    const gridStep = (maxGamma - minGamma) / gridN;
    let lo = Math.max(minGamma, bestG - gridStep);
    let hi = Math.min(maxGamma, bestG + gridStep);
    const phi = (Math.sqrt(5) - 1) / 2;
    let c = hi - phi * (hi - lo);
    let d = lo + phi * (hi - lo);
    let fc = lossOf(c);
    let fd = lossOf(d);

    for (let iter = 0; iter < 80; iter++) {
        if (fc < fd) {
            hi = d;
            d = c;
            fd = fc;
            c = hi - phi * (hi - lo);
            fc = lossOf(c);
        } else {
            lo = c;
            c = d;
            fc = fd;
            d = lo + phi * (hi - lo);
            fd = lossOf(d);
        }
        if (hi - lo < 1e-8) break;
    }

    const gamma = (lo + hi) / 2;
    return {
        gamma,
        wHm: Math.pow(distUnit(HM_METERS), gamma),
        w10k: Math.pow(distUnit(TENK_METERS), gamma),
    };
}

// ── Cohort extraction from V&V workbook rows ─────────────────────────────────

function toPositiveNumber(v) {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : null;
}

function extractTargetPairs(rows, targetKey, { adjusted = false, groupFilter = null } = {}) {
    const targetIdx = DISTANCE_COLUMNS.findIndex((d) => d.key === targetKey);
    if (targetIdx < 1) throw new Error(`Unsupported targetKey: ${targetKey}`);
    const target = DISTANCE_COLUMNS[targetIdx];
    const shorterCols = DISTANCE_COLUMNS.slice(0, targetIdx).reverse();

    const pairs = [];
    for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const group = row.group == null ? null : Number(row.group);
        if (groupFilter != null && !groupFilter(group)) continue;

        const typicalMiles = toPositiveNumber(row.typical);
        if (!typicalMiles) continue;

        const targetSec = toPositiveNumber(row[adjusted ? target.adjCol : target.rawCol]);
        if (!targetSec) continue;

        let basis = null;
        for (const col of shorterCols) {
            const sec = toPositiveNumber(row[adjusted ? col.adjCol : col.rawCol]);
            if (sec) {
                basis = { key: col.key, label: col.label, meters: col.meters, seconds: sec };
                break;
            }
        }
        if (!basis) continue;

        const r = Math.log(target.meters / basis.meters);
        const empiricalExp = Math.log(targetSec / basis.seconds) / r;
        const id = row.id != null ? String(row.id) : `row_${idx + 1}`;

        pairs.push({
            id,
            group,
            typicalMiles,
            avgWeeklyKm: typicalMiles * KM_PER_MILE,
            basisKey: basis.key,
            basisMeters: basis.meters,
            basisSeconds: basis.seconds,
            targetKey: target.key,
            targetMeters: target.meters,
            actualSeconds: targetSec,
            r,
            empiricalExp,
            model1TimeMin: toPositiveNumber(row.model1_time),
        });
    }
    return pairs;
}

/**
 * Extract downward FM -> HM pairs (all runners with both valid FM and HM times
 * plus weekly mileage) for quantitative bidirectional conversion validation.
 */
function extractDownwardFmToHmPairs(rows, { adjusted = false, groupFilter = null } = {}) {
    const fmCol = adjusted ? 'mf_ti_adj' : 'mf_ti';
    const hmCol = adjusted ? 'mh_ti_adj' : 'mh_ti';
    const pairs = [];
    for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const group = row.group == null ? null : Number(row.group);
        if (groupFilter != null && !groupFilter(group)) continue;
        const typicalMiles = toPositiveNumber(row.typical);
        if (!typicalMiles) continue;
        const fmSec = toPositiveNumber(row[fmCol]);
        const hmSec = toPositiveNumber(row[hmCol]);
        if (!fmSec || !hmSec) continue;

        const id = row.id != null ? String(row.id) : `row_${idx + 1}`;
        pairs.push({
            id,
            group,
            typicalMiles,
            avgWeeklyKm: typicalMiles * KM_PER_MILE,
            basisKey: 'mf',
            basisMeters: MARATHON_METERS,
            basisSeconds: fmSec,
            targetKey: 'mh',
            targetMeters: HM_METERS,
            actualSeconds: hmSec,
            r: Math.log(HM_METERS / MARATHON_METERS),
            empiricalExp: Math.log(hmSec / fmSec) / Math.log(HM_METERS / MARATHON_METERS),
        });
    }
    return pairs;
}

/**
 * Extract all valid survey runners with typical mileage and at least one
 * sub-marathon race (used for full-survey V&V monotonicity audit).
 */
function extractAllSubMarathonBasisForAudit(rows, { adjusted = false } = {}) {
    const shorterCols = DISTANCE_COLUMNS.slice(0, DISTANCE_COLUMNS.length - 1).reverse();
    const out = [];
    for (let idx = 0; idx < rows.length; idx++) {
        const row = rows[idx];
        const typicalMiles = toPositiveNumber(row.typical);
        if (!typicalMiles) continue;
        let basis = null;
        for (const col of shorterCols) {
            const sec = toPositiveNumber(row[adjusted ? col.adjCol : col.rawCol]);
            if (sec) {
                basis = { key: col.key, label: col.label, meters: col.meters, seconds: sec };
                break;
            }
        }
        if (!basis) continue;
        const r = Math.log(MARATHON_METERS / basis.meters);
        out.push({
            id: row.id != null ? String(row.id) : `row_${idx + 1}`,
            typicalMiles,
            avgWeeklyKm: typicalMiles * KM_PER_MILE,
            basisKey: basis.key,
            basisMeters: basis.meters,
            basisSeconds: basis.seconds,
            targetKey: 'mf',
            targetMeters: MARATHON_METERS,
            r,
        });
    }
    return out;
}

// ── Evaluation metrics, monotonicity check & paired bootstraps ───────────────

function summarizeErrors(errorsMin) {
    const n = errorsMin.length;
    if (!n) return null;
    const absSorted = errorsMin.map((e) => Math.abs(e)).sort((a, b) => a - b);
    const signedSorted = [...errorsMin].sort((a, b) => a - b);

    const mae = absSorted.reduce((s, v) => s + v, 0) / n;
    const medAe = quantile(absSorted, 0.5);
    const meanBias = errorsMin.reduce((s, v) => s + v, 0) / n;
    const medBias = quantile(signedSorted, 0.5);
    const p25 = quantile(signedSorted, 0.25);
    const p75 = quantile(signedSorted, 0.75);
    const vvMse = errorsMin.reduce((s, e) => s + e * e, 0) / n;
    const rmse = Math.sqrt(vvMse);
    const vvPenMse = errorsMin.reduce((s, e) => s + (e < 0 ? 2 : 1) * e * e, 0) / n;

    const pct = (fn) => (errorsMin.filter(fn).length / n) * 100;
    return {
        n,
        mae,
        medAe,
        rmse,
        meanBias,
        medBias,
        p25,
        p75,
        vvMse,
        vvPenMse,
        within5Pct: pct((e) => Math.abs(e) <= 5),
        within10Pct: pct((e) => Math.abs(e) <= 10),
        within15Pct: pct((e) => Math.abs(e) <= 15),
        fast10Pct: pct((e) => e <= -10),
        slow10Pct: pct((e) => e >= 10),
    };
}

function pairedBootstrap(errorsA, errorsB, { resamples = 10000, seed = 20261124 } = {}) {
    const n = errorsA.length;
    if (n === 0 || n !== errorsB.length || resamples <= 0) return null;

    const metricDiff = (a, b) => {
        const sA = summarizeErrors(a);
        const sB = summarizeErrors(b);
        return {
            mae: sA.mae - sB.mae,
            medAe: sA.medAe - sB.medAe,
            rmse: sA.rmse - sB.rmse,
            vvPenMse: sA.vvPenMse - sB.vvPenMse,
        };
    };

    const observed = metricDiff(errorsA, errorsB);
    const rng = createRng(seed);
    const dMae = new Array(resamples);
    const dMed = new Array(resamples);
    const dRmse = new Array(resamples);
    const dPen = new Array(resamples);
    const sampleA = new Array(n);
    const sampleB = new Array(n);

    for (let b = 0; b < resamples; b++) {
        for (let i = 0; i < n; i++) {
            const idx = Math.floor(rng() * n);
            sampleA[i] = errorsA[idx];
            sampleB[i] = errorsB[idx];
        }
        const d = metricDiff(sampleA, sampleB);
        dMae[b] = d.mae;
        dMed[b] = d.medAe;
        dRmse[b] = d.rmse;
        dPen[b] = d.vvPenMse;
    }

    const pack = (obs, arr) => {
        arr.sort((x, y) => x - y);
        const pLt0 = (arr.filter((v) => v < 0).length / arr.length) * 100;
        return {
            diff: obs,
            ciLow: quantile(arr, 0.025),
            ciHigh: quantile(arr, 0.975),
            pLessThanZero: pLt0,
        };
    };

    return {
        mae: pack(observed.mae, dMae),
        medAe: pack(observed.medAe, dMed),
        rmse: pack(observed.rmse, dRmse),
        vvPenMse: pack(observed.vvPenMse, dPen),
    };
}

/**
 * Athlete-clustered paired bootstrap for cohorts with repeat racers.
 * `records` is an array of `{ clusterId, errA, errB }`.
 */
function clusteredPairedBootstrap(records, { resamples = 10000, seed = 20261124 } = {}) {
    if (!records || !records.length || resamples <= 0) return null;
    const byCluster = new Map();
    for (const r of records) {
        const k = String(r.clusterId);
        if (!byCluster.has(k)) byCluster.set(k, []);
        byCluster.get(k).push(r);
    }
    const clusters = [...byCluster.values()];
    const cCount = clusters.length;

    const metricDiff = (a, b) => {
        const sA = summarizeErrors(a);
        const sB = summarizeErrors(b);
        return {
            mae: sA.mae - sB.mae,
            medAe: sA.medAe - sB.medAe,
            rmse: sA.rmse - sB.rmse,
            vvPenMse: sA.vvPenMse - sB.vvPenMse,
        };
    };

    const obsA = records.map((r) => r.errA);
    const obsB = records.map((r) => r.errB);
    const observed = metricDiff(obsA, obsB);

    const rng = createRng(seed);
    const dMae = new Array(resamples);
    const dMed = new Array(resamples);
    const dRmse = new Array(resamples);
    const dPen = new Array(resamples);

    for (let b = 0; b < resamples; b++) {
        const sampleA = [];
        const sampleB = [];
        for (let i = 0; i < cCount; i++) {
            const cl = clusters[Math.floor(rng() * cCount)];
            for (let j = 0; j < cl.length; j++) {
                sampleA.push(cl[j].errA);
                sampleB.push(cl[j].errB);
            }
        }
        const d = metricDiff(sampleA, sampleB);
        dMae[b] = d.mae;
        dMed[b] = d.medAe;
        dRmse[b] = d.rmse;
        dPen[b] = d.vvPenMse;
    }

    const pack = (obs, arr) => {
        arr.sort((x, y) => x - y);
        const pLt0 = (arr.filter((v) => v < 0).length / arr.length) * 100;
        return {
            diff: obs,
            ciLow: quantile(arr, 0.025),
            ciHigh: quantile(arr, 0.975),
            pLessThanZero: pLt0,
        };
    };

    return {
        n: records.length,
        clusters: cCount,
        mae: pack(observed.mae, dMae),
        medAe: pack(observed.medAe, dMed),
        rmse: pack(observed.rmse, dRmse),
        vvPenMse: pack(observed.vvPenMse, dPen),
    };
}

function auditMonotonicity(pairs, predSecondsFn) {
    let sub106 = 0;
    let sub100 = 0;
    let sub106High55 = 0;
    let high55Count = 0;
    for (const p of pairs) {
        const predSec = predSecondsFn(p);
        if (!(predSec > 0)) continue;
        const impliedX = Math.log(predSec / p.basisSeconds) / p.r;
        const isHigh55 = p.typicalMiles >= 55;
        if (isHigh55) high55Count += 1;
        if (impliedX < RIEGEL_STANDARD_EXPONENT - 1e-9) {
            sub106 += 1;
            if (isHigh55) sub106High55 += 1;
        }
        if (impliedX < 1.0 - 1e-9) sub100 += 1;
    }
    return { n: pairs.length, sub106, sub100, high55Count, sub106High55 };
}

// ── End-to-end US Benchmark Runner ───────────────────────────────────────────

function assignRunnerFolds(ids, k = 5, seed = 20261124) {
    const unique = [...new Set(ids)].sort();
    const rng = createRng(seed);
    for (let i = unique.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = unique[i];
        unique[i] = unique[j];
        unique[j] = tmp;
    }
    const foldById = new Map();
    for (let i = 0; i < unique.length; i++) {
        foldById.set(unique[i], i % k);
    }
    return foldById;
}

function buildStratifiedSummary(pairs, errorMapsByModel, buckets) {
    const out = [];
    for (const bucket of buckets) {
        const idxs = [];
        for (let i = 0; i < pairs.length; i++) {
            if (bucket.predicate(pairs[i])) idxs.push(i);
        }
        if (!idxs.length) continue;
        const models = {};
        for (const [mKey, errs] of Object.entries(errorMapsByModel)) {
            models[mKey] = summarizeErrors(idxs.map((idx) => errs[idx]));
        }
        out.push({ label: bucket.label, n: idxs.length, models });
    }
    return out;
}

function runUsBenchmark(rows, { boot = 10000, seed = 20261124 } = {}) {
    const fmRawAll = extractTargetPairs(rows, 'mf', { adjusted: false });
    const hmRawAll = extractTargetPairs(rows, 'mh', { adjusted: false });
    const tenKRawAll = extractTargetPairs(rows, 'k10', { adjusted: false });
    const fmAdjAll = extractTargetPairs(rows, 'mf', { adjusted: true });
    const hmAdjAll = extractTargetPairs(rows, 'mh', { adjusted: true });

    const fmG12Raw = extractTargetPairs(rows, 'mf', { adjusted: false, groupFilter: (g) => g === 1 || g === 2 });
    const fmG3Raw = extractTargetPairs(rows, 'mf', { adjusted: false, groupFilter: (g) => g === 3 });
    const fmG12Adj = extractTargetPairs(rows, 'mf', { adjusted: true, groupFilter: (g) => g === 1 || g === 2 });
    const fmG3Adj = extractTargetPairs(rows, 'mf', { adjusted: true, groupFilter: (g) => g === 3 });

    const hmG12Raw = extractTargetPairs(rows, 'mh', { adjusted: false, groupFilter: (g) => g === 1 || g === 2 });
    const hmG3Raw = extractTargetPairs(rows, 'mh', { adjusted: false, groupFilter: (g) => g === 3 });
    const hmG12Adj = extractTargetPairs(rows, 'mh', { adjusted: true, groupFilter: (g) => g === 1 || g === 2 });
    const hmG3Adj = extractTargetPairs(rows, 'mh', { adjusted: true, groupFilter: (g) => g === 3 });

    const tenKG3Raw = extractTargetPairs(rows, 'k10', { adjusted: false, groupFilter: (g) => g === 3 });
    const tenKG3Adj = extractTargetPairs(rows, 'k10', { adjusted: true, groupFilter: (g) => g === 3 });

    const fmToHmRawAll = extractDownwardFmToHmPairs(rows, { adjusted: false });
    const fmToHmG3Raw = extractDownwardFmToHmPairs(rows, { adjusted: false, groupFilter: (g) => g === 3 });
    const fmToHmG3Adj = extractDownwardFmToHmPairs(rows, { adjusted: true, groupFilter: (g) => g === 3 });

    const allSubFmSurvey = extractAllSubMarathonBasisForAudit(rows, { adjusted: false });

    // 1. V&V Model 1 float32 formula parity check
    let parityCount = 0;
    let maxParityDiffMin = 0;
    for (const p of fmG3Adj) {
        if (p.model1TimeMin == null) continue;
        const predSec = predictVickersVertosickModel1Seconds({
            basisSeconds: p.basisSeconds,
            basisMeters: p.basisMeters,
            avgWeeklyKm: p.avgWeeklyKm,
            round: false,
        });
        if (predSec == null) continue;
        const diff = Math.abs(predSec / 60 - p.model1TimeMin);
        if (diff > maxParityDiffMin) maxParityDiffMin = diff;
        parityCount += 1;
    }

    // 2. Fit Ricelo-Pace v2.2 (Joint Path-Consistent Integral, uncapped V >= 10)
    const v22FullRaw = fitJointIntegralHuber(fmRawAll, hmRawAll);
    const v22FullRawRunnerWeighted = fitJointIntegralHuber(fmRawAll, hmRawAll, { runnerWeighted: true });
    const v22FullAdj = fitJointIntegralHuber(fmAdjAll, hmAdjAll);
    const v22G12Raw = fitJointIntegralHuber(fmG12Raw, hmG12Raw);
    const v22G12Adj = fitJointIntegralHuber(fmG12Adj, hmG12Adj);

    // 3. Fit Legacy Ricelo-Pace v2.1 (Endpoint + V <= 110 cap) for direct ablation
    const v21FullS1 = fitStage1FmIrls(fmRawAll);
    const v21FullS2 = fitStage2Gamma(hmRawAll, { b0: v21FullS1.b0, b1: v21FullS1.b1 });
    const v21G12RawS1 = fitStage1FmIrls(fmG12Raw);
    const v21G12RawS2 = fitStage2Gamma(hmG12Raw, { b0: v21G12RawS1.b0, b1: v21G12RawS1.b1 });
    const v21G12AdjS1 = fitStage1FmIrls(fmG12Adj);
    const v21G12AdjS2 = fitStage2Gamma(hmG12Adj, { b0: v21G12AdjS1.b0, b1: v21G12AdjS1.b1 });

    // Prediction closures
    const errFn = (pairs, predSecFn) => pairs.map((p) => (predSecFn(p) - p.actualSeconds) / 60);
    const r106Fn = (p) => predictTimeSeconds(p.basisSeconds, p.basisMeters, p.targetMeters, 1.06);
    const r107Fn = (p) => predictTimeSeconds(p.basisSeconds, p.basisMeters, p.targetMeters, 1.07);
    const vvFn = (p) => predictVickersVertosickModel1Seconds({
        basisSeconds: p.basisSeconds,
        basisMeters: p.basisMeters,
        avgWeeklyKm: p.avgWeeklyKm,
    });
    const vvClampedFn = (p) => predictClampedVickersVertosickSeconds({
        basisSeconds: p.basisSeconds,
        basisMeters: p.basisMeters,
        avgWeeklyKm: p.avgWeeklyKm,
    });
    const v21Fn = (b0, b1, gamma) => (p) => predictTimeSeconds(
        p.basisSeconds,
        p.basisMeters,
        p.targetMeters,
        predictEndpointExponent({
            volKm: p.avgWeeklyKm,
            basisMeters: p.basisMeters,
            targetMeters: p.targetMeters,
            b0,
            b1,
            gamma,
        }),
    );
    const v22Fn = (fit) => (p) => predictTimeSeconds(
        p.basisSeconds,
        p.basisMeters,
        p.targetMeters,
        predictIntegralExponentV22({
            volKm: p.avgWeeklyKm,
            basisMeters: p.basisMeters,
            targetMeters: p.targetMeters,
            b0: fit.b0,
            b1: fit.b1,
            gamma: fit.gamma,
        }),
    );

    const basisBuckets = [
        { label: 'HM -> FM', predicate: (p) => p.basisKey === 'mh' },
        { label: '10mi / 10K -> FM', predicate: (p) => p.basisKey === 'm10' || p.basisKey === 'k10' },
        { label: '  10mi -> FM', predicate: (p) => p.basisKey === 'm10' },
        { label: '  10K -> FM', predicate: (p) => p.basisKey === 'k10' },
        { label: '5mi / 5K -> FM', predicate: (p) => p.basisKey === 'm5' || p.basisKey === 'k5' },
        { label: '  5mi -> FM', predicate: (p) => p.basisKey === 'm5' },
        { label: '  5K -> FM', predicate: (p) => p.basisKey === 'k5' },
    ];

    const mileageBuckets = [
        { label: '<25 mi/wk (<40 km)', predicate: (p) => p.typicalMiles < 25 },
        { label: '25-39.9 mi/wk (40-64 km)', predicate: (p) => p.typicalMiles >= 25 && p.typicalMiles < 40 },
        { label: '40-54.9 mi/wk (64-88 km)', predicate: (p) => p.typicalMiles >= 40 && p.typicalMiles < 55 },
        { label: '55-68.3 mi/wk (88-110 km)', predicate: (p) => p.typicalMiles >= 55 && p.avgWeeklyKm <= 110 },
        { label: '>68.3 mi/wk (>110 km)', predicate: (p) => p.avgWeeklyKm > 110 },
    ];

    const speedBuckets = [
        { label: 'Fast (<3:15)', predicate: (p) => p.actualSeconds < 3 * 3600 + 15 * 60 },
        { label: 'Mid (3:15-4:15)', predicate: (p) => p.actualSeconds >= 3 * 3600 + 15 * 60 && p.actualSeconds <= 4 * 3600 + 15 * 60 },
        { label: 'Slower (>4:15)', predicate: (p) => p.actualSeconds > 4 * 3600 + 15 * 60 },
    ];

    const evaluateFmSplit = (pairs, v22Fit, v21S1, v21S2) => {
        const eR106 = errFn(pairs, r106Fn);
        const eR107 = errFn(pairs, r107Fn);
        const eVv = errFn(pairs, vvFn);
        const eVvClamped = errFn(pairs, vvClampedFn);
        const eV21 = errFn(pairs, v21Fn(v21S1.b0, v21S1.b1, v21S2.gamma));
        const eV22 = errFn(pairs, v22Fn(v22Fit));
        const errMap = {
            r106: eR106,
            r107: eR107,
            vvModel1: eVv,
            vvClamped: eVvClamped,
            riceloV21: eV21,
            riceloV22: eV22,
        };
        return {
            n: pairs.length,
            r106: summarizeErrors(eR106),
            r107: summarizeErrors(eR107),
            vvModel1: summarizeErrors(eVv),
            vvClamped: summarizeErrors(eVvClamped),
            riceloV21: summarizeErrors(eV21),
            riceloV22: summarizeErrors(eV22),
            bootV22VsR106: pairedBootstrap(eV22, eR106, { resamples: boot, seed }),
            bootV22VsVv: pairedBootstrap(eV22, eVv, { resamples: boot, seed: seed + 1 }),
            bootV22VsVvClamped: pairedBootstrap(eV22, eVvClamped, { resamples: boot, seed: seed + 2 }),
            bootV22VsV21: pairedBootstrap(eV22, eV21, { resamples: boot, seed: seed + 3 }),
            bootVvClampedVsVv: pairedBootstrap(eVvClamped, eVv, { resamples: boot, seed: seed + 4 }),
            byBasis: buildStratifiedSummary(pairs, errMap, basisBuckets),
            byMileage: buildStratifiedSummary(pairs, errMap, mileageBuckets),
            bySpeed: buildStratifiedSummary(pairs, errMap, speedBuckets),
        };
    };

    const directHmFn = (fit) => (p) => predictTimeSeconds(
        p.basisSeconds,
        p.basisMeters,
        p.targetMeters,
        RIEGEL_STANDARD_EXPONENT + computeDeltaMarV22(p.avgWeeklyKm, fit.b0, fit.b1),
    );

    const evaluateSubFmSplit = (pairs, v22Fit, v21S1, v21S2, { directHmTrainPairs = null } = {}) => {
        const eR106 = errFn(pairs, r106Fn);
        const eR107 = errFn(pairs, r107Fn);
        const eV21 = errFn(pairs, v21Fn(v21S1.b0, v21S1.b1, v21S2.gamma));
        const eV22 = errFn(pairs, v22Fn(v22Fit));
        const res = {
            n: pairs.length,
            r106: summarizeErrors(eR106),
            r107: summarizeErrors(eR107),
            riceloV21: summarizeErrors(eV21),
            riceloV22: summarizeErrors(eV22),
            bootV22VsR106: pairedBootstrap(eV22, eR106, { resamples: boot, seed: seed + 10 }),
            bootV22VsR107: pairedBootstrap(eV22, eR107, { resamples: boot, seed: seed + 11 }),
            bootV22VsV21: pairedBootstrap(eV22, eV21, { resamples: boot, seed: seed + 12 }),
            byMileage: buildStratifiedSummary(
                pairs,
                { r106: eR106, r107: eR107, riceloV21: eV21, riceloV22: eV22 },
                mileageBuckets,
            ),
        };
        if (directHmTrainPairs && directHmTrainPairs.length) {
            const dFit = fitDirectHmUncapped(directHmTrainPairs);
            const eDirect = errFn(pairs, directHmFn(dFit));
            res.directHm2Param = summarizeErrors(eDirect);
            res.directHmFit = { b0: Number(dFit.b0.toFixed(4)), b1: Number(dFit.b1.toFixed(4)) };
            res.bootV22VsDirectHm = pairedBootstrap(eV22, eDirect, { resamples: boot, seed: seed + 13 });
        }
        return res;
    };

    // 4. Zero-leakage runner-level 5-fold CV across union(FM, HM)
    const unionIds = [...fmRawAll.map((p) => p.id), ...hmRawAll.map((p) => p.id)];
    const foldById = assignRunnerFolds(unionIds, 5, seed);
    const cvFoldParamsV22 = [];
    const cvFoldParamsV21 = [];

    const cvFmErrorsV22 = new Array(fmRawAll.length);
    const cvFmErrorsV21 = new Array(fmRawAll.length);
    const cvHmErrorsV22 = new Array(hmRawAll.length);
    const cvHmErrorsV21 = new Array(hmRawAll.length);
    const cvHmErrorsDirect = new Array(hmRawAll.length);
    const cvDownErrorsV22 = new Array(fmToHmRawAll.length);
    const cvDownErrorsV21 = new Array(fmToHmRawAll.length);

    for (let f = 0; f < 5; f++) {
        const trainFm = fmRawAll.filter((p) => foldById.get(p.id) !== f);
        const trainHm = hmRawAll.filter((p) => foldById.get(p.id) !== f);

        const fit22 = fitJointIntegralHuber(trainFm, trainHm);
        cvFoldParamsV22.push({
            fold: f + 1,
            b0: fit22.b0,
            b1: fit22.b1,
            gamma: fit22.gamma,
            crossoverKm: fit22.impliedCrossoverKm,
            wHmFm: fit22.weights.wHmFm,
            w10kHm: fit22.weights.w10kHm,
            w5kFm: fit22.weights.w5kFm,
        });

        const s1 = fitStage1FmIrls(trainFm);
        const s2 = fitStage2Gamma(trainHm, { b0: s1.b0, b1: s1.b1 });
        cvFoldParamsV21.push({ fold: f + 1, b0: s1.b0, b1: s1.b1, gamma: s2.gamma });
        const dHmFit = fitDirectHmUncapped(trainHm);

        const pred22 = v22Fn(fit22);
        const pred21 = v21Fn(s1.b0, s1.b1, s2.gamma);
        const predDirect = directHmFn(dHmFit);

        for (let i = 0; i < fmRawAll.length; i++) {
            if (foldById.get(fmRawAll[i].id) !== f) continue;
            cvFmErrorsV22[i] = (pred22(fmRawAll[i]) - fmRawAll[i].actualSeconds) / 60;
            cvFmErrorsV21[i] = (pred21(fmRawAll[i]) - fmRawAll[i].actualSeconds) / 60;
        }
        for (let i = 0; i < hmRawAll.length; i++) {
            if (foldById.get(hmRawAll[i].id) !== f) continue;
            cvHmErrorsV22[i] = (pred22(hmRawAll[i]) - hmRawAll[i].actualSeconds) / 60;
            cvHmErrorsV21[i] = (pred21(hmRawAll[i]) - hmRawAll[i].actualSeconds) / 60;
            cvHmErrorsDirect[i] = (predDirect(hmRawAll[i]) - hmRawAll[i].actualSeconds) / 60;
        }
        for (let i = 0; i < fmToHmRawAll.length; i++) {
            if (foldById.get(fmToHmRawAll[i].id) !== f) continue;
            cvDownErrorsV22[i] = (pred22(fmToHmRawAll[i]) - fmToHmRawAll[i].actualSeconds) / 60;
            cvDownErrorsV21[i] = (pred21(fmToHmRawAll[i]) - fmToHmRawAll[i].actualSeconds) / 60;
        }
    }

    const fmAllR106 = errFn(fmRawAll, r106Fn);
    const fmAllR107 = errFn(fmRawAll, r107Fn);
    const fmAllVv = errFn(fmRawAll, vvFn);
    const fmAllVvClamped = errFn(fmRawAll, vvClampedFn);

    const hmAllR106 = errFn(hmRawAll, r106Fn);
    const hmAllR107 = errFn(hmRawAll, r107Fn);

    const downAllR106 = errFn(fmToHmRawAll, r106Fn);
    const downAllR107 = errFn(fmToHmRawAll, r107Fn);

    const cv5FoldScoreboards = {
        fm: {
            n: fmRawAll.length,
            r106: summarizeErrors(fmAllR106),
            r107: summarizeErrors(fmAllR107),
            vvModel1: summarizeErrors(fmAllVv),
            vvClamped: summarizeErrors(fmAllVvClamped),
            riceloV21: summarizeErrors(cvFmErrorsV21),
            riceloV22: summarizeErrors(cvFmErrorsV22),
            bootV22VsV21: pairedBootstrap(cvFmErrorsV22, cvFmErrorsV21, { resamples: boot, seed: seed + 20 }),
            byBasis: buildStratifiedSummary(
                fmRawAll,
                {
                    r106: fmAllR106,
                    vvModel1: fmAllVv,
                    vvClamped: fmAllVvClamped,
                    riceloV21: cvFmErrorsV21,
                    riceloV22: cvFmErrorsV22,
                },
                basisBuckets,
            ),
            byMileage: buildStratifiedSummary(
                fmRawAll,
                {
                    r106: fmAllR106,
                    vvModel1: fmAllVv,
                    vvClamped: fmAllVvClamped,
                    riceloV21: cvFmErrorsV21,
                    riceloV22: cvFmErrorsV22,
                },
                mileageBuckets,
            ),
            bySpeed: buildStratifiedSummary(
                fmRawAll,
                {
                    r106: fmAllR106,
                    vvModel1: fmAllVv,
                    vvClamped: fmAllVvClamped,
                    riceloV21: cvFmErrorsV21,
                    riceloV22: cvFmErrorsV22,
                },
                speedBuckets,
            ),
        },
        hm: {
            n: hmRawAll.length,
            r106: summarizeErrors(hmAllR106),
            r107: summarizeErrors(hmAllR107),
            riceloV21: summarizeErrors(cvHmErrorsV21),
            riceloV22: summarizeErrors(cvHmErrorsV22),
            directHm2Param: summarizeErrors(cvHmErrorsDirect),
            bootV22VsR106: pairedBootstrap(cvHmErrorsV22, hmAllR106, { resamples: boot, seed: seed + 21 }),
            bootV22VsR107: pairedBootstrap(cvHmErrorsV22, hmAllR107, { resamples: boot, seed: seed + 22 }),
            bootV22VsV21: pairedBootstrap(cvHmErrorsV22, cvHmErrorsV21, { resamples: boot, seed: seed + 23 }),
            bootV22VsDirectHm: pairedBootstrap(cvHmErrorsV22, cvHmErrorsDirect, { resamples: boot, seed: seed + 27 }),
        },
        downwardFmToHm: {
            n: fmToHmRawAll.length,
            r106: summarizeErrors(downAllR106),
            r107: summarizeErrors(downAllR107),
            riceloV21: summarizeErrors(cvDownErrorsV21),
            riceloV22: summarizeErrors(cvDownErrorsV22),
            bootV22VsR106: pairedBootstrap(cvDownErrorsV22, downAllR106, { resamples: boot, seed: seed + 24 }),
            bootV22VsR107: pairedBootstrap(cvDownErrorsV22, downAllR107, { resamples: boot, seed: seed + 25 }),
            bootV22VsV21: pairedBootstrap(cvDownErrorsV22, cvDownErrorsV21, { resamples: boot, seed: seed + 26 }),
            byMileage: buildStratifiedSummary(
                fmToHmRawAll,
                {
                    r106: downAllR106,
                    r107: downAllR107,
                    riceloV21: cvDownErrorsV21,
                    riceloV22: cvDownErrorsV22,
                },
                mileageBuckets,
            ),
        },
    };

    // 5. Monotonicity audits (FM cohort N=1,022 & all valid survey runners)
    const monotonicityAudit = {
        fmCohort: {
            vvModel1: auditMonotonicity(fmRawAll, vvFn),
            vvClamped: auditMonotonicity(fmRawAll, vvClampedFn),
            riceloV22: auditMonotonicity(fmRawAll, v22Fn(v22FullRaw)),
        },
        allSurveyRunners: {
            vvModel1: auditMonotonicity(allSubFmSurvey, vvFn),
            vvClamped: auditMonotonicity(allSubFmSurvey, vvClampedFn),
            riceloV22: auditMonotonicity(allSubFmSurvey, v22Fn(v22FullRaw)),
        },
    };

    // 6. Huber delta sensitivity check on g1+g2 -> g3 adj
    const huberSensitivity = [0.020, 0.035, 0.050, 0.100, Infinity].map((delta) => {
        const fitAdj = fitJointIntegralHuber(fmG12Adj, hmG12Adj, { delta });
        const fmSum = summarizeErrors(errFn(fmG3Adj, v22Fn(fitAdj)));
        const hmSum = summarizeErrors(errFn(hmG3Adj, v22Fn(fitAdj)));
        return {
            delta: Number.isFinite(delta) ? delta : 'Inf (OLS)',
            b0: Number(fitAdj.b0.toFixed(4)),
            b1: Number(fitAdj.b1.toFixed(4)),
            gamma: Number(fitAdj.gamma.toFixed(4)),
            crossoverKm: Number((fitAdj.impliedCrossoverKm || 0).toFixed(1)),
            g3FmMae: fmSum ? Number(fmSum.mae.toFixed(2)) : null,
            g3FmPenMse: fmSum ? Number(fmSum.vvPenMse.toFixed(1)) : null,
            g3HmMae: hmSum ? Number(hmSum.mae.toFixed(2)) : null,
            g3HmPenMse: hmSum ? Number(hmSum.vvPenMse.toFixed(1)) : null,
        };
    });

    // 7. Runner D transitivity check (FM 4:54:17 = 17,657s, V = 38.2 km/wk)
    const runnerDFmSec = 4 * 3600 + 54 * 60 + 17;
    const runnerDVol = 38.2;
    const v21ExpFm = predictEndpointExponent({
        volKm: runnerDVol,
        basisMeters: MARATHON_METERS,
        targetMeters: HM_METERS,
        b0: v21FullS1.b0,
        b1: v21FullS1.b1,
        gamma: v21FullS2.gamma,
    });
    const v21HmFromFm = predictTimeSeconds(runnerDFmSec, MARATHON_METERS, HM_METERS, v21ExpFm);
    const v21_5kFromFm = predictTimeSeconds(runnerDFmSec, MARATHON_METERS, BASE_METERS, v21ExpFm);
    const v21Exp5kHm = predictEndpointExponent({
        volKm: runnerDVol,
        basisMeters: BASE_METERS,
        targetMeters: HM_METERS,
        b0: v21FullS1.b0,
        b1: v21FullS1.b1,
        gamma: v21FullS2.gamma,
    });
    const v21HmFrom5k = predictTimeSeconds(v21_5kFromFm, BASE_METERS, HM_METERS, v21Exp5kHm);

    const v22ExpFmHm = predictIntegralExponentV22({
        volKm: runnerDVol,
        basisMeters: MARATHON_METERS,
        targetMeters: HM_METERS,
        b0: v22FullRaw.b0,
        b1: v22FullRaw.b1,
        gamma: v22FullRaw.gamma,
    });
    const v22ExpFm10k = predictIntegralExponentV22({
        volKm: runnerDVol,
        basisMeters: MARATHON_METERS,
        targetMeters: TENK_METERS,
        b0: v22FullRaw.b0,
        b1: v22FullRaw.b1,
        gamma: v22FullRaw.gamma,
    });
    const v22ExpFm5k = predictIntegralExponentV22({
        volKm: runnerDVol,
        basisMeters: MARATHON_METERS,
        targetMeters: BASE_METERS,
        b0: v22FullRaw.b0,
        b1: v22FullRaw.b1,
        gamma: v22FullRaw.gamma,
    });
    const v22Exp5kHm = predictIntegralExponentV22({
        volKm: runnerDVol,
        basisMeters: BASE_METERS,
        targetMeters: HM_METERS,
        b0: v22FullRaw.b0,
        b1: v22FullRaw.b1,
        gamma: v22FullRaw.gamma,
    });
    const v22HmFromFm = predictTimeSeconds(runnerDFmSec, MARATHON_METERS, HM_METERS, v22ExpFmHm);
    const v22_10kFromFm = predictTimeSeconds(runnerDFmSec, MARATHON_METERS, TENK_METERS, v22ExpFm10k);
    const v22_5kFromFm = predictTimeSeconds(runnerDFmSec, MARATHON_METERS, BASE_METERS, v22ExpFm5k);
    const v22HmFrom5k = predictTimeSeconds(v22_5kFromFm, BASE_METERS, HM_METERS, v22Exp5kHm);

    const packFit = (fit) => ({
        b0: Number(fit.b0.toFixed(4)),
        b1: Number(fit.b1.toFixed(4)),
        gamma: Number(fit.gamma.toFixed(4)),
        impliedCrossoverKm: Number((fit.impliedCrossoverKm || 0).toFixed(1)),
        maxExpHmToFmAt10Km: Number(fit.maxExpHmToFmAt10Km.toFixed(4)),
        maxLocalExpAt10Km: Number(fit.maxLocalExpAt10Km.toFixed(4)),
        maxGrad: fit.maxGrad,
        weights: Object.fromEntries(
            Object.entries(fit.weights).map(([k, v]) => [k, Number(v.toFixed(4))]),
        ),
    });

    const meanSd = (arr) => {
        const m = arr.reduce((s, v) => s + v, 0) / arr.length;
        const sd = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
        return { mean: Number(m.toFixed(4)), sd: Number(sd.toFixed(4)) };
    };

    return {
        counts: {
            totalRows: rows.length,
            fmRawAll: fmRawAll.length,
            hmRawAll: hmRawAll.length,
            tenKRawAll: tenKRawAll.length,
            fmToHmRawAll: fmToHmRawAll.length,
            fmRawOver110Km: fmRawAll.filter((p) => p.avgWeeklyKm > 110).length,
            hmRawOver110Km: hmRawAll.filter((p) => p.avgWeeklyKm > 110).length,
            fmG3Raw: fmG3Raw.length,
            fmG3Adj: fmG3Adj.length,
            hmG3Raw: hmG3Raw.length,
            hmG3Adj: hmG3Adj.length,
            tenKG3Raw: tenKG3Raw.length,
            tenKG3Adj: tenKG3Adj.length,
            fmToHmG3Raw: fmToHmG3Raw.length,
            fmToHmG3Adj: fmToHmG3Adj.length,
            allSubFmSurvey: allSubFmSurvey.length,
        },
        vvParity: {
            n: parityCount,
            maxAbsDiffMin: maxParityDiffMin,
        },
        fittedParameters: {
            v22UsFullRaw: packFit(v22FullRaw),
            v22UsFullRawRunnerWeighted: packFit(v22FullRawRunnerWeighted),
            v22UsFullAdj: packFit(v22FullAdj),
            v22UsG12Raw: packFit(v22G12Raw),
            v22UsG12Adj: packFit(v22G12Adj),
            v22Cv5FoldSummary: {
                b0: meanSd(cvFoldParamsV22.map((f) => f.b0)),
                b1: meanSd(cvFoldParamsV22.map((f) => f.b1)),
                gamma: meanSd(cvFoldParamsV22.map((f) => f.gamma)),
                crossoverKm: meanSd(cvFoldParamsV22.map((f) => f.crossoverKm || 0)),
                wHmFm: meanSd(cvFoldParamsV22.map((f) => f.wHmFm)),
            },
            v22Cv5Fold: cvFoldParamsV22,
            v21UsFullRaw: {
                b0: Number(v21FullS1.b0.toFixed(4)),
                b1: Number(v21FullS1.b1.toFixed(4)),
                gamma: Number(v21FullS2.gamma.toFixed(4)),
            },
            v21UsG12Raw: {
                b0: Number(v21G12RawS1.b0.toFixed(4)),
                b1: Number(v21G12RawS1.b1.toFixed(4)),
                gamma: Number(v21G12RawS2.gamma.toFixed(4)),
            },
            v21UsG12Adj: {
                b0: Number(v21G12AdjS1.b0.toFixed(4)),
                b1: Number(v21G12AdjS1.b1.toFixed(4)),
                gamma: Number(v21G12AdjS2.gamma.toFixed(4)),
            },
            v21Cv5Fold: cvFoldParamsV21,
        },
        heldOutG3: {
            fmAdj: evaluateFmSplit(fmG3Adj, v22G12Adj, v21G12AdjS1, v21G12AdjS2),
            fmRaw: evaluateFmSplit(fmG3Raw, v22G12Raw, v21G12RawS1, v21G12RawS2),
            hmAdj: evaluateSubFmSplit(hmG3Adj, v22G12Adj, v21G12AdjS1, v21G12AdjS2, { directHmTrainPairs: hmG12Adj }),
            hmRaw: evaluateSubFmSplit(hmG3Raw, v22G12Raw, v21G12RawS1, v21G12RawS2, { directHmTrainPairs: hmG12Raw }),
            tenKRaw: evaluateSubFmSplit(tenKG3Raw, v22G12Raw, v21G12RawS1, v21G12RawS2),
            tenKAdj: evaluateSubFmSplit(tenKG3Adj, v22G12Adj, v21G12AdjS1, v21G12AdjS2),
            downwardFmToHmRaw: evaluateSubFmSplit(fmToHmG3Raw, v22G12Raw, v21G12RawS1, v21G12RawS2),
            downwardFmToHmAdj: evaluateSubFmSplit(fmToHmG3Adj, v22G12Adj, v21G12AdjS1, v21G12AdjS2),
        },
        cv5FoldScoreboards,
        zeroShot10kAllRaw: {
            n: tenKRawAll.length,
            r106: summarizeErrors(errFn(tenKRawAll, r106Fn)),
            r107: summarizeErrors(errFn(tenKRawAll, r107Fn)),
            riceloV21: summarizeErrors(errFn(tenKRawAll, v21Fn(v21FullS1.b0, v21FullS1.b1, v21FullS2.gamma))),
            riceloV22: summarizeErrors(errFn(tenKRawAll, v22Fn(v22FullRaw))),
        },
        monotonicityAudit,
        huberSensitivity,
        runnerDTransitivityCheck: {
            input: { fmClock: '4:54:17', volKm: runnerDVol },
            v21Endpoint: {
                hmFromFm: formatClock(v21HmFromFm),
                fiveKFromFm: formatClock(v21_5kFromFm),
                hmFromFiveK: formatClock(v21HmFrom5k),
                contradictionSec: Number((v21HmFromFm - v21HmFrom5k).toFixed(2)),
            },
            v22Integral: {
                expFmHm: Number(v22ExpFmHm.toFixed(4)),
                expFm10k: Number(v22ExpFm10k.toFixed(4)),
                expFm5k: Number(v22ExpFm5k.toFixed(4)),
                hmFromFm: formatClock(v22HmFromFm),
                tenKFromFm: formatClock(v22_10kFromFm),
                fiveKFromFm: formatClock(v22_5kFromFm),
                hmFromFiveK: formatClock(v22HmFrom5k),
                contradictionSec: Number((v22HmFromFm - v22HmFrom5k).toFixed(6)),
            },
        },
        // Keep exact unrounded fits available programmatically for external scripts
        rawFits: {
            v22FullRaw,
            v22G12Raw,
            v22G12Adj,
            v21FullRaw: { b0: v21FullS1.b0, b1: v21FullS1.b1, gamma: v21FullS2.gamma },
            v21G12Raw: { b0: v21G12RawS1.b0, b1: v21G12RawS1.b1, gamma: v21G12RawS2.gamma },
            v21G12Adj: { b0: v21G12AdjS1.b0, b1: v21G12AdjS1.b1, gamma: v21G12AdjS2.gamma },
        },
    };
}

// ── Markdown CLI Formatting ──────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {
        file: null,
        boot: 10000,
        seed: 20261124,
        json: false,
    };
    for (const arg of argv) {
        if (arg.startsWith('--file=')) opts.file = arg.slice(7).trim();
        else if (arg.startsWith('--boot=')) opts.boot = Math.max(0, parseInt(arg.slice(7), 10) || 0);
        else if (arg.startsWith('--seed=')) opts.seed = parseInt(arg.slice(7), 10) || 20261124;
        else if (arg === '--json') opts.json = true;
    }
    return opts;
}

function fmtRow(label, s) {
    if (!s) return `| ${label} | - |`;
    return `| ${label} | ${s.n} | ${s.mae.toFixed(2)} | ${s.medAe.toFixed(2)} | ${s.rmse.toFixed(2)} | ${s.meanBias >= 0 ? '+' : ''}${s.meanBias.toFixed(2)} | ${s.medBias >= 0 ? '+' : ''}${s.medBias.toFixed(2)} | ${s.vvPenMse.toFixed(1)} | ${s.within5Pct.toFixed(1)}% | ${s.fast10Pct.toFixed(1)}% |`;
}

function fmtBoot(label, b) {
    if (!b) return null;
    const f = (x) => `${x.diff >= 0 ? '+' : ''}${x.diff.toFixed(2)} [${x.ciLow >= 0 ? '+' : ''}${x.ciLow.toFixed(2)}, ${x.ciHigh >= 0 ? '+' : ''}${x.ciHigh.toFixed(2)}] (P<0=${x.pLessThanZero.toFixed(1)}%)`;
    return `- **${label}:** MAE ${f(b.mae)} | MedAE ${f(b.medAe)} | PenMSE ${f(b.vvPenMse)}`;
}

function formatUsReportMarkdown(report) {
    const lines = [];
    const p = report.fittedParameters.v22UsFullRaw;
    const prw = report.fittedParameters.v22UsFullRawRunnerWeighted;
    const p12r = report.fittedParameters.v22UsG12Raw;
    const p12a = report.fittedParameters.v22UsG12Adj;
    const pfa = report.fittedParameters.v22UsFullAdj;
    const cv = report.fittedParameters.v22Cv5FoldSummary;

    lines.push('# Ricelo-Pace: US Calibration, Ablation & Bidirectional Validation Report');
    lines.push('');
    lines.push(`- Rows loaded: ${report.counts.totalRows} (FM raw N=${report.counts.fmRawAll} [${report.counts.fmRawOver110Km} >110 km/wk], HM raw N=${report.counts.hmRawAll} [${report.counts.hmRawOver110Km} >110 km/wk], 10K raw N=${report.counts.tenKRawAll}, FM->HM pairs N=${report.counts.fmToHmRawAll})`);
    if (report.vvParity.n > 0) {
        lines.push(`- V&V Model 1 float32 parity check (N=${report.vvParity.n}): max_abs_diff = ${report.vvParity.maxAbsDiffMin.toFixed(6)} min`);
    }
    lines.push('');
    lines.push('## 1. Ricelo-Pace Joint Integral Parameters (Uncapped V >= 10 km/wk)');
    lines.push('');
    lines.push('| Training Fit | b0 | b1 | gamma | Crossover (km/wk) | w(5K->10K) | w(10K->HM) | w(5K->HM) | w(HM->FM) | w(10K->FM) | w(5K->FM) | x_HM->FM(10k) | maxGrad |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const [label, f] of [
        ['**US Full Raw (Production)**', p],
        ['US Full Raw (Runner-Weighted Check)', prw],
        ['US groups 1+2 Raw', p12r],
        ['US groups 1+2 Adj (*_ti_adj)', p12a],
        ['US Full Adj (*_ti_adj)', pfa],
    ]) {
        lines.push(`| ${label} | ${f.b0} | ${f.b1} | ${f.gamma} | ${f.impliedCrossoverKm} | ${f.weights.w5k10k} | ${f.weights.w10kHm} | ${f.weights.w5kHm} | ${f.weights.wHmFm} | ${f.weights.w10kFm} | ${f.weights.w5kFm} | ${f.maxExpHmToFmAt10Km} | ${f.maxGrad.toExponential(1)} |`);
    }
    lines.push('');
    lines.push(`- **5-Fold Runner-Level CV mean +/- SD:** b0 = \`${cv.b0.mean} +/- ${cv.b0.sd}\`, b1 = \`${cv.b1.mean} +/- ${cv.b1.sd}\`, gamma = \`${cv.gamma.mean} +/- ${cv.gamma.sd}\`, crossover = \`${cv.crossoverKm.mean} +/- ${cv.crossoverKm.sd} km/wk\`, w(HM->FM) = \`${cv.wHmFm.mean} +/- ${cv.wHmFm.sd}\`.`);

    const hdr = '| Model | N | MAE | MedAE | RMSE | MeanBias | MedBias | PenMSE | +-5m | >=10m Fast |';
    const sep = '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|';

    lines.push('');
    lines.push('## 2. US Full Marathon Validation (Including Clamped V&V & Ricelo-Pace v1)');
    for (const [title, split] of [
        ['Held-Out g3 FM Adjusted (*_ti_adj)', report.heldOutG3.fmAdj],
        ['Held-Out g3 FM Raw (*_ti)', report.heldOutG3.fmRaw],
        ['Full Raw US FM (5-Fold Runner-Level CV)', report.cv5FoldScoreboards.fm],
    ]) {
        lines.push(`\n### ${title}\n${hdr}\n${sep}`);
        lines.push(fmtRow('Classic Riegel (1.06)', split.r106));
        lines.push(fmtRow('Riegel (1.07)', split.r107));
        lines.push(fmtRow('V&V (2016 Model 1)', split.vvModel1));
        lines.push(fmtRow('Clamped V&V (max with R1.06)', split.vvClamped));
        lines.push(fmtRow('Ricelo-Pace v1 (cap 110)', split.riceloV21));
        lines.push(fmtRow('**Ricelo-Pace (Integral, uncapped)**', split.riceloV22));
        for (const [bLabel, bVal] of [
            ['Ricelo-Pace - Riegel 1.06', split.bootV22VsR106],
            ['Ricelo-Pace - V&V Model 1', split.bootV22VsVv],
            ['Ricelo-Pace - Clamped V&V', split.bootV22VsVvClamped],
            ['Ricelo-Pace - Ricelo-Pace v1', split.bootV22VsV21],
            ['Clamped V&V - V&V Model 1', split.bootVvClampedVsVv],
        ]) {
            const line = fmtBoot(bLabel, bVal);
            if (line) lines.push(line);
        }
    }

    lines.push('');
    lines.push('### 2b. US FM Error Stratified by Basis Distance (Full Raw 5-Fold CV & Held-Out g3 Adj)');
    for (const [title, rowsByBasis] of [
        ['Full Raw 5-Fold CV (N=1,022)', report.cv5FoldScoreboards.fm.byBasis],
        ['Held-Out g3 Adj (N=310)', report.heldOutG3.fmAdj.byBasis],
    ]) {
        lines.push(`\n#### ${title}`);
        lines.push('| Basis Group | N | R1.06 MAE / PenMSE | V&V MAE / PenMSE | Clamped V&V MAE / PenMSE | Ricelo-Pace v1 MAE / PenMSE | **Ricelo-Pace MAE / PenMSE** | Endpoint -> Ricelo-Pace Bias |');
        lines.push('|---|---:|---:|---:|---:|---:|---:|---:|');
        for (const b of rowsByBasis) {
            const m = b.models;
            lines.push(`| ${b.label} | ${b.n} | ${m.r106.mae.toFixed(2)} / ${m.r106.vvPenMse.toFixed(1)} | ${m.vvModel1.mae.toFixed(2)} / ${m.vvModel1.vvPenMse.toFixed(1)} | ${m.vvClamped.mae.toFixed(2)} / ${m.vvClamped.vvPenMse.toFixed(1)} | ${m.riceloV21.mae.toFixed(2)} / ${m.riceloV21.vvPenMse.toFixed(1)} | **${m.riceloV22.mae.toFixed(2)} / ${m.riceloV22.vvPenMse.toFixed(1)}** | ${m.riceloV21.meanBias.toFixed(2)} -> ${m.riceloV22.meanBias.toFixed(2)} |`);
        }
    }

    lines.push('');
    lines.push('### 2c. US FM Error by Mileage Tier (Highlighting >110 km/wk Uncapped Gain) & Speed Regime (Full Raw 5-Fold CV)');
    lines.push('| Segment | N | V&V MAE / Bias | Clamped V&V MAE / Bias | Ricelo-Pace v1 (cap 110) MAE / Bias | **Ricelo-Pace (uncapped) MAE / Bias** | Endpoint -> Ricelo-Pace PenMSE |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|');
    for (const b of [...report.cv5FoldScoreboards.fm.byMileage, ...report.cv5FoldScoreboards.fm.bySpeed]) {
        const m = b.models;
        lines.push(`| ${b.label} | ${b.n} | ${m.vvModel1.mae.toFixed(2)} / ${m.vvModel1.medBias >= 0 ? '+' : ''}${m.vvModel1.medBias.toFixed(2)} | ${m.vvClamped.mae.toFixed(2)} / ${m.vvClamped.medBias >= 0 ? '+' : ''}${m.vvClamped.medBias.toFixed(2)} | ${m.riceloV21.mae.toFixed(2)} / ${m.riceloV21.medBias >= 0 ? '+' : ''}${m.riceloV21.medBias.toFixed(2)} | **${m.riceloV22.mae.toFixed(2)} / ${m.riceloV22.medBias >= 0 ? '+' : ''}${m.riceloV22.medBias.toFixed(2)}** | ${m.riceloV21.vvPenMse.toFixed(1)} -> ${m.riceloV22.vvPenMse.toFixed(1)} |`);
    }

    lines.push('');
    lines.push('## 3. US Half Marathon & Zero-Shot 10K Validation');
    for (const [title, split] of [
        ['Full Raw US HM (5-Fold Runner-Level CV)', report.cv5FoldScoreboards.hm],
        ['Held-Out g3 HM Raw (*_ti)', report.heldOutG3.hmRaw],
        ['Held-Out g3 HM Adjusted (*_ti_adj)', report.heldOutG3.hmAdj],
        ['Zero-Shot US 10K All Raw', report.zeroShot10kAllRaw],
        ['Zero-Shot Held-Out g3 10K Adjusted (*_ti_adj)', report.heldOutG3.tenKAdj],
    ]) {
        lines.push(`\n### ${title}\n${hdr}\n${sep}`);
        lines.push(fmtRow('Classic Riegel (1.06)', split.r106));
        lines.push(fmtRow('Riegel (1.07)', split.r107));
        lines.push(fmtRow('Ricelo-Pace v1', split.riceloV21));
        lines.push(fmtRow('**Ricelo-Pace (Integral)**', split.riceloV22));
        if (split.directHm2Param) {
            lines.push(fmtRow('*US Direct HM Refit (2-param uncapped)*', split.directHm2Param));
        }
        for (const [bLabel, bVal] of [
            ['Ricelo-Pace - Riegel 1.06', split.bootV22VsR106],
            ['Ricelo-Pace - Riegel 1.07', split.bootV22VsR107],
            ['Ricelo-Pace - Ricelo-Pace v1', split.bootV22VsV21],
            ['Ricelo-Pace - Direct HM 2-param', split.bootV22VsDirectHm],
        ]) {
            const line = fmtBoot(bLabel, bVal);
            if (line) lines.push(line);
        }
    }
    if (report.heldOutG3.hmAdj.byMileage.length) {
        lines.push('\n#### Held-Out g3 HM Adjusted by Mileage Tier (Figure 2 Data)');
        lines.push('| Mileage Tier | N | R1.06 MAE / MedBias | R1.07 MAE / MedBias | **Ricelo-Pace MAE / MedBias** |');
        lines.push('|---|---:|---:|---:|---:|');
        for (const b of report.heldOutG3.hmAdj.byMileage) {
            const m = b.models;
            lines.push(`| ${b.label} | ${b.n} | ${m.r106.mae.toFixed(2)} / ${m.r106.medBias >= 0 ? '+' : ''}${m.r106.medBias.toFixed(2)} | ${m.r107.mae.toFixed(2)} / ${m.r107.medBias >= 0 ? '+' : ''}${m.r107.medBias.toFixed(2)} | **${m.riceloV22.mae.toFixed(2)} / ${m.riceloV22.medBias >= 0 ? '+' : ''}${m.riceloV22.medBias.toFixed(2)}** |`);
        }
    }

    lines.push('');
    lines.push('## 4. Quantitative Downward Conversion Validation: FM -> HM');
    for (const [title, split] of [
        ['Full Raw US FM -> HM (5-Fold Runner-Level CV)', report.cv5FoldScoreboards.downwardFmToHm],
        ['Held-Out g3 FM -> HM Raw (*_ti)', report.heldOutG3.downwardFmToHmRaw],
        ['Held-Out g3 FM -> HM Adjusted (*_ti_adj)', report.heldOutG3.downwardFmToHmAdj],
    ]) {
        lines.push(`\n### ${title}\n${hdr}\n${sep}`);
        lines.push(fmtRow('Classic Riegel (1.06) Downward', split.r106));
        lines.push(fmtRow('Riegel (1.07) Downward', split.r107));
        lines.push(fmtRow('Ricelo-Pace v1 Downward', split.riceloV21));
        lines.push(fmtRow('**Ricelo-Pace (Integral) Downward**', split.riceloV22));
        for (const [bLabel, bVal] of [
            ['Ricelo-Pace - Riegel 1.06', split.bootV22VsR106],
            ['Ricelo-Pace - Riegel 1.07', split.bootV22VsR107],
            ['Ricelo-Pace - Ricelo-Pace v1', split.bootV22VsV21],
        ]) {
            const line = fmtBoot(bLabel, bVal);
            if (line) lines.push(line);
        }
    }
    lines.push('\n#### Downward FM -> HM by Mileage Tier (Full Raw 5-Fold CV)');
    lines.push('| Mileage Tier | N | R1.06 MAE / MeanBias | R1.07 MAE / MeanBias | **Ricelo-Pace MAE / MeanBias** |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const b of report.cv5FoldScoreboards.downwardFmToHm.byMileage) {
        const m = b.models;
        lines.push(`| ${b.label} | ${b.n} | ${m.r106.mae.toFixed(2)} / ${m.r106.meanBias >= 0 ? '+' : ''}${m.r106.meanBias.toFixed(2)} | ${m.r107.mae.toFixed(2)} / ${m.r107.meanBias >= 0 ? '+' : ''}${m.r107.meanBias.toFixed(2)} | **${m.riceloV22.mae.toFixed(2)} / ${m.riceloV22.meanBias >= 0 ? '+' : ''}${m.riceloV22.meanBias.toFixed(2)}** |`);
    }

    lines.push('');
    lines.push('## 5. Monotonicity Audit, Huber Delta Sensitivity & Runner D Transitivity');
    const mf = report.monotonicityAudit.fmCohort;
    const ms = report.monotonicityAudit.allSurveyRunners;
    lines.push(`- **FM Cohort (N=${mf.vvModel1.n}):** V&V sub-1.06=${mf.vvModel1.sub106} (${mf.vvModel1.sub106High55}/${mf.vvModel1.high55Count} at 55+ mi/wk), sub-1.00=${mf.vvModel1.sub100} | Clamped V&V sub-1.06=${mf.vvClamped.sub106} | Ricelo-Pace sub-1.06=${mf.riceloV22.sub106}`);
    lines.push(`- **All Valid Survey Runners (N=${ms.vvModel1.n}):** V&V sub-1.06=${ms.vvModel1.sub106}, sub-1.00=${ms.vvModel1.sub100} | Clamped V&V sub-1.06=${ms.vvClamped.sub106} | Ricelo-Pace sub-1.06=${ms.riceloV22.sub106}`);

    lines.push('\n#### Huber Delta Sensitivity (fit g1+g2 adj -> evaluate g3 adj)');
    lines.push('| Huber delta | b0 | b1 | gamma | Crossover (km/wk) | g3 FM MAE | g3 FM PenMSE | g3 HM MAE | g3 HM PenMSE |');
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const row of report.huberSensitivity) {
        lines.push(`| ${row.delta} | ${row.b0} | ${row.b1} | ${row.gamma} | ${row.crossoverKm} | ${row.g3FmMae} | ${row.g3FmPenMse} | ${row.g3HmMae} | ${row.g3HmPenMse} |`);
    }

    const rd = report.runnerDTransitivityCheck;
    lines.push('\n#### Runner D Case Study Transitivity Check (FM 4:54:17, V = 38.2 km/wk)');
    lines.push(`- **Ricelo-Pace v1:** FM -> HM \`${rd.v21Endpoint.hmFromFm}\`, FM -> 5K \`${rd.v21Endpoint.fiveKFromFm}\`, then 5K -> HM \`${rd.v21Endpoint.hmFromFiveK}\` (**contradiction: ${rd.v21Endpoint.contradictionSec}s**)`);
    lines.push(`- **Ricelo-Pace (Integral):** FM -> HM \`${rd.v22Integral.hmFromFm}\` (x=${rd.v22Integral.expFmHm}), FM -> 10K \`${rd.v22Integral.tenKFromFm}\` (x=${rd.v22Integral.expFm10k}), FM -> 5K \`${rd.v22Integral.fiveKFromFm}\` (x=${rd.v22Integral.expFm5k}), then 5K -> HM \`${rd.v22Integral.hmFromFiveK}\` (**contradiction: ${rd.v22Integral.contradictionSec}s**)`);
    lines.push('');

    return lines.join('\n');
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (!opts.file) {
        console.error('Usage: node reproduceUsBenchmark.js --file=/path/to/13102_2016_52_MOESM2_ESM.xlsx [--boot=10000] [--json]');
        process.exit(1);
    }
    const rows = loadWorkbookRows(opts.file);
    const report = runUsBenchmark(rows, opts);
    if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
    } else {
        console.log(formatUsReportMarkdown(report));
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    RIEGEL_STANDARD_EXPONENT,
    KM_PER_MILE,
    BASE_METERS,
    MARATHON_METERS,
    HM_METERS,
    TENK_METERS,
    LN_FM_OVER_5K,
    HUBER_DELTA,
    parseXlsxBuffer,
    parseCsvText,
    loadWorkbookRows,
    distUnit,
    cumulativeExcessIntegral,
    integralDistanceWeight,
    computeDeltaMarV22,
    predictIntegralExponentV22,
    predictIntegralExponent,
    predictEndpointExponent,
    predictTimeSeconds,
    predictVickersVertosickModel1Seconds,
    predictClampedVickersVertosickSeconds,
    fitDeltaMarGivenGamma,
    fitJointIntegralHuber,
    fitDirectHmUncapped,
    fitStage1FmIrls,
    fitStage2Gamma,
    extractTargetPairs,
    extractDownwardFmToHmPairs,
    extractAllSubMarathonBasisForAudit,
    summarizeErrors,
    pairedBootstrap,
    clusteredPairedBootstrap,
    auditMonotonicity,
    runUsBenchmark,
    formatUsReportMarkdown,
    formatClock,
    parseArgs,
};
