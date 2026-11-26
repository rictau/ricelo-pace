#!/usr/bin/env node
/**
 * Deterministic SVG figure generator for the Ricelo-Pace model.
 *
 * Zero external dependencies; regenerates identically anywhere:
 *   node scripts/generatePaperFigures.js
 *
 * Outputs 7 vector `.svg` charts into `figures/` (5 main-text + 2 supplementary):
 *   1. fig1-exponent-curves.svg          : Figure 1  - Uncapped integral HM->FM & 10K->HM curves (10..230 km/wk) vs. V&V 2016 & R1.06
 *   2. fig2-us-hm-tiers.svg              : Figure 2  - US HM out-of-fold MAE & median bias by 5 weekly mileage tiers (g3 adj N=391)
 *   3. fig3-cross-continental-penmse.svg : Figure 3  - Out-of-sample Penalized MSE across US Survey, Club Protocol A1 (unfiltered) & Protocol B
 *   4. fig4-club-zeroshot-scatter.svg    : Figure 4  - Predicted vs. Actual marathon times on Club 730d Protocol A1 (N=22, zero outcome filter)
 *   5. fig5-club-residuals.svg           : Figure S1 - Race-by-race signed residual box-and-strip plot (Club 730d Protocol A1 N=22)
 *   6. fig6-climate-gamma-ramp.svg       : Figure S2 - Marginal density u(D)^gamma (Raw vs. Adj) & exact path-averaged interval weights w(D1, D2)
 *   7. fig7-practical-pacing-impact.svg  : Figure 5  - Practical race-time curves (20..230 km/wk) for 2:00 HM->FM and 1:00:00 10K->HM
 */

const fs = require('fs');
const path = require('path');
const {
    integralDistanceWeight,
    predictIntegralExponentV22,
    predictTimeSeconds,
    predictVickersVertosickModel1Seconds,
    predictClampedVickersVertosickSeconds,
} = require('./reproduceUsBenchmark');

const ML_CLUB_RIEGEL_MODEL = Object.freeze({
    fmDeltaIntercept: 0.5413,
    fmSlopeLnKm: 0.1002,
    distanceGamma: 2.8427,
});

function computeMileageAdjustedExponent({ avgWeeklyKm, targetMeters, refMeters }) {
    const exact = predictIntegralExponentV22({
        volKm: avgWeeklyKm,
        basisMeters: refMeters,
        targetMeters,
        b0: ML_CLUB_RIEGEL_MODEL.fmDeltaIntercept,
        b1: ML_CLUB_RIEGEL_MODEL.fmSlopeLnKm,
        gamma: ML_CLUB_RIEGEL_MODEL.distanceGamma,
    });
    return { exact_exponent: exact, exponent: Number(exact.toFixed(3)) };
}

function predictRiegelSeconds(basisSeconds, basisMeters, targetMeters, exponent) {
    return Math.round(predictTimeSeconds(basisSeconds, basisMeters, targetMeters, exponent));
}

const OUT_DIR = path.resolve(__dirname, '../figures');

// Anonymized Club Protocol A1 (race-tagged, ZERO outcome filter) FM rows
// from the pilot Indonesian club external validation (730d = first 22; 1095d = all 25).
const CLUB_A1_FM_ROWS = [
    { id: 'M05', actualMin: 326.55, vol: 31.0, emp: 1.1231, strictWt1: false, legacyDrop: false, in730d: true, errR106: -14.0, errVv: 2.0, errEndpoint: 5.5, errRicelo: 13.9 },
    { id: 'M01', actualMin: 321.15, vol: 45.8, emp: 1.3371, strictWt1: true, legacyDrop: true, in730d: true, errR106: -56.1, errVv: -43.4, errEndpoint: -43.0, errRicelo: -37.4 },
    { id: 'M02', actualMin: 276.73, vol: 45.4, emp: 1.3084, strictWt1: true, legacyDrop: true, in730d: true, errR106: -43.8, errVv: -28.4, errEndpoint: -32.2, errRicelo: -27.2 },
    { id: 'M18', actualMin: 202.25, vol: 72.1, emp: 1.0183, strictWt1: true, legacyDrop: false, in730d: true, errR106: 5.9, errVv: 15.1, errEndpoint: 13.1, errRicelo: 16.3 },
    { id: 'M18', actualMin: 221.53, vol: 75.3, emp: 1.1370, strictWt1: true, legacyDrop: false, in730d: true, errR106: -33.5, errVv: -20.8, errEndpoint: -13.9, errRicelo: -21.9 },
    { id: 'M11', actualMin: 294.25, vol: 50.9, emp: 1.1431, strictWt1: false, legacyDrop: false, in730d: true, errR106: -33.2, errVv: -20.5, errEndpoint: -7.7, errRicelo: -11.2 },
    { id: 'M19', actualMin: 281.15, vol: 45.0, emp: 1.0720, strictWt1: true, legacyDrop: false, in730d: true, errR106: -2.3, errVv: 9.4, errEndpoint: 11.6, errRicelo: 17.6 },
    { id: 'M20', actualMin: 208.50, vol: 59.3, emp: 1.0646, strictWt1: true, legacyDrop: false, in730d: true, errR106: -0.7, errVv: 12.1, errEndpoint: 7.8, errRicelo: 11.6 },
    { id: 'M08', actualMin: 309.70, vol: 41.1, emp: 1.1698, strictWt1: false, legacyDrop: false, in730d: true, errR106: -45.3, errVv: -28.6, errEndpoint: -15.3, errRicelo: -19.6 },
    { id: 'M18', actualMin: 207.63, vol: 66.5, emp: 1.0763, strictWt1: true, legacyDrop: false, in730d: true, errR106: -2.3, errVv: 8.6, errEndpoint: 5.2, errRicelo: 8.7 },
    { id: 'M06', actualMin: 319.12, vol: 35.2, emp: 0.9935, strictWt1: true, legacyDrop: true, in730d: true, errR106: 15.1, errVv: 26.1, errEndpoint: 34.5, errRicelo: 42.8 },
    { id: 'M18', actualMin: 218.32, vol: 73.9, emp: 1.1487, strictWt1: false, legacyDrop: false, in730d: true, errR106: -13.0, errVv: -4.0, errEndpoint: -6.2, errRicelo: -3.0 },
    { id: 'M21', actualMin: 282.75, vol: 36.2, emp: 1.0789, strictWt1: true, legacyDrop: false, in730d: true, errR106: -3.7, errVv: 12.3, errEndpoint: 12.3, errRicelo: 19.1 },
    { id: 'M22', actualMin: 285.18, vol: 44.7, emp: 1.0999, strictWt1: true, legacyDrop: false, in730d: true, errR106: -7.8, errVv: 4.2, errEndpoint: 6.1, errRicelo: 12.2 },
    { id: 'M16', actualMin: 277.98, vol: 43.0, emp: 1.1319, strictWt1: true, legacyDrop: false, in730d: true, errR106: -13.5, errVv: 0.5, errEndpoint: 0.1, errRicelo: 6.0 },
    { id: 'M08', actualMin: 343.28, vol: 48.1, emp: 1.4694, strictWt1: false, legacyDrop: true, in730d: true, errR106: -84.8, errVv: -72.5, errEndpoint: -72.5, errRicelo: -67.1 },
    { id: 'M20', actualMin: 211.97, vol: 50.8, emp: 1.1159, strictWt1: true, legacyDrop: false, in730d: true, errR106: -8.1, errVv: 7.2, errEndpoint: 1.3, errRicelo: 5.4 },
    { id: 'M09', actualMin: 300.48, vol: 43.1, emp: 1.3836, strictWt1: false, legacyDrop: true, in730d: true, errR106: -60.4, errVv: -44.6, errEndpoint: -48.0, errRicelo: -42.7 },
    { id: 'M15', actualMin: 372.02, vol: 32.1, emp: 1.2534, strictWt1: true, legacyDrop: false, in730d: true, errR106: -46.7, errVv: -32.5, errEndpoint: -26.7, errRicelo: -18.2 },
    { id: 'M02', actualMin: 233.07, vol: 55.4, emp: 0.9666, strictWt1: true, legacyDrop: true, in730d: true, errR106: 15.6, errVv: 26.0, errEndpoint: 26.3, errRicelo: 31.0 },
    { id: 'M12', actualMin: 469.63, vol: 49.9, emp: 1.4875, strictWt1: false, legacyDrop: true, in730d: true, errR106: -215.9, errVv: -202.1, errEndpoint: -190.8, errRicelo: -194.2 },
    { id: 'M02', actualMin: 272.05, vol: 56.1, emp: 1.1897, strictWt1: true, legacyDrop: false, in730d: true, errR106: -23.4, errVv: -13.3, errEndpoint: -12.8, errRicelo: -8.1 },
    { id: 'M05', actualMin: 326.70, vol: 29.0, emp: 1.1561, strictWt1: false, legacyDrop: false, in730d: false, errR106: -21.0, errVv: -3.2, errEndpoint: -1.3, errRicelo: 7.1 },
    { id: 'M03', actualMin: 294.93, vol: 29.0, emp: 0.9833, strictWt1: true, legacyDrop: true, in730d: false, errR106: 52.4, errVv: 70.9, errEndpoint: 126.4, errRicelo: 94.1 },
    { id: 'M16', actualMin: 299.38, vol: 37.6, emp: 1.2157, strictWt1: true, legacyDrop: false, in730d: false, errR106: -30.6, errVv: -14.6, errEndpoint: -15.6, errRicelo: -9.1 },
];

function vvModel1ImpliedFmExp(volKm, hmSec = 7200) {
    const fmSec = predictVickersVertosickModel1Seconds({
        basisSeconds: hmSec,
        basisMeters: 21097.5,
        avgWeeklyKm: volKm,
    });
    return Math.log(fmSec / hmSec) / Math.log(42195 / 21097.5);
}

function esc(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function svgHeader(width, height, title) {
    return [
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" fill="#1e293b" role="img" aria-label="${esc(title)}">`,
        '<style>',
        '  text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }',
        '  .title { font-size: 15.5px; font-weight: 700; fill: #0f172a; }',
        '  .subtitle { font-size: 11.5px; fill: #475569; }',
        '  .axis-label { font-size: 12px; font-weight: 600; fill: #334155; }',
        '  .tick { font-size: 11px; fill: #64748b; font-variant-numeric: tabular-nums; }',
        '  .legend { font-size: 11px; }',
        '  .note { font-size: 10.5px; }',
        '  .badge { font-size: 11px; font-weight: 700; }',
        '  .direct-label { font-size: 11px; font-weight: 600; }',
        '</style>',
        `<rect x="0" y="0" width="${width}" height="${height}" rx="10" fill="#ffffff" stroke="#e2e8f0" stroke-width="1"/>`,
    ].join('\n');
}

function quantileSorted(sorted, p) {
    const pos = (sorted.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function fmtHM(totalMin) {
    const totalSec = Math.round(totalMin * 60);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    return `${h}:${String(m).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Figure 1: Uncapped Ricelo-Pace Integral Exponents vs. Weekly Mileage
// ---------------------------------------------------------------------------
function buildFigure1() {
    const W = 920;
    const H = 495;
    const pad = { l: 68, r: 236, t: 88, b: 64 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    const xMin = 10;
    const xMax = 160;
    const yMin = 0.94;
    const yMax = 1.52;
    const xPx = (v) => pad.l + ((v - xMin) / (xMax - xMin)) * pw;
    const yPx = (e) => pad.t + ((yMax - e) / (yMax - yMin)) * ph;

    const out = [svgHeader(W, H, 'Ricelo-Pace Integral Fatigue Exponents vs. Weekly Running Mileage')];
    out.push(`<text x="${pad.l}" y="28" class="title">Ricelo-Pace Integral Exponents Across Weekly Mileage (10 to 160 km/wk)</text>`);
    out.push(`<text x="${pad.l}" y="46" class="subtitle">Joint US 3-parameter integral fit (b0=0.5413, b1=0.1002, γ=2.8427) vs. V&amp;V (2016) and unfiltered club FMs</text>`);

    out.push(`<circle cx="${pad.l + 5}" cy="68" r="4" fill="#e11d48" fill-opacity="0.55" stroke="#881337" stroke-width="1"/>`);
    out.push(`<text x="${pad.l + 15}" y="72" class="legend" fill="#334155">Club A1 race-tagged FM (N=25, unfiltered)</text>`);
    out.push(`<polygon points="${pad.l + 258},63 ${pad.l + 263},68 ${pad.l + 258},73 ${pad.l + 253},68" fill="#ffffff" stroke="#0d9488" stroke-width="2"/>`);
    out.push(`<text x="${pad.l + 269}" y="72" class="legend" fill="#334155">US HM tier medians (N=1,316)</text>`);
    out.push(`<line x1="${pad.l + 448}" y1="68" x2="${pad.l + 474}" y2="68" stroke="#d97706" stroke-width="2" stroke-dasharray="5 3"/>`);
    out.push(`<text x="${pad.l + 481}" y="72" class="legend" fill="#334155">V&amp;V Model 1 (2:00 HM)</text>`);

    for (let y = 0.95; y <= 1.501; y += 0.05) {
        const py = yPx(y);
        out.push(`<line x1="${pad.l}" y1="${py.toFixed(1)}" x2="${W - pad.r}" y2="${py.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
        if (Math.round(y * 100) % 10 === 0 || Math.abs(y - 1.05) < 0.001) {
            out.push(`<text x="${pad.l - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" class="tick">${y.toFixed(2)}</text>`);
        }
    }
    for (const x of [10, 40, 70, 100, 130, 160]) {
        const px = xPx(x);
        out.push(`<line x1="${px.toFixed(1)}" y1="${pad.t}" x2="${px.toFixed(1)}" y2="${H - pad.b}" stroke="#f1f5f9" stroke-width="1"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle" class="tick">${x}</text>`);
    }

    const y106 = yPx(1.06);
    out.push(`<rect x="${pad.l}" y="${y106.toFixed(1)}" width="${pw}" height="${(H - pad.b - y106).toFixed(1)}" fill="#fef3c7" fill-opacity="0.35"/>`);
    out.push(`<line x1="${pad.l}" y1="${y106.toFixed(1)}" x2="${W - pad.r}" y2="${y106.toFixed(1)}" stroke="#64748b" stroke-width="1.6" stroke-dasharray="6 4"/>`);

    // Unfiltered 1095d Protocol A1 club FMs (N = 25)
    for (const p of CLUB_A1_FM_ROWS) {
        const cx = xPx(p.vol);
        const cy = yPx(p.emp);
        const fill = p.legacyDrop ? '#fda4af' : '#e11d48';
        out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.1" fill="${fill}" fill-opacity="0.68" stroke="#881337" stroke-width="0.9"/>`);
    }

    const pts = (fn, maxV = xMax) => {
        const arr = [];
        for (let v = xMin; v <= maxV; v += 2) {
            const val = fn(v);
            if (val >= yMin && val <= yMax) {
                arr.push(`${xPx(v).toFixed(1)},${yPx(val).toFixed(1)}`);
            }
        }
        return arr.join(' ');
    };

    const fmFn = (v) => computeMileageAdjustedExponent({ avgWeeklyKm: v, targetMeters: 42195, refMeters: 21097.5 }).exact_exponent;
    const hmFn = (v) => computeMileageAdjustedExponent({ avgWeeklyKm: v, targetMeters: 21097.5, refMeters: 10000 }).exact_exponent;

    out.push(`<polyline fill="none" stroke="#d97706" stroke-width="2.1" stroke-dasharray="5 3" points="${pts((v) => vvModel1ImpliedFmExp(v, 7200), 160)}"/>`);
    out.push(`<polyline fill="none" stroke="#e11d48" stroke-width="3.2" points="${pts(fmFn)}"/>`);
    out.push(`<polyline fill="none" stroke="#0d9488" stroke-width="2.8" points="${pts(hmFn)}"/>`);

    // Verified 5 US HM empirical subgroup medians (N = 1,316)
    const usHmTiers = [
        { km: 29.0, exp: 1.0867 },
        { km: 48.3, exp: 1.0756 },
        { km: 72.4, exp: 1.0684 },
        { km: 96.6, exp: 1.0564 },
        { km: 127.1, exp: 1.0526 },
    ];
    for (const t of usHmTiers) {
        const cx = xPx(t.km);
        const cy = yPx(t.exp);
        out.push(`<polygon points="${cx.toFixed(1)},${(cy - 5.0).toFixed(1)} ${(cx + 5.0).toFixed(1)},${cy.toFixed(1)} ${cx.toFixed(1)},${(cy + 5.0).toFixed(1)} ${(cx - 5.0).toFixed(1)},${cy.toFixed(1)}" fill="#ffffff" stroke="#0d9488" stroke-width="2"/>`);
    }

    // Callout: V&V crosses below 1.06 near 82 km/wk
    const crossX = xPx(82);
    out.push(`<circle cx="${crossX.toFixed(1)}" cy="${y106.toFixed(1)}" r="4.5" fill="#d97706" stroke="#ffffff" stroke-width="1.5"/>`);
    out.push(`<line x1="${crossX.toFixed(1)}" y1="${(y106 + 5).toFixed(1)}" x2="${(crossX + 12).toFixed(1)}" y2="${(yPx(0.985)).toFixed(1)}" stroke="#b45309" stroke-width="1.1"/>`);
    out.push(`<text x="${(crossX + 16).toFixed(1)}" y="${(yPx(0.985) + 4).toFixed(1)}" text-anchor="start" class="note" fill="#92400e" font-weight="600">V&amp;V crosses below 1.06 near 82 km/wk</text>`);

    const rx = W - pad.r + 14;
    const labels = [
        { y: 174, col: '#be123c', title: 'Ricelo-Pace HM->FM', sub: 'w=0.624; x=1.254 at 10k' },
        { y: 230, col: '#0f766e', title: 'Ricelo-Pace 10K->HM', sub: 'w=0.154; γ=2.8427' },
        { y: 288, col: '#475569', title: 'Classic Riegel floor (1.06)', sub: 'Physical 1.06 lower bound' },
        { y: 344, col: '#b45309', title: 'V&V (2016 Model 1)', sub: 'Drops below 1.06 past 82k' },
        { y: 400, col: '#9f1239', title: 'Light pink points (A1)', sub: 'Outside legacy 1.00..1.26' },
    ];
    for (const lb of labels) {
        out.push(`<text x="${rx}" y="${lb.y}" class="direct-label" fill="${lb.col}">${esc(lb.title)}</text>`);
        out.push(`<text x="${rx}" y="${lb.y + 14}" class="note" fill="#64748b">${esc(lb.sub)}</text>`);
    }

    out.push(`<rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${(pad.l + pw / 2).toFixed(1)}" y="${H - 18}" text-anchor="middle" class="axis-label">Weekly Running Mileage (km / week, uncapped above 10 km/wk)</text>`);
    out.push(`<text x="19" y="${(pad.t + ph / 2).toFixed(1)}" text-anchor="middle" class="axis-label" transform="rotate(-90 19 ${(pad.t + ph / 2).toFixed(1)})">Riegel Fatigue Exponent (x)</text>`);
    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 2: US Half Marathon Out-of-Fold MAE & Bias by 5 Mileage Tiers (g3 adj N=391)
// ---------------------------------------------------------------------------
function buildFigure2() {
    const W = 890;
    const H = 475;
    const out = [svgHeader(W, H, 'US Half Marathon Out-of-Fold Accuracy and Bias by Weekly Mileage Tier')];
    out.push('<text x="36" y="28" class="title">US Half Marathon Out-of-Sample Accuracy by Weekly Mileage (Group 3 Adj, N = 391)</text>');
    out.push('<text x="36" y="46" class="subtitle">V&amp;V (2016) provides no HM model; Ricelo-Pace beats both Riegel 1.06 (P=100%) and 1.07 (P=98.6%)</text>');

    const legItems = [
        { label: 'Classic Riegel (1.06)', col: '#94a3b8' },
        { label: 'Riegel (1.07)', col: '#64748b' },
        { label: 'Ricelo-Pace (Integral)', col: '#0d9488' },
    ];
    let lx = 36;
    for (const item of legItems) {
        out.push(`<rect x="${lx}" y="60" width="12" height="10" rx="2" fill="${item.col}"/>`);
        out.push(`<text x="${lx + 17}" y="69" class="legend" fill="#334155">${esc(item.label)}</text>`);
        lx += item.label.length * 6.8 + 38;
    }

    const tiers = [
        { label: '<25 mi/wk', sub: '(<40 km/wk, n=139)', r106Mae: 8.34, r107Mae: 7.87, rpMae: 7.40, r106Bias: -4.73, r107Bias: -3.34, rpBias: -1.09 },
        { label: '25-39.9 mi/wk', sub: '(40-64 km/wk, n=136)', r106Mae: 6.86, r107Mae: 6.52, rpMae: 6.40, r106Bias: -2.67, r107Bias: -1.49, rpBias: -0.32 },
        { label: '40-54.9 mi/wk', sub: '(64-88 km/wk, n=79)', r106Mae: 4.48, r107Mae: 4.36, rpMae: 4.49, r106Bias: -0.54, r107Bias: 0.39, rpBias: 0.89 },
        { label: '55-68.3 mi/wk', sub: '(88-110 km/wk, n=24)', r106Mae: 2.02, r107Mae: 2.02, rpMae: 2.02, r106Bias: -0.45, r107Bias: 0.70, rpBias: 0.41 },
        { label: '>68.3 mi/wk', sub: '(>110 km/wk, n=13)', r106Mae: 1.16, r107Mae: 1.20, rpMae: 1.21, r106Bias: -0.15, r107Bias: 0.89, rpBias: 0.40 },
    ];

    const p1 = { x: 162, y: 102, w: 280, h: 318 };
    const maeMax = 9.5;
    const xMae = (v) => p1.x + (v / maeMax) * p1.w;
    out.push(`<text x="${(p1.x + p1.w / 2).toFixed(1)}" y="92" text-anchor="middle" class="badge" fill="#0f172a">A. Mean Absolute Error (min)</text>`);
    for (let m = 0; m <= 9; m += 3) {
        const px = xMae(m);
        out.push(`<line x1="${px.toFixed(1)}" y1="${p1.y}" x2="${px.toFixed(1)}" y2="${p1.y + p1.h}" stroke="#e2e8f0" stroke-width="1"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${p1.y + p1.h + 16}" text-anchor="middle" class="tick">${m}m</text>`);
    }

    const p2 = { x: 496, y: 102, w: 348, h: 318 };
    const bMin = -5.6;
    const bMax = 2.0;
    const xBias = (v) => p2.x + ((v - bMin) / (bMax - bMin)) * p2.w;
    out.push(`<text x="${(p2.x + p2.w / 2).toFixed(1)}" y="92" text-anchor="middle" class="badge" fill="#0f172a">B. Median Signed Bias (min; negative = too fast)</text>`);
    for (let b = -5; b <= 2; b += 1) {
        const px = xBias(b);
        const isZero = b === 0;
        out.push(`<line x1="${px.toFixed(1)}" y1="${p2.y}" x2="${px.toFixed(1)}" y2="${p2.y + p2.h}" stroke="${isZero ? '#334155' : '#e2e8f0'}" stroke-width="${isZero ? 1.5 : 1}"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${p2.y + p2.h + 16}" text-anchor="middle" class="tick">${b > 0 ? `+${b}` : b}m</text>`);
    }

    const rowStep = p1.h / tiers.length;
    const barH = 13;
    const barGap = 4;

    tiers.forEach((t, idx) => {
        const yTop = p1.y + idx * rowStep + 8;
        if (idx > 0) {
            out.push(`<line x1="36" y1="${(p1.y + idx * rowStep).toFixed(1)}" x2="${p2.x + p2.w}" y2="${(p1.y + idx * rowStep).toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`);
        }
        out.push(`<text x="${p1.x - 12}" y="${(yTop + 20).toFixed(1)}" text-anchor="end" class="direct-label" fill="#0f172a">${esc(t.label)}</text>`);
        out.push(`<text x="${p1.x - 12}" y="${(yTop + 34).toFixed(1)}" text-anchor="end" class="note" fill="#64748b">${esc(t.sub)}</text>`);

        const maeRows = [
            { val: t.r106Mae, col: '#94a3b8', bold: false },
            { val: t.r107Mae, col: '#64748b', bold: false },
            { val: t.rpMae, col: '#0d9488', bold: true },
        ];
        maeRows.forEach((r, bi) => {
            const by = yTop + bi * (barH + barGap);
            const bw = xMae(r.val) - p1.x;
            out.push(`<rect x="${p1.x}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" rx="3" fill="${r.col}"/>`);
            out.push(`<text x="${(p1.x + bw + 5).toFixed(1)}" y="${(by + 10.5).toFixed(1)}" class="tick" fill="${r.bold ? '#0f766e' : '#475569'}" font-weight="${r.bold ? '700' : '500'}">${r.val.toFixed(2)}m</text>`);
        });

        const zeroX = xBias(0);
        const biasRows = [
            { val: t.r106Bias, col: '#94a3b8', bold: false },
            { val: t.r107Bias, col: '#64748b', bold: false },
            { val: t.rpBias, col: '#0d9488', bold: true },
        ];
        biasRows.forEach((r, bi) => {
            const by = yTop + bi * (barH + barGap);
            const vx = xBias(r.val);
            const bx = Math.min(zeroX, vx);
            const bw = Math.max(2, Math.abs(vx - zeroX));
            out.push(`<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${bw.toFixed(1)}" height="${barH}" rx="3" fill="${r.col}"/>`);
            const lbl = `${r.val >= 0 ? '+' : ''}${r.val.toFixed(2)}m`;
            const tx = r.val < 0 ? bx - 5 : bx + bw + 5;
            const anchor = r.val < 0 ? 'end' : 'start';
            out.push(`<text x="${tx.toFixed(1)}" y="${(by + 10.5).toFixed(1)}" text-anchor="${anchor}" class="tick" fill="${r.bold ? '#0f766e' : '#475569'}" font-weight="${r.bold ? '700' : '500'}">${lbl}</text>`);
        });
    });

    out.push(`<text x="${(p1.x + p1.w / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="note" fill="#475569">Overall g3 adj MAE: 5.93m vs. 6.11m (R1.07, P=98.6%) &amp; 6.42m (R1.06, P=100%)</text>`);
    out.push(`<text x="${(p2.x + p2.w / 2).toFixed(1)}" y="${H - 12}" text-anchor="middle" class="note" fill="#475569">Overall g3 adj Pen. MSE: 126.4 vs. 140.4 (R1.07) &amp; 156.5 (R1.06)</text>`);
    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 3: Two-Panel Out-of-Sample Penalized MSE (US Survey + Club A1 & B)
// ---------------------------------------------------------------------------
function buildFigure3() {
    const W = 900;
    const H = 610;
    const labelX = 248;
    const trackX = 258;
    const trackW = 452;

    const out = [svgHeader(W, H, 'Out-of-Sample Pacing Safety (Penalized MSE) Across US Survey and Pilot Club GPS')];
    out.push('<text x="36" y="28" class="title">Out-of-Sample Pacing Safety (Penalized MSE): US Survey &amp; Pilot Club GPS</text>');
    out.push('<text x="36" y="46" class="subtitle">2x squared penalty on fast misses; separate axes for Survey/Protocol B (top) and zero-filter Protocol A1 (bottom)</text>');

    const drawPanel = ({ yTop, maxVal, ticks, groups, axisLabel }) => {
        const xPx = (v) => trackX + (v / maxVal) * trackW;
        const rowsCount = groups.reduce((s, g) => s + g.rows.length, 0);
        const panelH = groups.length * 30 + rowsCount * 19;
        const yEnd = yTop + panelH;

        for (const t of ticks) {
            const px = xPx(t);
            out.push(`<line x1="${px.toFixed(1)}" y1="${(yTop - 4).toFixed(1)}" x2="${px.toFixed(1)}" y2="${yEnd.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
            out.push(`<text x="${px.toFixed(1)}" y="${(yEnd + 15).toFixed(1)}" text-anchor="middle" class="tick">${t}</text>`);
        }

        let cy = yTop;
        groups.forEach((g, gi) => {
            if (gi > 0) {
                out.push(`<line x1="36" y1="${(cy - 6).toFixed(1)}" x2="${W - 24}" y2="${(cy - 6).toFixed(1)}" stroke="#f1f5f9" stroke-width="1"/>`);
            }
            out.push(`<text x="36" y="${(cy + 8).toFixed(1)}" class="badge" fill="#0f172a">${esc(g.header)}</text>`);
            cy += 18;
            for (const r of g.rows) {
                const bw = Math.max(2, xPx(r.val) - trackX);
                out.push(`<text x="${labelX}" y="${(cy + 10.5).toFixed(1)}" text-anchor="end" class="legend" fill="${r.bold ? '#0f172a' : '#475569'}" font-weight="${r.bold ? '700' : '500'}">${esc(r.label)}</text>`);
                out.push(`<rect x="${trackX}" y="${cy.toFixed(1)}" width="${bw.toFixed(1)}" height="13" rx="3" fill="${r.col}"/>`);
                out.push(`<text x="${(trackX + bw + 7).toFixed(1)}" y="${(cy + 10.5).toFixed(1)}" class="tick" fill="${r.bold ? '#be123c' : '#334155'}" font-weight="${r.bold ? '700' : '500'}">${r.val.toFixed(1)} (${esc(r.note)})</text>`);
                cy += 19;
            }
            cy += 12;
        });

        out.push(`<text x="${(trackX + trackW / 2).toFixed(1)}" y="${(yEnd + 32).toFixed(1)}" text-anchor="middle" class="note" fill="#475569" font-weight="600">${esc(axisLabel)}</text>`);
        return yEnd + 48;
    };

    const nextY = drawPanel({
        yTop: 72,
        maxVal: 1800,
        ticks: [0, 400, 800, 1200, 1600],
        axisLabel: 'Panel A: US Validation Splits & Club Legacy Sensitivity Protocol B (Penalized MSE, min²)',
        groups: [
            {
                header: 'US Validation Adjusted (Group 3, *_ti_adj, N = 310)',
                rows: [
                    { label: 'Classic Riegel (1.06)', val: 910.4, note: 'baseline', col: '#94a3b8', bold: false },
                    { label: 'V&V (2016 Model 1)', val: 440.8, note: 'Clamped V&V: 440.6', col: '#d97706', bold: false },
                    { label: 'Ricelo-Pace (g1+g2)', val: 423.9, note: '-3.8% vs V&V (P=84.9%)', col: '#e11d48', bold: true },
                ],
            },
            {
                header: 'US Validation Raw (Group 3, N = 325)',
                rows: [
                    { label: 'Classic Riegel (1.06)', val: 1087.0, note: 'baseline', col: '#94a3b8', bold: false },
                    { label: 'V&V (2016 Model 1)', val: 564.2, note: 'Clamped V&V: 564.0', col: '#d97706', bold: false },
                    { label: 'Ricelo-Pace (g1+g2)', val: 514.6, note: '-8.8% vs V&V (P=98.8%)', col: '#e11d48', bold: true },
                ],
            },
            {
                header: 'Pilot Club GPS 730d Protocol B (Legacy 1.00..1.26, N = 21)',
                rows: [
                    { label: 'Classic Riegel (1.06)', val: 1644.2, note: 'baseline', col: '#94a3b8', bold: false },
                    { label: 'V&V Model 1 / Clamped V&V', val: 1065.9, note: 'Clamped: 1047.5', col: '#d97706', bold: false },
                    { label: 'Ricelo-Pace (Zero-Shot)', val: 552.9, note: '-48% vs V&V (P=98.8%)', col: '#e11d48', bold: true },
                ],
            },
        ],
    });

    out.push(`<line x1="36" y1="${(nextY - 8).toFixed(1)}" x2="${W - 24}" y2="${(nextY - 8).toFixed(1)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="4 3"/>`);

    drawPanel({
        yTop: nextY + 8,
        maxVal: 7000,
        ticks: [0, 1500, 3000, 4500, 6000],
        axisLabel: 'Panel B: Pilot Club GPS Primary Protocol A1 (Race-Tagged, ZERO Outcome Filter; includes race bonks)',
        groups: [
            {
                header: 'Pilot Club GPS 730d Protocol A1 (Zero Outcome Filter, N = 22)',
                rows: [
                    { label: 'Classic Riegel (1.06)', val: 6404.5, note: 'baseline', col: '#94a3b8', bold: false },
                    { label: 'V&V Model 1 (= Clamped V&V)', val: 4978.7, note: '-22% vs R1.06', col: '#d97706', bold: false },
                    { label: 'Ricelo-Pace (Zero-Shot)', val: 4522.1, note: '-9.2% vs V&V (P=96.7%)', col: '#e11d48', bold: true },
                ],
            },
            {
                header: 'Pilot Club GPS 1095d Protocol A1 (Zero Outcome Filter, N = 25)',
                rows: [
                    { label: 'Classic Riegel (1.06)', val: 5856.4, note: 'baseline', col: '#94a3b8', bold: false },
                    { label: 'V&V Model 1 (= Clamped V&V)', val: 4600.1, note: '-21% vs R1.06', col: '#d97706', bold: false },
                    { label: 'Ricelo-Pace (Zero-Shot)', val: 4342.0, note: '-5.6% vs V&V (P=79.3%)', col: '#e11d48', bold: true },
                ],
            },
        ],
    });

    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 4: Predicted vs. Actual FM Times (Club 730d Protocol A1, N = 22)
// ---------------------------------------------------------------------------
function buildFigure4() {
    const W = 840;
    const H = 510;
    const pad = { l: 74, r: 44, t: 86, b: 60 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    const minT = 185;
    const maxT = 485;
    const xPx = (m) => pad.l + ((m - minT) / (maxT - minT)) * pw;
    const yPx = (m) => pad.t + ((maxT - m) / (maxT - minT)) * ph;

    const out = [svgHeader(W, H, 'Predicted vs. Actual Marathon Times on Indonesian Club Zero-Shot Protocol A1')];
    out.push(`<text x="${pad.l}" y="28" class="title">Indonesian Club Zero-Shot Protocol A1: Predicted vs. Actual FM (N = 22)</text>`);
    out.push(`<text x="${pad.l}" y="46" class="subtitle">All 22 race-tagged 730d finishes with ZERO outcome filtering; both V&amp;V and Ricelo-Pace trained on US only</text>`);

    out.push(`<circle cx="${pad.l + 5}" cy="68" r="4.5" fill="#ffffff" stroke="#64748b" stroke-width="1.6"/>`);
    out.push(`<text x="${pad.l + 16}" y="72" class="legend" fill="#475569">Classic Riegel 1.06 (MAE 33.9m)</text>`);
    out.push(`<polygon points="${pad.l + 225},63 ${pad.l + 230},73 ${pad.l + 220},73" fill="#f59e0b" fill-opacity="0.82" stroke="#92400e" stroke-width="1"/>`);
    out.push(`<text x="${pad.l + 237}" y="72" class="legend" fill="#92400e">V&amp;V Model 1 (MAE 28.8m)</text>`);
    out.push(`<circle cx="${pad.l + 408}" cy="68" r="4.8" fill="#e11d48" stroke="#881337" stroke-width="1.1"/>`);
    out.push(`<text x="${pad.l + 419}" y="72" class="legend" fill="#be123c" font-weight="700">Ricelo-Pace (MAE 28.9m, MedBias +1.2m)</text>`);

    for (let t = 210; t <= 480; t += 30) {
        const px = xPx(t);
        const py = yPx(t);
        out.push(`<line x1="${px.toFixed(1)}" y1="${pad.t}" x2="${px.toFixed(1)}" y2="${H - pad.b}" stroke="#e2e8f0" stroke-width="1"/>`);
        out.push(`<line x1="${pad.l}" y1="${py.toFixed(1)}" x2="${W - pad.r}" y2="${py.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
        if (t % 60 === 0 || t === 210 || t === 270 || t === 330 || t === 390 || t === 450) {
            out.push(`<text x="${px.toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle" class="tick">${fmtHM(t)}</text>`);
            out.push(`<text x="${pad.l - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" class="tick">${fmtHM(t)}</text>`);
        }
    }

    const bandPts = [
        `${xPx(minT).toFixed(1)},${yPx(minT + 15).toFixed(1)}`,
        `${xPx(maxT - 15).toFixed(1)},${yPx(maxT).toFixed(1)}`,
        `${xPx(maxT).toFixed(1)},${yPx(maxT).toFixed(1)}`,
        `${xPx(maxT).toFixed(1)},${yPx(maxT - 15).toFixed(1)}`,
        `${xPx(minT + 15).toFixed(1)},${yPx(minT).toFixed(1)}`,
        `${xPx(minT).toFixed(1)},${yPx(minT).toFixed(1)}`,
    ].join(' ');
    out.push(`<polygon points="${bandPts}" fill="#10b981" fill-opacity="0.09"/>`);
    out.push(`<line x1="${xPx(minT).toFixed(1)}" y1="${yPx(minT).toFixed(1)}" x2="${xPx(maxT).toFixed(1)}" y2="${yPx(maxT).toFixed(1)}" stroke="#0f172a" stroke-width="1.5" stroke-dasharray="6 4"/>`);

    out.push(`<text x="${xPx(205).toFixed(1)}" y="${yPx(445).toFixed(1)}" class="note" fill="#64748b">Predicted too slow (conservative)</text>`);
    out.push(`<text x="${xPx(340).toFixed(1)}" y="${yPx(215).toFixed(1)}" class="note" fill="#be123c">Predicted too fast (blowup risk)</text>`);
    out.push(`<text x="${xPx(440).toFixed(1)}" y="${yPx(468).toFixed(1)}" text-anchor="end" class="note" fill="#047857" font-weight="600">±15 min band</text>`);

    const rows730 = CLUB_A1_FM_ROWS.filter((r) => r.in730d);

    for (const r of rows730) {
        const ax = xPx(r.actualMin);
        const yR = yPx(r.actualMin + r.errR106);
        const yV = yPx(r.actualMin + r.errVv);
        const yP = yPx(r.actualMin + r.errRicelo);
        out.push(`<line x1="${ax.toFixed(1)}" y1="${yR.toFixed(1)}" x2="${ax.toFixed(1)}" y2="${yP.toFixed(1)}" stroke="#cbd5e1" stroke-width="1" stroke-dasharray="2 2"/>`);
        out.push(`<circle cx="${ax.toFixed(1)}" cy="${yR.toFixed(1)}" r="3.8" fill="#ffffff" stroke="#64748b" stroke-width="1.4"/>`);
        out.push(`<polygon points="${ax.toFixed(1)},${(yV - 4.6).toFixed(1)} ${(ax + 4.2).toFixed(1)},${(yV + 3.6).toFixed(1)} ${(ax - 4.2).toFixed(1)},${(yV + 3.6).toFixed(1)}" fill="#f59e0b" fill-opacity="0.82" stroke="#92400e" stroke-width="0.9"/>`);
        out.push(`<circle cx="${ax.toFixed(1)}" cy="${yP.toFixed(1)}" r="4.5" fill="#e11d48" stroke="#881337" stroke-width="1"/>`);
    }

    // Callout: Member 12 extreme bonk/walk retained in zero-filter A1
    const m12 = rows730.find((r) => r.id === 'M12');
    const m12x = xPx(m12.actualMin);
    const m12y = yPx(m12.actualMin + m12.errRicelo);
    out.push(`<line x1="${(m12x - 6).toFixed(1)}" y1="${(m12y - 4).toFixed(1)}" x2="${(m12x - 42).toFixed(1)}" y2="${(m12y - 34).toFixed(1)}" stroke="#be123c" stroke-width="1.1"/>`);
    out.push(`<text x="${(m12x - 46).toFixed(1)}" y="${(m12y - 42).toFixed(1)}" text-anchor="end" class="note" fill="#0f172a" font-weight="600">Member 12 (7:49:38, emp x=1.49)</text>`);
    out.push(`<text x="${(m12x - 46).toFixed(1)}" y="${(m12y - 29).toFixed(1)}" text-anchor="end" class="note" fill="#64748b">Retained in zero-filter A1 (drives ~75% of PenMSE)</text>`);

    // Callout: Member 15 low-mileage FM
    const m15 = rows730.find((r) => r.id === 'M15');
    const m15x = xPx(m15.actualMin);
    const m15y = yPx(m15.actualMin + m15.errRicelo);
    out.push(`<line x1="${(m15x + 5).toFixed(1)}" y1="${(m15y - 5).toFixed(1)}" x2="${(m15x + 28).toFixed(1)}" y2="${(m15y - 24).toFixed(1)}" stroke="#be123c" stroke-width="1.1"/>`);
    out.push(`<text x="${(m15x + 32).toFixed(1)}" y="${(m15y - 26).toFixed(1)}" class="note" fill="#be123c" font-weight="600">Member 15 (32 km/wk)</text>`);
    out.push(`<text x="${(m15x + 32).toFixed(1)}" y="${(m15y - 13).toFixed(1)}" class="note" fill="#64748b">V&amp;V -32.5m vs Ricelo-Pace -18.2m</text>`);

    out.push(`<rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${(pad.l + pw / 2).toFixed(1)}" y="${H - 16}" text-anchor="middle" class="axis-label">Actual Marathon Finish Time (h:mm)</text>`);
    out.push(`<text x="20" y="${(pad.t + ph / 2).toFixed(1)}" text-anchor="middle" class="axis-label" transform="rotate(-90 20 ${(pad.t + ph / 2).toFixed(1)})">Predicted Marathon Finish Time (h:mm)</text>`);
    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 5: Race-by-Race Signed Error Distribution (Club 730d A1, N = 22)
// ---------------------------------------------------------------------------
function buildFigure5() {
    const W = 890;
    const H = 370;
    const pad = { l: 230, r: 44, t: 74, b: 64 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    // Show -118m to +52m cleanly so the left-edge Member 12 annotation never overlaps -84.8m dots
    const xMin = -118;
    const xMax = 52;
    const xPx = (v) => pad.l + ((Math.max(xMin, Math.min(xMax, v)) - xMin) / (xMax - xMin)) * pw;

    const out = [svgHeader(W, H, 'Indonesian Club 730d Zero-Shot Protocol A1 Signed Marathon Error Distribution')];
    out.push('<text x="36" y="28" class="title">Signed Marathon Residuals on Indonesian Club 730d Protocol A1 (N = 22, Unfiltered)</text>');
    out.push('<text x="36" y="46" class="subtitle">Predicted minus actual time (min); boxes show IQR [P25, P75] and vertical ticks show median across all 22 starts</text>');

    out.push(`<rect x="${xPx(-10).toFixed(1)}" y="${pad.t}" width="${(xPx(10) - xPx(-10)).toFixed(1)}" height="${ph}" fill="#10b981" fill-opacity="0.09"/>`);
    out.push(`<text x="${xPx(0).toFixed(1)}" y="${pad.t - 8}" text-anchor="middle" class="note" fill="#047857" font-weight="600">±10 min zone</text>`);

    for (let x = -110; x <= 50; x += 20) {
        const px = xPx(x);
        const isZero = x === 0;
        out.push(`<line x1="${px.toFixed(1)}" y1="${pad.t}" x2="${px.toFixed(1)}" y2="${H - pad.b}" stroke="${isZero ? '#0f172a' : '#e2e8f0'}" stroke-width="${isZero ? 1.5 : 1}" ${isZero ? 'stroke-dasharray="4 3"' : ''}/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle" class="tick">${x > 0 ? `+${x}` : x}m</text>`);
    }
    const zeroPx = xPx(0);
    out.push(`<line x1="${zeroPx.toFixed(1)}" y1="${pad.t}" x2="${zeroPx.toFixed(1)}" y2="${H - pad.b}" stroke="#0f172a" stroke-width="1.5" stroke-dasharray="4 3"/>`);

    const rows730 = CLUB_A1_FM_ROWS.filter((r) => r.in730d);
    const models = [
        { name: 'Classic Riegel (1.06)', sub: 'Med -13.8m | PenMSE 6405', key: 'errR106', col: '#64748b', fill: '#e2e8f0', bold: false, m12: -215.9 },
        { name: 'V&V (2016 Model 1)', sub: 'Med -1.8m | PenMSE 4979', key: 'errVv', col: '#d97706', fill: '#fef3c7', bold: false, m12: -202.1 },
        { name: 'Ricelo-Pace v1 (cap 110)', sub: 'Med -3.0m | PenMSE 4500', key: 'errEndpoint', col: '#0284c7', fill: '#e0f2fe', bold: false, m12: -190.8 },
        { name: 'Ricelo-Pace (Integral)', sub: 'Med +1.2m | PenMSE 4522', key: 'errRicelo', col: '#e11d48', fill: '#fecdd3', bold: true, m12: -194.2 },
    ];

    const step = ph / models.length;
    models.forEach((m, idx) => {
        const cy = pad.t + (idx + 0.5) * step;
        const vals = rows730.map((r) => r[m.key]).sort((a, b) => a - b);
        const p25 = quantileSorted(vals, 0.25);
        const med = quantileSorted(vals, 0.50);
        const p75 = quantileSorted(vals, 0.75);
        const inRange = vals.filter((v) => v >= xMin);
        const minIn = inRange[0];
        const maxIn = vals[vals.length - 1];

        out.push(`<text x="${pad.l - 12}" y="${(cy - 3).toFixed(1)}" text-anchor="end" class="direct-label" fill="${m.bold ? '#be123c' : '#0f172a'}">${esc(m.name)}</text>`);
        out.push(`<text x="${pad.l - 12}" y="${(cy + 12).toFixed(1)}" text-anchor="end" class="note" fill="#64748b">${esc(m.sub)}</text>`);

        out.push(`<line x1="${xPx(minIn).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${xPx(maxIn).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${m.col}" stroke-width="1.3" stroke-opacity="0.7"/>`);
        const bx = xPx(p25);
        const bw = Math.max(2, xPx(p75) - bx);
        out.push(`<rect x="${bx.toFixed(1)}" y="${(cy - 11).toFixed(1)}" width="${bw.toFixed(1)}" height="22" rx="4" fill="${m.fill}" stroke="${m.col}" stroke-width="${m.bold ? 2.2 : 1.5}"/>`);
        out.push(`<line x1="${xPx(med).toFixed(1)}" y1="${(cy - 11).toFixed(1)}" x2="${xPx(med).toFixed(1)}" y2="${(cy + 11).toFixed(1)}" stroke="${m.col}" stroke-width="2.8"/>`);

        inRange.forEach((v, vi) => {
            const jy = cy + ((vi % 3) - 1) * 4.8;
            out.push(`<circle cx="${xPx(v).toFixed(1)}" cy="${jy.toFixed(1)}" r="3.0" fill="${m.col}" fill-opacity="0.88" stroke="#ffffff" stroke-width="0.7"/>`);
        });

        // Left-edge arrow badge for Member 12 off-scale bonk (-191 to -216m)
        out.push(`<text x="${pad.l + 5}" y="${(cy + 3.5).toFixed(1)}" class="note" fill="${m.col}" font-weight="600">&lt; M12: ${m.m12.toFixed(0)}m</text>`);
    });

    out.push(`<rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${(pad.l + pw / 2).toFixed(1)}" y="${H - 24}" text-anchor="middle" class="axis-label">Signed Prediction Error (Predicted - Actual, min; negative = too fast)</text>`);
    out.push(`<text x="${(pad.l + pw / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" class="note" fill="#64748b">Note: All 22 races (including off-scale Member 12 bonk at -191m to -216m) are included in IQRs, medians, and PenMSE.</text>`);
    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 6: Marginal Density u(D)^gamma (Raw vs. Adj) & Interval Weights
// ---------------------------------------------------------------------------
function buildFigure6() {
    const W = 860;
    const H = 430;
    const pad = { l: 70, r: 52, t: 84, b: 64 };
    const pw = W - pad.l - pad.r;
    const ph = H - pad.t - pad.b;

    const minKm = 5;
    const maxKm = 42.195;
    const lnSpan = Math.log(maxKm / minKm);
    const uOf = (km) => Math.max(0, Math.min(1, Math.log(km / minKm) / lnSpan));
    const xPx = (km) => pad.l + uOf(km) * pw;
    const yPx = (w) => pad.t + (1 - w) * ph;

    const gammaRaw = ML_CLUB_RIEGEL_MODEL.distanceGamma; // 2.8427
    const gammaAdj = 2.1351; // US Full Adj (*_ti_adj)

    const out = [svgHeader(W, H, 'Ricelo-Pace Distance Weighting: Marginal Density and Integral Interval Averages')];
    out.push(`<text x="${pad.l}" y="28" class="title">Ricelo-Pace Integral Distance Weighting: Raw vs. Course-Adjusted γ</text>`);
    out.push(`<text x="${pad.l}" y="46" class="subtitle">Instantaneous marginal density u(D)^γ (curves) and exact path-averaged weights w(D1, D2) (horizontal bars)</text>`);

    out.push(`<line x1="${pad.l}" y1="67" x2="${pad.l + 28}" y2="67" stroke="#0d9488" stroke-width="3.2"/>`);
    out.push(`<text x="${pad.l + 35}" y="71" class="legend" fill="#0f766e" font-weight="600">US Full Raw (γ = 2.843, Production)</text>`);
    out.push(`<line x1="${pad.l + 276}" y1="67" x2="${pad.l + 304}" y2="67" stroke="#d97706" stroke-width="2.4" stroke-dasharray="7 3"/>`);
    out.push(`<text x="${pad.l + 311}" y="71" class="legend" fill="#b45309" font-weight="600">US Full Adj (*_ti_adj, γ = 2.135)</text>`);
    out.push(`<line x1="${pad.l + 544}" y1="67" x2="${pad.l + 572}" y2="67" stroke="#e11d48" stroke-width="3.2"/>`);
    out.push(`<text x="${pad.l + 579}" y="71" class="legend" fill="#be123c" font-weight="600">Integral avg w(D1, D2)</text>`);

    for (let p = 0; p <= 100; p += 25) {
        const py = yPx(p / 100);
        out.push(`<line x1="${pad.l}" y1="${py.toFixed(1)}" x2="${W - pad.r}" y2="${py.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
        out.push(`<text x="${pad.l - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" class="tick">${p}%</text>`);
    }

    const anchors = [
        { km: 5, label: '5K' },
        { km: 10, label: '10K' },
        { km: 16.09, label: '10 mi' },
        { km: 21.0975, label: 'HM (21.1K)' },
        { km: 30, label: '30K' },
        { km: 42.195, label: 'FM (42.2K)' },
    ];
    for (const a of anchors) {
        const px = xPx(a.km);
        out.push(`<line x1="${px.toFixed(1)}" y1="${pad.t}" x2="${px.toFixed(1)}" y2="${H - pad.b}" stroke="#f1f5f9" stroke-width="1"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${H - pad.b + 18}" text-anchor="middle" class="tick">${a.label}</text>`);
    }

    const adjPts = [];
    const rawPts = [];
    for (let i = 0; i <= 100; i += 1) {
        const u = i / 100;
        const px = pad.l + u * pw;
        adjPts.push(`${px.toFixed(1)},${yPx(Math.pow(u, gammaAdj)).toFixed(1)}`);
        rawPts.unshift(`${px.toFixed(1)},${yPx(Math.pow(u, gammaRaw)).toFixed(1)}`);
    }
    out.push(`<polygon points="${adjPts.concat(rawPts).join(' ')}" fill="#fef3c7" fill-opacity="0.38"/>`);
    out.push(`<polyline fill="none" stroke="#d97706" stroke-width="2.4" stroke-dasharray="7 3" points="${adjPts.join(' ')}"/>`);
    out.push(`<polyline fill="none" stroke="#0d9488" stroke-width="3.2" points="${rawPts.slice().reverse().join(' ')}"/>`);

    // Exact path-averaged interval weights w(D1, D2) under Production γ = 2.8427
    const intervals = [
        { d1: 5, d2: 10, label: '5K->10K: 1.1%', labelKm: 7.0, dy: -9 },
        { d1: 10, d2: 21.0975, label: '10K->HM: 15.4%', labelKm: 18.8, dy: 15 },
        { d1: 21.0975, d2: 42.195, label: 'HM->FM: 62.4%', labelKm: 24.0, dy: -9 },
        { d1: 5, d2: 42.195, label: '5K->FM integral avg: 26.0%', labelKm: 8.4, dy: -8, dashed: true },
    ];
    for (const iv of intervals) {
        const w = integralDistanceWeight(iv.d1 * 1000, iv.d2 * 1000, gammaRaw);
        const py = yPx(w);
        const x1 = xPx(iv.d1);
        const x2 = xPx(iv.d2);
        out.push(`<line x1="${x1.toFixed(1)}" y1="${py.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${py.toFixed(1)}" stroke="#e11d48" stroke-width="${iv.dashed ? 1.8 : 3.0}" ${iv.dashed ? 'stroke-dasharray="5 3"' : ''}/>`);
        out.push(`<circle cx="${x1.toFixed(1)}" cy="${py.toFixed(1)}" r="3.2" fill="#e11d48"/>`);
        out.push(`<circle cx="${x2.toFixed(1)}" cy="${py.toFixed(1)}" r="3.2" fill="#e11d48"/>`);
        const midX = xPx(iv.labelKm);
        out.push(`<text x="${midX.toFixed(1)}" y="${(py + iv.dy).toFixed(1)}" text-anchor="middle" class="badge" fill="#be123c">${esc(iv.label)}</text>`);
    }

    out.push(`<text x="${xPx(16.5).toFixed(1)}" y="${yPx(0.57).toFixed(1)}" text-anchor="middle" class="note" fill="#92400e" font-weight="600">Course adjustment alone shifts</text>`);
    out.push(`<text x="${xPx(16.5).toFixed(1)}" y="${(yPx(0.57) + 14).toFixed(1)}" text-anchor="middle" class="note" fill="#92400e">γ from 2.84 (raw) to 2.14 (adj)</text>`);

    out.push(`<rect x="${pad.l}" y="${pad.t}" width="${pw}" height="${ph}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${(pad.l + pw / 2).toFixed(1)}" y="${H - 16}" text-anchor="middle" class="axis-label">Race Distance D (log scale; 5K to Full Marathon)</text>`);
    out.push(`<text x="20" y="${(pad.t + ph / 2).toFixed(1)}" text-anchor="middle" class="axis-label" transform="rotate(-90 20 ${(pad.t + ph / 2).toFixed(1)})">Share of Marginal FM Penalty Δ_mar(V) (%)</text>`);
    out.push('</svg>');
    return out.join('\n');
}

// ---------------------------------------------------------------------------
// Figure 7: Practical Pacing Impact (20..160 km/wk)
// ---------------------------------------------------------------------------
function buildFigure7() {
    const W = 900;
    const H = 440;
    const out = [svgHeader(W, H, 'Practical Pacing Predictions Across Weekly Mileage')];
    out.push('<text x="36" y="28" class="title">Practical Pacing Impact of Ricelo-Pace Across Weekly Mileage (20 to 160 km/wk)</text>');
    out.push('<text x="36" y="46" class="subtitle">Concrete race targets for a 2:00:00 HM runner targeting FM (left) and a 1:00:00 10K runner targeting HM (right)</text>');

    const p1 = { l: 74, r: 468, t: 88, b: 374 };
    const p1w = p1.r - p1.l;
    const p1h = p1.b - p1.t;
    const x1 = (v) => p1.l + ((v - 20) / 140) * p1w;
    const y1Min = 240;
    const y1Max = 282;
    const y1 = (m) => p1.t + ((y1Max - m) / (y1Max - y1Min)) * p1h;

    out.push(`<text x="${((p1.l + p1.r) / 2).toFixed(1)}" y="74" text-anchor="middle" class="badge" fill="#0f172a">A. Full Marathon from 2:00:00 HM</text>`);
    for (let m = 245; m <= 280; m += 5) {
        const py = y1(m);
        out.push(`<line x1="${p1.l}" y1="${py.toFixed(1)}" x2="${p1.r}" y2="${py.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
        out.push(`<text x="${p1.l - 8}" y="${(py + 4).toFixed(1)}" text-anchor="end" class="tick">${fmtHM(m)}</text>`);
    }
    for (const v of [20, 50, 80, 110, 140, 160]) {
        const px = x1(v);
        out.push(`<line x1="${px.toFixed(1)}" y1="${p1.t}" x2="${px.toFixed(1)}" y2="${p1.b}" stroke="#f1f5f9" stroke-width="1"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${p1.b + 18}" text-anchor="middle" class="tick">${v}</text>`);
    }

    const r106Fm = predictRiegelSeconds(7200, 21097.5, 42195, 1.06) / 60;
    out.push(`<line x1="${p1.l}" y1="${y1(r106Fm).toFixed(1)}" x2="${p1.r}" y2="${y1(r106Fm).toFixed(1)}" stroke="#64748b" stroke-width="1.6" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${p1.l + 8}" y="${(y1(r106Fm) - 6).toFixed(1)}" class="note" fill="#475569">Classic Riegel 1.06 (4:10:12)</text>`);

    const fmPts = [];
    const vvPts = [];
    const cvvPts = [];
    for (let v = 20; v <= 160; v += 2) {
        const expFm = computeMileageAdjustedExponent({ avgWeeklyKm: v, refMeters: 21097.5, targetMeters: 42195 }).exact_exponent;
        const fmM = (7200 * Math.pow(42195 / 21097.5, expFm)) / 60;
        const vvM = predictVickersVertosickModel1Seconds({ basisSeconds: 7200, basisMeters: 21097.5, avgWeeklyKm: v }) / 60;
        const cvvM = predictClampedVickersVertosickSeconds({ basisSeconds: 7200, basisMeters: 21097.5, avgWeeklyKm: v }) / 60;
        fmPts.push(`${x1(v).toFixed(1)},${y1(fmM).toFixed(1)}`);
        if (vvM >= y1Min) vvPts.push(`${x1(v).toFixed(1)},${y1(vvM).toFixed(1)}`);
        cvvPts.push(`${x1(v).toFixed(1)},${y1(cvvM).toFixed(1)}`);
    }
    out.push(`<polyline fill="none" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="2 2" points="${cvvPts.join(' ')}"/>`);
    out.push(`<polyline fill="none" stroke="#d97706" stroke-width="2.2" stroke-dasharray="5 3" points="${vvPts.join(' ')}"/>`);
    out.push(`<polyline fill="none" stroke="#e11d48" stroke-width="3.2" points="${fmPts.join(' ')}"/>`);

    out.push(`<text x="${x1(105).toFixed(1)}" y="${(y1(269.5)).toFixed(1)}" text-anchor="middle" class="direct-label" fill="#be123c">Ricelo-Pace</text>`);
    out.push(`<text x="${x1(105).toFixed(1)}" y="${(y1(266.2)).toFixed(1)}" text-anchor="middle" class="note" fill="#be123c">4:29 at 40k | 4:24 at 65k | 4:19 at 100k</text>`);
    out.push(`<text x="${x1(112).toFixed(1)}" y="${(y1(243.8)).toFixed(1)}" text-anchor="middle" class="note" fill="#92400e" font-weight="600">V&amp;V drops below 4:10 past 82 km/wk</text>`);

    out.push(`<rect x="${p1.l}" y="${p1.t}" width="${p1w}" height="${p1h}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${((p1.l + p1.r) / 2).toFixed(1)}" y="${H - 16}" text-anchor="middle" class="axis-label">Weekly Mileage (km / week)</text>`);

    const p2 = { l: 544, r: 862, t: 88, b: 374 };
    const p2w = p2.r - p2.l;
    const p2h = p2.b - p2.t;
    const x2 = (v) => p2.l + ((v - 20) / 140) * p2w;
    const y2Min = 131.6;
    const y2Max = 137.0;
    const y2 = (m) => p2.t + ((y2Max - m) / (y2Max - y2Min)) * p2h;

    out.push(`<text x="${((p2.l + p2.r) / 2).toFixed(1)}" y="74" text-anchor="middle" class="badge" fill="#0f172a">B. Half Marathon from 1:00:00 10K</text>`);
    for (let m = 132; m <= 137; m += 1) {
        const py = y2(m);
        out.push(`<line x1="${p2.l}" y1="${py.toFixed(1)}" x2="${p2.r}" y2="${py.toFixed(1)}" stroke="#e2e8f0" stroke-width="1"/>`);
        out.push(`<text x="${p2.l - 8}" y="${(py + 4).toFixed(1)}" text-anchor="end" class="tick">${fmtHM(m)}</text>`);
    }
    for (const v of [20, 50, 80, 110, 140, 160]) {
        const px = x2(v);
        out.push(`<line x1="${px.toFixed(1)}" y1="${p2.t}" x2="${px.toFixed(1)}" y2="${p2.b}" stroke="#f1f5f9" stroke-width="1"/>`);
        out.push(`<text x="${px.toFixed(1)}" y="${p2.b + 18}" text-anchor="middle" class="tick">${v}</text>`);
    }

    const r106Hm = (3600 * Math.pow(21097.5 / 10000, 1.06)) / 60;
    const r107Hm = (3600 * Math.pow(21097.5 / 10000, 1.07)) / 60;
    out.push(`<line x1="${p2.l}" y1="${y2(r106Hm).toFixed(1)}" x2="${p2.r}" y2="${y2(r106Hm).toFixed(1)}" stroke="#64748b" stroke-width="1.6" stroke-dasharray="6 4"/>`);
    out.push(`<text x="${p2.l + 8}" y="${(y2(r106Hm) - 5).toFixed(1)}" text-anchor="start" class="note" fill="#475569">Classic Riegel 1.06 (2:12:23)</text>`);
    out.push(`<line x1="${p2.l}" y1="${y2(r107Hm).toFixed(1)}" x2="${p2.r}" y2="${y2(r107Hm).toFixed(1)}" stroke="#94a3b8" stroke-width="1.6" stroke-dasharray="3 3"/>`);
    out.push(`<text x="${p2.r - 8}" y="${(y2(r107Hm) - 5).toFixed(1)}" text-anchor="end" class="note" fill="#64748b">Fixed Riegel 1.07 (2:13:23)</text>`);

    const hmPts = [];
    for (let v = 20; v <= 160; v += 2) {
        const expHm = computeMileageAdjustedExponent({ avgWeeklyKm: v, refMeters: 10000, targetMeters: 21097.5 }).exact_exponent;
        const m = (3600 * Math.pow(21097.5 / 10000, expHm)) / 60;
        hmPts.push(`${x2(v).toFixed(1)},${y2(m).toFixed(1)}`);
    }
    out.push(`<polyline fill="none" stroke="#0d9488" stroke-width="3.2" points="${hmPts.join(' ')}"/>`);

    out.push(`<text x="${x2(105).toFixed(1)}" y="${(y2(136.05)).toFixed(1)}" text-anchor="middle" class="direct-label" fill="#0f766e">Ricelo-Pace (γ = 2.84)</text>`);
    out.push(`<text x="${x2(105).toFixed(1)}" y="${(y2(135.62)).toFixed(1)}" text-anchor="middle" class="note" fill="#0f766e">2:16:07 at 20k | 2:14:41 at 50k | 2:13:36 at 100k</text>`);
    out.push(`<text x="${x2(78).toFixed(1)}" y="${(y2(132.85)).toFixed(1)}" text-anchor="middle" class="note" fill="#64748b">Crosses 1.07 near 116 km/wk</text>`);

    out.push(`<rect x="${p2.l}" y="${p2.t}" width="${p2w}" height="${p2h}" fill="none" stroke="#94a3b8" stroke-width="1"/>`);
    out.push(`<text x="${((p2.l + p2.r) / 2).toFixed(1)}" y="${H - 16}" text-anchor="middle" class="axis-label">Weekly Mileage (km / week)</text>`);
    out.push('</svg>');
    return out.join('\n');
}

function main() {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    const figures = [
        ['fig1-exponent-curves.svg', buildFigure1()],
        ['fig2-us-hm-tiers.svg', buildFigure2()],
        ['fig3-cross-continental-penmse.svg', buildFigure3()],
        ['fig4-club-zeroshot-scatter.svg', buildFigure4()],
        ['fig5-club-residuals.svg', buildFigure5()],
        ['fig6-climate-gamma-ramp.svg', buildFigure6()],
        ['fig7-practical-pacing-impact.svg', buildFigure7()],
    ];
    for (const [name, svg] of figures) {
        const dest = path.join(OUT_DIR, name);
        fs.writeFileSync(dest, `${svg}\n`, 'utf8');
        process.stdout.write(`Wrote ${path.relative(process.cwd(), dest)} (${svg.length} bytes)\n`);
    }
}

if (require.main === module) {
    main();
}
