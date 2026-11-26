const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const {
    parseXlsxBuffer,
    parseCsvText,
    extractTargetPairs,
    extractDownwardFmToHmPairs,
    predictEndpointExponent,
    predictIntegralExponentV22,
    predictTimeSeconds,
    predictVickersVertosickModel1Seconds,
    predictClampedVickersVertosickSeconds,
    fitJointIntegralHuber,
    fitStage1FmIrls,
    fitStage2Gamma,
    summarizeErrors,
    pairedBootstrap,
    clusteredPairedBootstrap,
    auditMonotonicity,
    runUsBenchmark,
    formatUsReportMarkdown,
    parseArgs,
} = require('../scripts/reproduceUsBenchmark');

function assertClose(actual, expected, tol = 1e-6, msg = '') {
    assert.ok(
        Math.abs(actual - expected) <= tol,
        `${msg || 'assertClose'}: expected ${actual} to be within ${tol} of ${expected}`,
    );
}

// Build a minimal real compressed (Deflate) ZIP/XLSX archive in memory for testing.
function buildZip(entries) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const [name, text] of entries) {
        const nameBuf = Buffer.from(name, 'utf8');
        const rawBuf = Buffer.from(text, 'utf8');
        const compBuf = zlib.deflateRawSync(rawBuf);

        const local = Buffer.alloc(30 + nameBuf.length);
        local.writeUInt32LE(0x04034b50, 0);
        local.writeUInt16LE(20, 4);
        local.writeUInt16LE(0, 6);
        local.writeUInt16LE(8, 8);
        local.writeUInt32LE(compBuf.length, 18);
        local.writeUInt32LE(rawBuf.length, 22);
        local.writeUInt16LE(nameBuf.length, 26);
        local.writeUInt16LE(0, 28);
        nameBuf.copy(local, 30);

        localParts.push(local, compBuf);

        const central = Buffer.alloc(46 + nameBuf.length);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0, 8);
        central.writeUInt16LE(8, 10);
        central.writeUInt32LE(compBuf.length, 20);
        central.writeUInt32LE(rawBuf.length, 24);
        central.writeUInt16LE(nameBuf.length, 28);
        central.writeUInt16LE(0, 30);
        central.writeUInt16LE(0, 32);
        central.writeUInt32LE(offset, 42);
        nameBuf.copy(central, 46);

        centralParts.push(central);
        offset += local.length + compBuf.length;
    }

    const centralBuf = Buffer.concat(centralParts);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(centralBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...localParts, centralBuf, eocd]);
}

function buildSyntheticIntegralUsRows() {
    const b0 = 0.36;
    const b1 = 0.068;
    const gamma = 2.2;
    const rows = [];
    const mileages = [15, 22, 30, 38, 45, 55, 72, 90];

    let id = 1;
    for (let rep = 0; rep < 6; rep++) {
        for (let mIdx = 0; mIdx < mileages.length; mIdx++) {
            const typical = mileages[mIdx];
            const volKm = typical * 1.609344;
            const group = (id % 3) + 1;
            const k5 = 1150 + mIdx * 40 + rep * 25;
            const k10Exp = predictIntegralExponentV22({ volKm, basisMeters: 5000, targetMeters: 10000, b0, b1, gamma });
            const k10 = Math.round(k5 * Math.pow(10000 / 5000, k10Exp));
            const hmExp = predictIntegralExponentV22({ volKm, basisMeters: 10000, targetMeters: 21097.5, b0, b1, gamma });
            const mh = Math.round(k10 * Math.pow(21097.5 / 10000, hmExp));
            const fmExp = predictIntegralExponentV22({ volKm, basisMeters: 21097.5, targetMeters: 42195, b0, b1, gamma });
            const mf = Math.round(mh * Math.pow(42195 / 21097.5, fmExp));

            const hasHm = rep < 5;
            const has10k = rep < 5;
            const basisSec = hasHm ? mh : k5;
            const basisM = hasHm ? 21097.5 : 5000;
            const t107 = basisSec * Math.pow(42195 / basisM, 1.07);
            const v = 42195 / t107;
            const vAdj = 0.16018617 + 0.83076202 * v + 0.06423826 * (typical / 10);
            const model1Time = (42195 / vAdj) / 60;

            rows.push({
                id,
                group,
                typical,
                k5_ti: k5,
                k10_ti: has10k ? k10 : null,
                mh_ti: hasHm ? mh : null,
                mf_ti: mf,
                k5_ti_adj: k5,
                k10_ti_adj: has10k ? k10 : null,
                mh_ti_adj: hasHm ? mh : null,
                mf_ti_adj: mf,
                model1_time: group === 3 ? model1Time : null,
            });
            id += 1;
        }
    }
    return rows;
}

test('parses compressed XLSX archives with shared strings and sparse cells cleanly', () => {
    const sharedStringsXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<sst><si><t>id</t></si><si><t>typical</t></si><si><t>mh_ti</t></si><si><t>mf_ti</t></si><si><t>note</t></si></sst>',
    ].join('');
    const sheetXml = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<worksheet><sheetData>',
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c><c r="E1" t="s"><v>4</v></c></row>',
        '<row r="2"><c r="A2"><v>470</v></c><c r="B2"><v>84</v></c><c r="D2"><v>14820</v></c><c r="E2" t="inlineStr"><is><t>A &amp; B</t></is></c></row>',
        '</sheetData></worksheet>',
    ].join('');

    const xlsx = buildZip([
        ['xl/sharedStrings.xml', sharedStringsXml],
        ['xl/worksheets/sheet1.xml', sheetXml],
    ]);
    const rows = parseXlsxBuffer(xlsx);
    assert.deepEqual(rows, [
        { id: 470, typical: 84, mh_ti: null, mf_ti: 14820, note: 'A & B' },
    ]);
});

test('parses CSV text with empty and NA fields into numeric/null objects', () => {
    const csv = 'id,group,typical,mh_ti,mf_ti\n1,3,40,6000,13200\n2,1,25,NA,\n';
    assert.deepEqual(parseCsvText(csv), [
        { id: 1, group: 3, typical: 40, mh_ti: 6000, mf_ti: 13200 },
        { id: 2, group: 1, typical: 25, mh_ti: null, mf_ti: null },
    ]);
});

test('guarantees exact bidirectionality, multi-step transitivity across [3K..50K], and natural uncapped 1.06 elite floor', () => {
    const b0 = 0.5413;
    const b1 = 0.1002;
    const gamma = 2.8427;
    const volKm = 38.2;

    const xUp = predictIntegralExponentV22({ volKm, basisMeters: 21097.5, targetMeters: 42195, b0, b1, gamma });
    const xDown = predictIntegralExponentV22({ volKm, basisMeters: 42195, targetMeters: 21097.5, b0, b1, gamma });
    assertClose(xUp, xDown, 1e-12, 'bidirectionality');

    // Runner D: FM 4:54:17 -> 5K -> HM === FM -> HM
    const tFm = 4 * 3600 + 54 * 60 + 17;
    const tHmDirect = predictTimeSeconds(
        tFm,
        42195,
        21097.5,
        predictIntegralExponentV22({ volKm, basisMeters: 42195, targetMeters: 21097.5, b0, b1, gamma }),
    );
    const t5kFromFm = predictTimeSeconds(
        tFm,
        42195,
        5000,
        predictIntegralExponentV22({ volKm, basisMeters: 42195, targetMeters: 5000, b0, b1, gamma }),
    );
    const tHmVia5k = predictTimeSeconds(
        t5kFromFm,
        5000,
        21097.5,
        predictIntegralExponentV22({ volKm, basisMeters: 5000, targetMeters: 21097.5, b0, b1, gamma }),
    );
    assertClose(tHmVia5k, tHmDirect, 1e-9, 'Runner D FM->5K->HM transitivity');

    // Multi-hop chain extending outside [5K, FM]
    const hops = [3000, 5000, 10000, 21097.5, 42195, 50000];
    let tChain = 700;
    for (let i = 0; i < hops.length - 1; i++) {
        const x = predictIntegralExponentV22({ volKm, basisMeters: hops[i], targetMeters: hops[i + 1], b0, b1, gamma });
        tChain = predictTimeSeconds(tChain, hops[i], hops[i + 1], x);
    }
    const tDirect3kTo50k = predictTimeSeconds(
        700,
        3000,
        50000,
        predictIntegralExponentV22({ volKm, basisMeters: 3000, targetMeters: 50000, b0, b1, gamma }),
    );
    assertClose(tChain, tDirect3kTo50k, 1e-8, '3K->5K->10K->HM->FM->50K transitivity');

    // Uncapped mileage decays smoothly past 110 km/wk and reaches exact 1.06 above 222.2 km/wk
    const x110 = predictIntegralExponentV22({ volKm: 110, basisMeters: 21097.5, targetMeters: 42195, b0, b1, gamma });
    const x150 = predictIntegralExponentV22({ volKm: 150, basisMeters: 21097.5, targetMeters: 42195, b0, b1, gamma });
    const x230 = predictIntegralExponentV22({ volKm: 230, basisMeters: 21097.5, targetMeters: 42195, b0, b1, gamma });
    assert.ok(x150 < x110);
    assert.ok(x150 > 1.06);
    assert.equal(x230, 1.06);
});

test('recovers exact synthetic (b0, b1, gamma) jointly and verifies Clamped V&V + Ricelo-Pace monotonicity', () => {
    const rows = buildSyntheticIntegralUsRows();
    const fmPairs = extractTargetPairs(rows, 'mf');
    const hmPairs = extractTargetPairs(rows, 'mh');

    const fit = fitJointIntegralHuber(fmPairs, hmPairs);
    assertClose(fit.b0, 0.36, 0.01, 'b0 recovery');
    assertClose(fit.b1, 0.068, 0.002, 'b1 recovery');
    assertClose(fit.gamma, 2.2, 0.1, 'gamma recovery');
    assert.ok(fit.maxGrad < 1e-4);

    // Slow high-mileage runner (id=470: 1:19:00 10K on 84 mi/wk) triggers V&V sub-1.00 failure
    const slowHighMileage = [{
        typicalMiles: 84,
        basisMeters: 10000,
        basisSeconds: 79 * 60,
        targetMeters: 42195,
        avgWeeklyKm: 84 * 1.609344,
        r: Math.log(42195 / 10000),
    }];
    const vvAudit = auditMonotonicity(slowHighMileage, (p) => predictVickersVertosickModel1Seconds(p));
    assert.equal(vvAudit.sub106, 1);
    assert.equal(vvAudit.sub100, 1);

    const clampedAudit = auditMonotonicity(slowHighMileage, (p) => predictClampedVickersVertosickSeconds(p));
    assert.equal(clampedAudit.sub106, 0);
    assert.equal(clampedAudit.sub100, 0);

    const rpAudit = auditMonotonicity(slowHighMileage, (p) => predictTimeSeconds(
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
    ));
    assert.equal(rpAudit.sub106, 0);
    assert.equal(rpAudit.sub100, 0);

    const s1 = fitStage1FmIrls(fmPairs);
    const s2 = fitStage2Gamma(hmPairs, { b0: s1.b0, b1: s1.b1 });
    assert.ok(s1.b0 > 0 && s2.gamma > 0.2);
    assert.ok(predictEndpointExponent({ volKm: 40, basisMeters: 21097.5, targetMeters: 42195, b0: s1.b0, b1: s1.b1, gamma: s2.gamma }) >= 1.06);
});

test('runs full US benchmark including Clamped V&V, FM->HM downward test, stratifications, Huber check, and Runner D transitivity', () => {
    const rows = buildSyntheticIntegralUsRows();
    const downPairs = extractDownwardFmToHmPairs(rows);
    assert.equal(downPairs.length, 40);

    const report = runUsBenchmark(rows, { boot: 100, seed: 42 });

    assert.equal(report.counts.fmRawAll, 48);
    assert.equal(report.counts.hmRawAll, 40);
    assert.equal(report.counts.fmToHmRawAll, 40);
    assert.equal(report.counts.fmRawOver110Km, 12);
    assert.equal(report.vvParity.n, 16);
    assert.ok(report.vvParity.maxAbsDiffMin < 1e-9);

    assert.ok(report.heldOutG3.fmAdj.riceloV22.mae < 0.15);
    assert.ok(report.heldOutG3.fmAdj.vvClamped);
    assert.ok(report.heldOutG3.hmAdj.directHm2Param);
    assert.ok(report.heldOutG3.downwardFmToHmAdj.riceloV22.mae < 0.15);
    assert.ok(report.heldOutG3.downwardFmToHmAdj.riceloV22.mae < report.heldOutG3.downwardFmToHmAdj.r106.mae);

    assert.ok(Math.abs(report.runnerDTransitivityCheck.v21Endpoint.contradictionSec) > 120);
    assert.ok(Math.abs(report.runnerDTransitivityCheck.v22Integral.contradictionSec) < 1e-5);
    assert.equal(report.huberSensitivity.length, 5);

    const md = formatUsReportMarkdown(report);
    assert.ok(md.includes('# Ricelo-Pace: US Calibration'));
    assert.ok(md.includes('Quantitative Downward Conversion Validation: FM -> HM'));
    assert.ok(!md.includes('v2.2'));
    assert.ok(!md.includes('v2.1'));
    assert.ok(!md.includes('NaN'));

    const summary = summarizeErrors([-10, -5, 0, 5, 10]);
    assertClose(summary.vvMse, 50, 1e-9);
    assertClose(summary.vvPenMse, 75, 1e-9);

    const bootA = pairedBootstrap([-1, -1, -1, -1], [-5, -5, -5, -5], { resamples: 100, seed: 7 });
    assertClose(bootA.mae.diff, -4, 1e-9);

    const cBoot = clusteredPairedBootstrap(
        [
            { clusterId: 'a1', errA: -1, errB: -6 },
            { clusterId: 'a1', errA: -2, errB: -7 },
            { clusterId: 'a2', errA: 1, errB: -5 },
        ],
        { resamples: 100, seed: 9 },
    );
    assert.equal(cBoot.clusters, 2);
    assert.equal(cBoot.n, 3);
    assert.ok(cBoot.mae.diff < 0);

    assert.deepEqual(parseArgs(['--file=/tmp/data.xlsx', '--boot=5000', '--json']), {
        file: '/tmp/data.xlsx',
        boot: 5000,
        seed: 20261124,
        json: true,
    });
});
