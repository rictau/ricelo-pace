(() => {
  'use strict';

  const B0 = 0.5413;
  const B1 = 0.1002;
  const GAMMA = 2.8427;
  const KM_PER_MILE = 1.609344;
  const D_MIN_KM = 5.0;
  const D_MAR_KM = 42.195;
  const LOG_SPAN = Math.log(D_MAR_KM / D_MIN_KM);
  const BALKE_SEC = 900;

  const STANDARD_RACES = [
    { key: '5k', label: '5K', tableLabel: '5K', short: '5K', km: 5.0 },
    { key: '10k', label: '10K', tableLabel: '10K', short: '10K', km: 10.0 },
    { key: '15k', label: '15K', tableLabel: '15K', short: '15K', km: 15.0 },
    { key: 'hm', label: 'Half Marathon', tableLabel: 'Half', short: 'HM', km: 21.0975 },
    { key: 'fm', label: 'Full Marathon', tableLabel: 'Full', short: 'FM', km: 42.195 },
  ];

  function psi(dKm) {
    if (dKm <= D_MIN_KM) return 0;
    if (dKm < D_MAR_KM) {
      const u = Math.log(dKm / D_MIN_KM) / LOG_SPAN;
      return (LOG_SPAN / (GAMMA + 1)) * Math.pow(u, GAMMA + 1);
    }
    return LOG_SPAN / (GAMMA + 1) + Math.log(dKm / D_MAR_KM);
  }

  function intervalWeight(d1Km, d2Km) {
    if (Math.abs(d1Km - d2Km) < 1e-9) return 0;
    return (psi(d2Km) - psi(d1Km)) / Math.log(d2Km / d1Km);
  }

  function deltaMar(vKmWeek) {
    const vSafe = Math.max(10, vKmWeek);
    return Math.max(0, B0 - B1 * Math.log(vSafe));
  }

  function predictSeconds(t1Sec, d1Km, d2Km, vKmWeek) {
    if (Math.abs(d1Km - d2Km) < 1e-9) {
      return { sec: t1Sec, riegelSec: t1Sec, exp: 1.06, weight: 0 };
    }
    const weight = intervalWeight(d1Km, d2Km);
    const exp = 1.06 + weight * deltaMar(vKmWeek);
    const ratio = d2Km / d1Km;
    return {
      sec: t1Sec * Math.pow(ratio, exp),
      riegelSec: t1Sec * Math.pow(ratio, 1.06),
      exp,
      weight,
    };
  }

  function formatDuration(totalSec) {
    const rounded = Math.round(totalSec);
    const hh = Math.floor(rounded / 3600);
    const mm = Math.floor((rounded % 3600) / 60);
    const ss = rounded % 60;
    if (hh > 0) {
      return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
    }
    return `${mm}:${String(ss).padStart(2, '0')}`;
  }

  function formatSignedDelta(deltaSec) {
    const rounded = Math.round(deltaSec);
    if (Math.abs(rounded) <= 1) return '0:00';
    const sign = rounded > 0 ? '+' : '-';
    const abs = Math.abs(rounded);
    const hh = Math.floor(abs / 3600);
    const mm = Math.floor((abs % 3600) / 60);
    const ss = abs % 60;
    const body = hh > 0
      ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
      : `${mm}:${String(ss).padStart(2, '0')}`;
    return `${sign}${body}`;
  }

  function formatPace(totalSec, distKm, unit) {
    const secPerUnit = unit === 'mi' ? totalSec / (distKm / KM_PER_MILE) : totalSec / distKm;
    const rounded = Math.round(secPerUnit);
    const mm = Math.floor(rounded / 60);
    const ss = rounded % 60;
    return `${mm}:${String(ss).padStart(2, '0')}/${unit}`;
  }

  function secPerUnit(totalSec, distKm, unit) {
    return unit === 'mi' ? totalSec / (distKm / KM_PER_MILE) : totalSec / distKm;
  }

  function formatPaceDelta(deltaSec, unit) {
    const rounded = Math.round(deltaSec);
    if (rounded === 0) return `0s/${unit}`;
    const sign = rounded > 0 ? '+' : '-';
    const abs = Math.abs(rounded);
    const body = abs < 60 ? `${abs}s` : `${Math.floor(abs / 60)}:${String(abs % 60).padStart(2, '0')}`;
    return `${sign}${body}/${unit}`;
  }

  function calculateVdot(distMeters, durationSec) {
    if (distMeters <= 0 || durationSec <= 0) return 0;
    const tMin = durationSec / 60;
    const vMpm = distMeters / tMin;
    const vo2 = -4.60 + 0.182258 * vMpm + 0.000104 * vMpm * vMpm;
    const pctMax = 0.8 + 0.1894393 * Math.exp(-0.012778 * tMin) + 0.2989558 * Math.exp(-0.1932605 * tMin);
    return pctMax > 0 ? vo2 / pctMax : 0;
  }

  function solveVdotVelocity(targetVo2) {
    const a = 0.000104;
    const b = 0.182258;
    const c = -(targetVo2 + 4.60);
    const disc = b * b - 4 * a * c;
    return disc < 0 ? 0 : (-b + Math.sqrt(disc)) / (2 * a);
  }

  function formatPaceFromMpm(vMpm, unit) {
    if (!Number.isFinite(vMpm) || vMpm <= 0) return 'N/A';
    const secPerKm = 60000 / vMpm;
    const secPerU = unit === 'mi' ? secPerKm * KM_PER_MILE : secPerKm;
    const rounded = Math.round(secPerU);
    const mm = Math.floor(rounded / 60);
    const ss = rounded % 60;
    return `${mm}:${String(ss).padStart(2, '0')}/${unit}`;
  }

  function parseQueryTime(raw) {
    const str = String(raw || '').trim();
    if (!str) return null;
    const parts = str.split(':').map((p) => p.trim());
    if (parts.some((p) => !/^\d+$/.test(p))) return null;
    if (parts.length === 2) {
      const [mm, ss] = parts.map(Number);
      if (mm > 59 || ss > 59) return null;
      return { hh: 0, mm, ss };
    }
    if (parts.length === 3) {
      const [hh, mm, ss] = parts.map(Number);
      if (hh > 23 || mm > 59 || ss > 59) return null;
      return { hh, mm, ss };
    }
    return null;
  }

  const form = document.getElementById('ricelo-form');
  const distanceRadios = Array.from(document.querySelectorAll('input[name="basisDistance"]'));
  const customGroup = document.getElementById('custom-distance-group');
  const customInput = document.getElementById('custom-distance-km');
  const customError = document.getElementById('custom-distance-error');

  const balkeGroup = document.getElementById('balke-group');
  const balkeInput = document.getElementById('balke-distance');
  const balkeUnitRadios = Array.from(document.querySelectorAll('input[name="balkeUnit"]'));
  const balkeError = document.getElementById('balke-error');

  const targetRadios = Array.from(document.querySelectorAll('input[name="targetDistance"]'));
  const targetCustomGroup = document.getElementById('target-custom-group');
  const targetCustomInput = document.getElementById('target-custom-km');
  const targetCustomError = document.getElementById('target-custom-error');

  const timeFieldset = document.getElementById('time-fieldset');
  const timeHh = document.getElementById('time-hh');
  const timeMm = document.getElementById('time-mm');
  const timeSs = document.getElementById('time-ss');
  const timeInputs = [timeHh, timeMm, timeSs];
  const timeError = document.getElementById('race-time-error');

  const unitRadios = Array.from(document.querySelectorAll('input[name="volumeUnit"]'));
  const volumeSlider = document.getElementById('weekly-volume-slider');
  const volumeInput = document.getElementById('weekly-volume');
  const volumeError = document.getElementById('weekly-volume-error');

  const heroTargetLabel = document.getElementById('hero-target-label');
  const heroTargetTime = document.getElementById('hero-target-time');
  const heroPaceValue = document.getElementById('hero-pace-value');
  const heroFadeLabel = document.getElementById('hero-fade-label');
  const heroFadeValue = document.getElementById('hero-fade-value');
  const heroFadeNote = document.getElementById('hero-fade-note');
  const heroDeltaValue = document.getElementById('hero-delta-value');
  const baseNote = document.getElementById('fm-base-note');
  const tbody = document.getElementById('predictions-tbody');
  const zonesTbody = document.getElementById('zones-tbody');
  const zonesNote = document.getElementById('zones-note');
  const curvePanel = document.getElementById('curve-panel');
  const curveSummaryTitle = document.getElementById('curve-summary-title');
  const curveSvg = document.getElementById('live-curve-svg');
  const shareBtn = document.getElementById('share-link-btn');
  const copyToast = document.getElementById('copy-status');
  const formulaDetails = document.getElementById('pocket-formula');
  const formulaNavLink = document.getElementById('formula-nav-link');
  const weightListItems = Array.from(document.querySelectorAll('#weight-list li'));
  const shortcutHeading = document.getElementById('shortcut-heading');
  const shortcutEquation = document.getElementById('shortcut-equation');
  const excelPairHeading = document.getElementById('excel-pair-heading');
  const excelPairHint = document.getElementById('excel-pair-hint');
  const excelSnippet = document.getElementById('excel-snippet');

  const announcer = document.createElement('div');
  announcer.setAttribute('aria-live', 'polite');
  announcer.className = 'visually-hidden';
  document.body.appendChild(announcer);
  let announceTimer = 0;

  const dirty = new Set();
  let userPickedTarget = false;

  // Typical recreational times for each Recent Effort preset. Applied when the
  // runner switches distance, but only while the time box still holds a preset
  // (never over a time they typed or loaded from a shared link).
  const DEFAULT_TIMES = {
    5: { hh: 0, mm: 25, ss: 0 },
    10: { hh: 0, mm: 55, ss: 0 },
    21.0975: { hh: 2, mm: 0, ss: 0 },
    42.195: { hh: 4, mm: 30, ss: 0 },
  };
  let timeIsPreset = true;

  form.querySelectorAll('input[type="text"]').forEach((el) => {
    el.setAttribute('aria-invalid', 'false');
  });

  function linkError(el, shown) {
    const errorId = el.dataset.error;
    if (!errorId) return;
    const ids = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .filter((id) => id && id !== errorId);
    if (shown) ids.push(errorId);
    if (ids.length) el.setAttribute('aria-describedby', ids.join(' '));
    else el.removeAttribute('aria-describedby');
  }

  function renderErrorNode(errorEl, msg) {
    errorEl.textContent = '';
    if (!msg) return;
    const icon = document.createElement('span');
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', 'Error');
    icon.textContent = '\u26A0 ';
    errorEl.append(icon, document.createTextNode(msg));
  }

  function announceErrorMessage(msg) {
    window.clearTimeout(announceTimer);
    announcer.textContent = '';
    if (!msg) return;
    announceTimer = window.setTimeout(() => {
      announcer.textContent = `Error: ${msg}`;
    }, 500);
  }

  function setSingleFieldError(inputEl, errorEl, msg, announce = false) {
    renderErrorNode(errorEl, msg);
    const invalid = Boolean(msg);
    inputEl.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    inputEl.classList.toggle('user-invalid-fallback', invalid);
    inputEl.setCustomValidity(msg || '');
    linkError(inputEl, invalid);
    if (invalid && announce) announceErrorMessage(msg);
  }

  function clearTimeErrors() {
    renderErrorNode(timeError, '');
    timeInputs.forEach((el) => {
      el.setAttribute('aria-invalid', 'false');
      el.classList.remove('user-invalid-fallback');
      el.setCustomValidity('');
      linkError(el, false);
    });
  }

  function currentUnit() {
    return unitRadios.find((r) => r.checked)?.value || 'km';
  }

  function currentBalkeUnit() {
    return balkeUnitRadios.find((r) => r.checked)?.value || 'm';
  }

  function currentBasisMode() {
    return distanceRadios.find((r) => r.checked)?.value || '21.0975';
  }

  function parseBalkeKm() {
    const rawStr = balkeInput.value.trim();
    if (!rawStr) return null;
    const num = Number(rawStr);
    if (!Number.isFinite(num)) return null;
    const bUnit = currentBalkeUnit();
    const km = bUnit === 'm' ? num / 1000 : num;
    if (km < 1.2 || km > 6.5) return null;
    return Number(km.toFixed(3));
  }

  function resolveBasisSelection() {
    const mode = currentBasisMode();
    if (mode === 'balke') {
      const km = parseBalkeKm();
      if (km === null) return null;
      return { km, label: `Balke (${km}k)`, tableLabel: `Balke (${km}k)`, short: 'Balke', isBalke: true, isCustom: false };
    }
    if (mode === 'custom') {
      const num = Number(customInput.value.trim());
      if (!customInput.value.trim() || !Number.isFinite(num) || num < 1.5 || num > 100) return null;
      const cleanKm = Number(num.toFixed(3));
      return { km: cleanKm, label: `${cleanKm} km`, tableLabel: `${cleanKm}k`, short: `${cleanKm}k`, isBalke: false, isCustom: true };
    }
    const num = Number(mode);
    const std = STANDARD_RACES.find((r) => Math.abs(r.km - num) < 0.02);
    return {
      km: num,
      label: std ? std.label : `${num} km`,
      tableLabel: std ? std.tableLabel : `${num}k`,
      short: std ? std.short : `${num}k`,
      isBalke: false,
      isCustom: false,
    };
  }

  function resolveTargetSelection() {
    const val = targetRadios.find((r) => r.checked)?.value || '42.195';
    if (val === 'custom') {
      const num = Number(targetCustomInput.value.trim());
      if (!targetCustomInput.value.trim() || !Number.isFinite(num) || num < 1.5 || num > 100) return null;
      const cleanKm = Number(num.toFixed(3));
      return { km: cleanKm, label: `${cleanKm} km`, tableLabel: `${cleanKm}k`, short: `${cleanKm}k`, isCustom: true };
    }
    const num = Number(val);
    const std = STANDARD_RACES.find((r) => Math.abs(r.km - num) < 0.02);
    return {
      km: num,
      label: std ? std.label : `${num} km`,
      tableLabel: std ? std.tableLabel : `${num}k`,
      short: std ? std.short : `${num}k`,
      isCustom: false,
    };
  }

  function parseTimeFields() {
    if (currentBasisMode() === 'balke') {
      return { ok: true, sec: BALKE_SEC, hh: 0, mm: 15, ss: 0 };
    }
    const hRaw = timeHh.value.trim();
    const mRaw = timeMm.value.trim();
    const sRaw = timeSs.value.trim();

    if (!hRaw && !mRaw && !sRaw) {
      return { ok: false, badEl: timeHh, msg: 'Enter a race finish time.' };
    }
    if (hRaw && (!/^\d{1,2}$/.test(hRaw) || Number(hRaw) > 23)) {
      return { ok: false, badEl: timeHh, msg: 'Hours (hh) must be 0 to 23.' };
    }
    if (mRaw && (!/^\d{1,2}$/.test(mRaw) || Number(mRaw) > 59)) {
      return { ok: false, badEl: timeMm, msg: 'Minutes (mm) must be 0 to 59.' };
    }
    if (sRaw && (!/^\d{1,2}$/.test(sRaw) || Number(sRaw) > 59)) {
      return { ok: false, badEl: timeSs, msg: 'Seconds (ss) must be 0 to 59.' };
    }

    const hh = hRaw ? Number(hRaw) : 0;
    const mm = mRaw ? Number(mRaw) : 0;
    const ss = sRaw ? Number(sRaw) : 0;
    const sec = hh * 3600 + mm * 60 + ss;
    if (sec < 180 || sec > 50000) {
      return { ok: false, badEl: timeMm, msg: 'Enter a finish time between 3:00 and 13:50:00.' };
    }
    return { ok: true, sec, hh, mm, ss };
  }

  function validateTimeFields(announce = false) {
    if (currentBasisMode() === 'balke') {
      clearTimeErrors();
      return BALKE_SEC;
    }
    const res = parseTimeFields();
    if (!res.ok) {
      clearTimeErrors();
      renderErrorNode(timeError, res.msg);
      res.badEl.setAttribute('aria-invalid', 'true');
      res.badEl.classList.add('user-invalid-fallback');
      res.badEl.setCustomValidity(res.msg);
      linkError(res.badEl, true);
      if (announce) announceErrorMessage(res.msg);
      return null;
    }
    clearTimeErrors();
    return res.sec;
  }

  function validateBalkeField(announce = false) {
    if (currentBasisMode() !== 'balke') {
      setSingleFieldError(balkeInput, balkeError, '', false);
      return true;
    }
    const km = parseBalkeKm();
    if (km === null) {
      const bUnit = currentBalkeUnit();
      const rangeText = bUnit === 'm' ? '1200 to 6500 m' : '1.2 to 6.5 km';
      setSingleFieldError(balkeInput, balkeError, `Enter a 15-min distance from ${rangeText}.`, announce);
      return false;
    }
    setSingleFieldError(balkeInput, balkeError, '', false);
    return true;
  }

  function validateCustomDistance(radios, inputEl, errorEl, announce = false) {
    const isCustom = radios.find((r) => r.checked)?.value === 'custom';
    if (!isCustom) {
      setSingleFieldError(inputEl, errorEl, '', false);
      return true;
    }
    const num = Number(inputEl.value.trim());
    if (!inputEl.value.trim() || !Number.isFinite(num) || num < 1.5 || num > 100) {
      setSingleFieldError(inputEl, errorEl, 'Enter a distance between 1.5 and 100 km.', announce);
      return false;
    }
    setSingleFieldError(inputEl, errorEl, '', false);
    return true;
  }

  function validateVolumeField(announce = false) {
    const rawStr = volumeInput.value.trim();
    const raw = Number(rawStr);
    const unit = currentUnit();
    const maxAllowed = unit === 'mi' ? 155 : 250;
    if (!rawStr || !Number.isFinite(raw) || raw < 0 || raw > maxAllowed) {
      setSingleFieldError(
        volumeInput,
        volumeError,
        `Enter weekly mileage from 0 to ${maxAllowed} ${unit}/wk.`,
        announce
      );
      return null;
    }
    setSingleFieldError(volumeInput, volumeError, '', false);
    return unit === 'mi' ? raw * KM_PER_MILE : raw;
  }

  function niceTimeStep(rangeSec) {
    const steps = [10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
    return steps.find((s) => rangeSec / s <= 4) || 3600;
  }

  function renderTrainingPaces(t1Sec, basisSel, vKmWeek, unit) {
    if (!zonesTbody) return;
    const fmSec = predictSeconds(t1Sec, basisSel.km, D_MAR_KM, vKmWeek).sec;
    const fromLongRace = basisSel.km > 21.15;
    const vdot = fromLongRace
      ? calculateVdot(10000, predictSeconds(t1Sec, basisSel.km, 10.0, vKmWeek).sec)
      : calculateVdot(basisSel.km * 1000, t1Sec);
    const hasVdot = Number.isFinite(vdot) && vdot > 10;

    if (zonesNote) {
      zonesNote.textContent = fromLongRace
        ? "Marathon pace adjusts with your weekly mileage via Ricelo-Pace. Other zones use Jack Daniels' VDOT (62-70%, 88%, 97.5%, 105%) from your mileage-adjusted 10K equivalent."
        : "Marathon pace adjusts with your weekly mileage via Ricelo-Pace. Other zones use Jack Daniels' VDOT (62-70%, 88%, 97.5%, 105%) from your input effort.";
    }

    const easyFast = hasVdot ? formatPaceFromMpm(solveVdotVelocity(vdot * 0.70), unit) : '';
    const easySlow = hasVdot ? formatPaceFromMpm(solveVdotVelocity(vdot * 0.62), unit) : '';
    const easyRange = hasVdot ? `${easyFast.replace(`/${unit}`, '')}-${easySlow}` : 'N/A';

    const zones = [
      { name: 'Easy', pace: easyRange, use: 'Easy, recovery & long runs', isMileage: false },
      { name: 'Marathon', pace: formatPace(fmSec, D_MAR_KM, unit), use: 'Goal pace (by mileage)', isMileage: true },
      { name: 'Threshold', pace: hasVdot ? formatPaceFromMpm(solveVdotVelocity(vdot * 0.88), unit) : 'N/A', use: 'Tempo / ~1 hr effort', isMileage: false },
      { name: 'Interval', pace: hasVdot ? formatPaceFromMpm(solveVdotVelocity(vdot * 0.975), unit) : 'N/A', use: '3-5 min hard reps', isMileage: false },
      { name: 'Repetition', pace: hasVdot ? formatPaceFromMpm(solveVdotVelocity(vdot * 1.05), unit) : 'N/A', use: '200-400 m fast reps', isMileage: false },
    ];

    zonesTbody.textContent = '';
    for (const z of zones) {
      const tr = document.createElement('tr');
      if (z.isMileage) tr.classList.add('is-mileage-zone');

      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = z.name;

      const tdPace = document.createElement('td');
      tdPace.className = 'zone-pace';
      tdPace.textContent = z.pace;

      const tdUse = document.createElement('td');
      tdUse.className = 'zone-use';
      tdUse.textContent = z.use;

      tr.append(th, tdPace, tdUse);
      zonesTbody.appendChild(tr);
    }
  }

  function updateFormulaSnippets(basisSel, targetSel) {
    const samePair = Math.abs(basisSel.km - targetSel.km) < 0.02;
    const d1 = samePair ? 21.0975 : basisSel.km;
    const d2 = samePair ? 42.195 : targetSel.km;
    const fromShort = samePair ? 'HM' : basisSel.short;
    const toShort = samePair ? 'FM' : targetSel.short;
    const fromLabel = samePair ? 'Half' : basisShortName(basisSel);

    const w = intervalWeight(d1, d2);
    const c0 = (w * B0).toFixed(4);
    const c1 = (w * B1).toFixed(4);
    const ratio = d2 / d1;
    const ratioStr = Math.abs(ratio - 2) < 1e-4
      ? '2'
      : Math.abs(ratio - 0.5) < 1e-4
      ? '0.5'
      : `(${d2}/${d1})`;
    const eqRatioStr = Math.abs(ratio - 2) < 1e-4
      ? '2'
      : Math.abs(ratio - 0.5) < 1e-4
      ? '0.5'
      : `(${d2} / ${d1})`;

    if (shortcutHeading) {
      shortcutHeading.textContent = `Current Pair Shortcut (${fromShort} \u2192 ${toShort}, w = ${w.toFixed(3)})`;
    }
    if (shortcutEquation) {
      shortcutEquation.textContent = '';
      const xStrong = document.createElement('strong');
      xStrong.textContent = 'x';
      const br = document.createElement('br');
      const tStrong = document.createElement('strong');
      tStrong.textContent = 'T';
      const tSub = document.createElement('sub');
      tSub.textContent = toShort;
      tStrong.appendChild(tSub);
      const fromSub = document.createElement('sub');
      fromSub.textContent = fromShort;
      const supX = document.createElement('sup');
      supX.textContent = 'x';

      if (w < 1e-6) {
        shortcutEquation.append(
          xStrong,
          document.createTextNode(' = 1.06 (no mileage adjustment at or below 5 km)'),
          br,
          tStrong,
          document.createTextNode(' = T'),
          fromSub,
          document.createTextNode(` \u00B7 ${eqRatioStr}`),
          supX
        );
      } else {
        shortcutEquation.append(
          xStrong,
          document.createTextNode(` = 1.06 + max(0, ${c0} \u2212 ${c1} \u00B7 ln(max(10, V)))`),
          br,
          tStrong,
          document.createTextNode(' = T'),
          fromSub,
          document.createTextNode(` \u00B7 ${eqRatioStr}`),
          supX
        );
      }
    }

    if (excelPairHeading) {
      excelPairHeading.textContent = `Excel / Sheets (${fromShort} \u2192 ${toShort} Shortcut)`;
    }
    if (excelPairHint) {
      excelPairHint.textContent = `A2 = ${fromLabel} time, B2 = km/week`;
    }
    if (excelSnippet) {
      excelSnippet.textContent = w < 1e-6
        ? `=A2 * ${ratioStr}^1.06`
        : `=A2 * ${ratioStr}^(1.06 + MAX(0, ${c0} - ${c1} * LN(MAX(10, B2))))`;
    }

    const lo = Math.min(d1, d2);
    const hi = Math.max(d1, d2);
    for (const item of weightListItems) {
      const [p1, p2] = (item.dataset.pair || '').split(':').map(Number);
      const match = Math.abs(lo - p1) < 0.05 && Math.abs(hi - p2) < 0.05;
      item.classList.toggle('is-active', match);
    }
  }

  function renderCurve(vKmWeek, basisSel, targetSel, t1Sec, unit) {
    const samePair = Math.abs(basisSel.km - targetSel.km) < 0.02;
    curvePanel.hidden = samePair;
    if (samePair) return;

    curveSummaryTitle.textContent = `${targetSel.label} time by weekly mileage`;
    if (!curvePanel.open) return;

    // Draw at the element's real width so labels stay at their true font size on phones.
    const W = Math.max(300, Math.round(curveSvg.getBoundingClientRect().width) || 560);
    const H = W < 480 ? 190 : 200;
    const pad = { l: 56, r: 8, t: 18, b: 26 };
    curveSvg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const halo = 'paint-order="stroke" stroke="var(--panel-bg)" stroke-width="3" stroke-linejoin="round"';
    const toKm = (x) => (unit === 'mi' ? x * KM_PER_MILE : x);
    const vUser = unit === 'mi' ? vKmWeek / KM_PER_MILE : vKmWeek;
    const xMin = unit === 'mi' ? 6 : 10;
    const xBase = unit === 'mi' ? 100 : 160;
    const xStepUp = unit === 'mi' ? 10 : 20;
    const xMax = vUser > xBase ? Math.min(xBase * 1.5, Math.ceil(vUser / xStepUp) * xStepUp) : xBase;

    const predAt = (xUser) => predictSeconds(t1Sec, basisSel.km, targetSel.km, toKm(xUser)).sec;
    const riegelSec = predictSeconds(t1Sec, basisSel.km, targetSel.km, vKmWeek).riegelSec;

    const samples = [];
    const sampleStep = (xMax - xMin) / 80;
    for (let x = xMin; x <= xMax + 1e-9; x += sampleStep) samples.push([x, predAt(x)]);

    const allY = samples.map((s) => s[1]).concat(riegelSec);
    const rawMin = Math.min(...allY);
    const rawMax = Math.max(...allY);
    const step = niceTimeStep(Math.max(rawMax - rawMin, 20));
    const yMin = Math.floor(rawMin / step) * step;
    const yMax = Math.max(Math.ceil(rawMax / step) * step, yMin + step);

    const xPx = (x) => pad.l + ((Math.min(xMax, Math.max(xMin, x)) - xMin) / (xMax - xMin)) * (W - pad.l - pad.r);
    const yPx = (s) => pad.t + (1 - (s - yMin) / (yMax - yMin)) * (H - pad.t - pad.b);

    const gridY = [];
    for (let s = yMin; s <= yMax + 1e-6; s += step) {
      const py = yPx(s).toFixed(1);
      gridY.push(`<line x1="${pad.l}" y1="${py}" x2="${W - pad.r}" y2="${py}" stroke="currentColor" stroke-opacity="0.1"/>
        <text x="${pad.l - 6}" y="${Number(py) + 3.5}" text-anchor="end" font-size="10" fill="currentColor" opacity="0.62">${formatDuration(s)}</text>`);
    }

    const ticks = unit === 'mi'
      ? (xMax > 100 ? [6, 40, 80, 120, xMax] : [6, 25, 50, 75, 100])
      : (xMax > 160 ? [10, 50, 100, 150, xMax] : [10, 40, 80, 120, 160]);
    const gridX = ticks.map((xv, i) => {
      const px = xPx(xv).toFixed(1);
      const label = i === ticks.length - 1 ? `${xv} ${unit}/wk` : `${xv}`;
      const anchor = i === ticks.length - 1 ? 'end' : 'middle';
      const tx = i === ticks.length - 1 ? W - pad.r : px;
      return `<text x="${tx}" y="${H - 6}" text-anchor="${anchor}" font-size="10" fill="currentColor" opacity="0.62">${label}</text>`;
    }).join('');

    const pts = samples.map(([x, s]) => `${xPx(x).toFixed(1)},${yPx(s).toFixed(1)}`).join(' ');
    const ry = yPx(riegelSec);
    const riegelLabelY = ry - pad.t < 14 ? ry + 13 : ry - 5;

    const youSec = predAt(Math.min(xMax, Math.max(xMin, vUser)));
    const mx = xPx(vUser).toFixed(1);
    const my = yPx(youSec).toFixed(1);
    // Upward conversions slope down to the right; keep the "you" label clear of the line.
    const curveFalls = samples[0][1] > samples[samples.length - 1][1];
    const youLabelY = curveFalls ? pad.t + 10 : H - pad.b - 8;

    curveSvg.setAttribute(
      'aria-label',
      `Predicted ${targetSel.label} time from ${formatDuration(predAt(xMin))} at ${xMin} ${unit} per week to ${formatDuration(predAt(xMax))} at ${xMax} ${unit} per week. Standard calculator: ${formatDuration(riegelSec)}.`
    );

    curveSvg.innerHTML = `
      ${gridY.join('')}
      ${gridX}
      <line x1="${pad.l}" y1="${ry.toFixed(1)}" x2="${W - pad.r}" y2="${ry.toFixed(1)}" stroke="currentColor" stroke-opacity="0.45" stroke-dasharray="4,3"/>
      <text x="${pad.l + 6}" y="${riegelLabelY.toFixed(1)}" text-anchor="start" font-size="10" fill="currentColor" opacity="0.7" ${halo}>Standard ${formatDuration(riegelSec)}</text>
      <polyline fill="none" stroke="var(--accent)" stroke-width="2.4" points="${pts}"/>
      <line x1="${mx}" y1="${pad.t}" x2="${mx}" y2="${H - pad.b}" stroke="currentColor" stroke-opacity="0.22" stroke-dasharray="3,3"/>
      <circle cx="${mx}" cy="${my}" r="5" fill="var(--accent)"/>
      <text x="${W - pad.r - 2}" y="${youLabelY}" text-anchor="end" font-size="11" font-weight="700" fill="var(--accent)" ${halo}>You: ${formatDuration(youSec)} at ${Math.round(vUser)} ${unit}/wk</text>
    `;
  }

  function basisShortName(basisSel) {
    return basisSel.isBalke ? 'Balke' : basisSel.tableLabel;
  }

  function updatePredictions() {
    const basisSel = resolveBasisSelection();
    const targetSel = resolveTargetSelection();
    const timeRes = parseTimeFields();
    const rawVolStr = volumeInput.value.trim();
    const rawVol = Number(rawVolStr);
    const unit = currentUnit();
    const maxAllowed = unit === 'mi' ? 155 : 250;

    if (!basisSel || !targetSel || !timeRes.ok || !rawVolStr || !Number.isFinite(rawVol) || rawVol < 0 || rawVol > maxAllowed) {
      return;
    }

    const t1Sec = timeRes.sec;
    const vKmWeek = unit === 'mi' ? rawVol * KM_PER_MILE : rawVol;
    const sameDist = Math.abs(basisSel.km - targetSel.km) < 0.02;

    const heroPred = predictSeconds(t1Sec, basisSel.km, targetSel.km, vKmWeek);
    heroTargetLabel.textContent = `Predicted ${targetSel.label}`;
    heroTargetTime.textContent = formatDuration(heroPred.sec);
    heroPaceValue.textContent = formatPace(heroPred.sec, targetSel.km, unit);

    const basisName = basisShortName(basisSel);
    const unitWord = unit === 'mi' ? 'mile' : 'km';
    const paceDelta = Math.round(secPerUnit(heroPred.sec, targetSel.km, unit)) -
      Math.round(secPerUnit(t1Sec, basisSel.km, unit));
    heroFadeLabel.textContent = `vs. ${basisName} Pace`;
    heroFadeValue.textContent = sameDist ? 'Same' : formatPaceDelta(paceDelta, unit);
    heroFadeNote.textContent = sameDist
      ? 'Pick a different target race to see a prediction.'
      : paceDelta >= 0
      ? `How much slower per ${unitWord} than your ${basisName} pace.`
      : `How much faster per ${unitWord} than your ${basisName} pace.`;
    heroDeltaValue.textContent = sameDist ? 'Same' : formatSignedDelta(heroPred.sec - heroPred.riegelSec);

    if (vKmWeek < 20 && targetSel.km >= 30 && basisSel.km < 30) {
      baseNote.hidden = false;
      baseNote.textContent = 'Below 20 km/wk: build aerobic base before racing marathon distance.';
    } else {
      baseNote.hidden = true;
    }

    const rows = STANDARD_RACES.map((r) => ({ tableLabel: r.tableLabel, km: r.km, isBalkeRow: false }));
    if (basisSel.isBalke && !rows.some((r) => Math.abs(r.km - basisSel.km) < 0.02)) {
      rows.unshift({ tableLabel: basisSel.tableLabel, km: basisSel.km, isBalkeRow: true });
    }
    if (targetSel.isCustom && !rows.some((r) => Math.abs(r.km - targetSel.km) < 0.02)) {
      rows.push({ tableLabel: targetSel.tableLabel, km: targetSel.km, isBalkeRow: false });
      rows.sort((a, b) => a.km - b.km);
    }

    tbody.innerHTML = '';
    for (const race of rows) {
      const pred = predictSeconds(t1Sec, basisSel.km, race.km, vKmWeek);
      const isBasis = Math.abs(basisSel.km - race.km) < 0.02;
      const isTarget = Math.abs(targetSel.km - race.km) < 0.02;

      const tr = document.createElement('tr');
      if (isTarget) tr.classList.add('is-target');
      else if (isBasis) tr.classList.add('is-basis');

      const th = document.createElement('th');
      th.scope = 'row';
      th.textContent = race.tableLabel;
      if (isBasis && !isTarget && !race.isBalkeRow) {
        const meta = document.createElement('span');
        meta.className = 'row-meta';
        meta.textContent = '(input)';
        th.appendChild(meta);
      }

      const tdTime = document.createElement('td');
      tdTime.textContent = formatDuration(pred.sec);

      const tdPace = document.createElement('td');
      tdPace.textContent = formatPace(pred.sec, race.km, unit);

      const tdDelta = document.createElement('td');
      tdDelta.className = 'delta-cell';
      tdDelta.textContent = isBasis ? '-' : formatSignedDelta(pred.sec - pred.riegelSec);

      tr.append(th, tdTime, tdPace, tdDelta);
      tbody.appendChild(tr);
    }

    renderTrainingPaces(t1Sec, basisSel, vKmWeek, unit);
    renderCurve(vKmWeek, basisSel, targetSel, t1Sec, unit);
    updateFormulaSnippets(basisSel, targetSel);

    const params = new URLSearchParams();
    const mode = currentBasisMode();
    const selectedTarget = targetRadios.find((r) => r.checked)?.value || '42.195';
    if (mode === 'balke') {
      params.set('d', 'balke');
      params.set('bd', balkeInput.value.trim());
      params.set('bu', currentBalkeUnit());
    } else {
      params.set('d', mode === 'custom' ? String(basisSel.km) : mode);
      params.set('t', formatDuration(t1Sec));
    }
    params.set('to', selectedTarget === 'custom' ? String(targetSel.km) : selectedTarget);
    params.set('v', String(rawVol));
    params.set('u', unit);
    const hash = window.location.hash || '';
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}${hash}`);
  }

  function syncBasisUI() {
    const mode = currentBasisMode();
    const isBalke = mode === 'balke';
    const isCustom = mode === 'custom';

    balkeGroup.hidden = !isBalke;
    timeFieldset.hidden = isBalke;
    customGroup.hidden = !isCustom;

    if (!isCustom) setSingleFieldError(customInput, customError, '', false);
    if (!isBalke) setSingleFieldError(balkeInput, balkeError, '', false);
    if (isBalke) clearTimeErrors();
  }

  function timeMatchesAPreset() {
    const h = Number(timeHh.value.trim() || 0);
    const m = Number(timeMm.value.trim() || 0);
    const s = Number(timeSs.value.trim() || 0);
    return Object.values(DEFAULT_TIMES).some((p) => p.hh === h && p.mm === m && p.ss === s);
  }

  function applyPresetTime(distanceValue) {
    const preset = DEFAULT_TIMES[distanceValue];
    if (!preset || !(timeIsPreset || timeMatchesAPreset())) return;
    timeHh.value = String(preset.hh);
    timeMm.value = String(preset.mm).padStart(2, '0');
    timeSs.value = String(preset.ss).padStart(2, '0');
    timeIsPreset = true;
    dirty.delete('time');
    clearTimeErrors();
  }

  distanceRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      applyPresetTime(radio.value);
      syncBasisUI();
      if (!userPickedTarget) {
        const autoTarget = radio.value === '42.195' ? '21.0975' : '42.195';
        const match = targetRadios.find((r) => r.value === autoTarget);
        if (match) {
          match.checked = true;
          targetCustomGroup.hidden = true;
        }
      }
      updatePredictions();
    });
  });

  let activeBalkeUnit = currentBalkeUnit();
  balkeUnitRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const next = currentBalkeUnit();
      if (next === activeBalkeUnit) return;
      const cur = Number(balkeInput.value.trim());
      if (Number.isFinite(cur) && cur > 0) {
        balkeInput.value = next === 'km'
          ? String(Number((cur / 1000).toFixed(3)))
          : String(Math.round(cur * 1000));
      }
      activeBalkeUnit = next;
      setSingleFieldError(balkeInput, balkeError, '', false);
      updatePredictions();
    });
  });

  balkeInput.addEventListener('input', () => {
    dirty.add('balke');
    setSingleFieldError(balkeInput, balkeError, '', false);
    updatePredictions();
  });

  balkeInput.addEventListener('blur', () => {
    if (dirty.has('balke')) validateBalkeField(true);
  });

  targetRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      userPickedTarget = true;
      const isCustom = radio.value === 'custom';
      targetCustomGroup.hidden = !isCustom;
      if (!isCustom) setSingleFieldError(targetCustomInput, targetCustomError, '', false);
      updatePredictions();
    });
  });

  let currentActiveUnit = currentUnit();
  unitRadios.forEach((radio) => {
    radio.addEventListener('change', () => {
      const nextUnit = currentUnit();
      if (nextUnit === currentActiveUnit) return;
      const curVal = Number(volumeInput.value.trim());
      if (Number.isFinite(curVal)) {
        const converted = nextUnit === 'mi' ? curVal / KM_PER_MILE : curVal * KM_PER_MILE;
        const rounded = Math.round(converted);
        volumeSlider.max = nextUnit === 'mi' ? '100' : '160';
        volumeSlider.min = nextUnit === 'mi' ? '6' : '10';
        volumeInput.value = String(rounded);
        volumeSlider.value = String(Math.min(Number(volumeSlider.max), Math.max(Number(volumeSlider.min), rounded)));
      }
      currentActiveUnit = nextUnit;
      setSingleFieldError(volumeInput, volumeError, '', false);
      updatePredictions();
    });
  });

  volumeSlider.addEventListener('input', () => {
    volumeInput.value = volumeSlider.value;
    setSingleFieldError(volumeInput, volumeError, '', false);
    updatePredictions();
  });

  volumeInput.addEventListener('input', () => {
    dirty.add('volume');
    setSingleFieldError(volumeInput, volumeError, '', false);
    const v = Number(volumeInput.value.trim());
    if (Number.isFinite(v)) {
      volumeSlider.value = String(Math.min(Number(volumeSlider.max), Math.max(Number(volumeSlider.min), v)));
    }
    updatePredictions();
  });

  volumeInput.addEventListener('blur', () => {
    if (dirty.has('volume')) validateVolumeField(true);
  });

  timeInputs.forEach((el) => {
    el.addEventListener('input', () => {
      dirty.add('time');
      timeIsPreset = false;
      clearTimeErrors();
      updatePredictions();
    });

    el.addEventListener('blur', () => {
      const v = el.value.trim();
      if ((el === timeMm || el === timeSs) && /^\d$/.test(v)) {
        el.value = v.padStart(2, '0');
      }
      if (!dirty.has('time')) return;
      if (el === timeHh && v && (!/^\d{1,2}$/.test(v) || Number(v) > 23)) {
        validateTimeFields(true);
      } else if ((el === timeMm || el === timeSs) && v && (!/^\d{1,2}$/.test(v) || Number(v) > 59)) {
        validateTimeFields(true);
      }
    });
  });

  timeFieldset.addEventListener('focusout', (e) => {
    if (!timeFieldset.contains(e.relatedTarget) && dirty.has('time')) {
      validateTimeFields(true);
    }
  });

  customInput.addEventListener('input', () => {
    dirty.add('custom');
    setSingleFieldError(customInput, customError, '', false);
    updatePredictions();
  });

  customInput.addEventListener('blur', () => {
    if (dirty.has('custom')) validateCustomDistance(distanceRadios, customInput, customError, true);
  });

  targetCustomInput.addEventListener('input', () => {
    dirty.add('targetCustom');
    setSingleFieldError(targetCustomInput, targetCustomError, '', false);
    updatePredictions();
  });

  targetCustomInput.addEventListener('blur', () => {
    if (dirty.has('targetCustom')) validateCustomDistance(targetRadios, targetCustomInput, targetCustomError, true);
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const okBalke = validateBalkeField(false);
    const okBasis = validateCustomDistance(distanceRadios, customInput, customError, false);
    const okTime = validateTimeFields(false) !== null;
    const okTarget = validateCustomDistance(targetRadios, targetCustomInput, targetCustomError, false);
    const okVol = validateVolumeField(false) !== null;

    if (!okBalke) {
      balkeInput.focus();
      return;
    }
    if (!okBasis) {
      customInput.focus();
      return;
    }
    if (!okTime) {
      const badTime = timeInputs.find((el) => el.getAttribute('aria-invalid') === 'true') || timeHh;
      badTime.focus();
      return;
    }
    if (!okTarget) {
      targetCustomInput.focus();
      return;
    }
    if (!okVol) {
      volumeInput.focus();
      return;
    }
    updatePredictions();
  });

  function flashStatus(msg) {
    copyToast.textContent = msg;
    window.clearTimeout(flashStatus.timer);
    flashStatus.timer = window.setTimeout(() => {
      copyToast.textContent = '';
    }, 2000);
  }

  shareBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      flashStatus('Copied');
    } catch {
      flashStatus('Copy URL above');
    }
  });

  document.querySelectorAll('[data-copy-target]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const target = document.getElementById(btn.getAttribute('data-copy-target'));
      if (!target) return;
      try {
        await navigator.clipboard.writeText(target.textContent.trim());
        const prev = btn.textContent;
        btn.textContent = 'Copied!';
        window.setTimeout(() => {
          btn.textContent = prev;
        }, 1500);
      } catch {
        flashStatus('Select snippet to copy');
      }
    });
  });

  if (formulaNavLink && formulaDetails) {
    formulaNavLink.addEventListener('click', () => {
      formulaDetails.open = true;
    });
    if (window.location.hash === '#pocket-formula') {
      formulaDetails.open = true;
    }
  }

  // Hydrate from URL query params
  const qs = new URLSearchParams(window.location.search);
  if (qs.has('u') && (qs.get('u') === 'km' || qs.get('u') === 'mi')) {
    const u = qs.get('u');
    const r = unitRadios.find((el) => el.value === u);
    if (r) {
      r.checked = true;
      currentActiveUnit = u;
      volumeSlider.max = u === 'mi' ? '100' : '160';
      volumeSlider.min = u === 'mi' ? '6' : '10';
    }
  }
  if (qs.has('d')) {
    const dParam = qs.get('d');
    if (dParam === 'balke') {
      const bRadio = distanceRadios.find((el) => el.value === 'balke');
      if (bRadio) bRadio.checked = true;
      if (qs.has('bu') && (qs.get('bu') === 'm' || qs.get('bu') === 'km')) {
        const bu = qs.get('bu');
        const buRadio = balkeUnitRadios.find((el) => el.value === bu);
        if (buRadio) {
          buRadio.checked = true;
          activeBalkeUnit = bu;
        }
      }
      if (qs.has('bd') && Number.isFinite(Number(qs.get('bd')))) {
        balkeInput.value = qs.get('bd');
      }
    } else {
      const matchingRadio = distanceRadios.find((el) => el.value === dParam && dParam !== 'custom' && dParam !== 'balke');
      if (matchingRadio) {
        matchingRadio.checked = true;
      } else if (Number.isFinite(Number(dParam))) {
        const customRadio = distanceRadios.find((el) => el.value === 'custom');
        if (customRadio) customRadio.checked = true;
        customInput.value = dParam;
      }
    }
  }
  if (qs.has('to')) {
    const toParam = qs.get('to');
    userPickedTarget = true;
    const matchingTarget = targetRadios.find((el) => el.value === toParam && toParam !== 'custom');
    if (matchingTarget) {
      matchingTarget.checked = true;
      targetCustomGroup.hidden = true;
    } else if (Number.isFinite(Number(toParam))) {
      const customTarget = targetRadios.find((el) => el.value === 'custom');
      if (customTarget) customTarget.checked = true;
      targetCustomGroup.hidden = false;
      targetCustomInput.value = toParam;
    }
  } else if (currentBasisMode() === '42.195') {
    const hmTarget = targetRadios.find((el) => el.value === '21.0975');
    if (hmTarget) hmTarget.checked = true;
  }
  if (qs.has('t')) {
    const parsed = parseQueryTime(qs.get('t'));
    if (parsed) {
      timeHh.value = String(parsed.hh);
      timeMm.value = String(parsed.mm).padStart(2, '0');
      timeSs.value = String(parsed.ss).padStart(2, '0');
      timeIsPreset = false;
    }
  } else {
    applyPresetTime(currentBasisMode());
  }
  if (qs.has('v') && Number.isFinite(Number(qs.get('v')))) {
    volumeInput.value = qs.get('v');
    volumeSlider.value = qs.get('v');
  }

  syncBasisUI();
  updatePredictions();

  let lastCurveWidth = 0;
  if (curvePanel) {
    curvePanel.addEventListener('toggle', () => {
      if (curvePanel.open) {
        lastCurveWidth = 0;
        updatePredictions();
      }
    });
  }
  new ResizeObserver(([entry]) => {
    const w = Math.round(entry.contentRect.width);
    if (w && w !== lastCurveWidth && curvePanel && curvePanel.open) {
      lastCurveWidth = w;
      updatePredictions();
    }
  }).observe(curveSvg);
})();
