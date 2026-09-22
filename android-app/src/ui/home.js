// Home: live demo reel, import, tutorial, continue card, recent videos. Also the import overlay
// and the analysis sheet shown after a Timeline is read.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.js';
import { Card, FilePick, Ring, Stat, fmtTime } from './components.js';
import { t, formatNumber, formatDistance, formatDate, monthName } from '../i18n/index.js';
import { settings, timeline, importState, journeyInfo, library, sheet, go, project } from '../app/state.js';
import { importFrom, closeImport } from '../app/actions.js';
import { PreviewEngine } from '../app/preview.js';
import { demoTimeline } from '../engine/demo.js';
import { importTimeline } from '../engine/importer.js';
import { buildJourney } from '../engine/journey.js';
import { planFrames } from '../engine/planner.js';
import { loadFonts } from '../render/fonts.js';
import { Mode } from '../engine/modes.js';

const ACCEPT = '.json,.zip,application/json,application/zip,application/octet-stream,text/plain';

// ---------------------------------------------------------------- live demo reel
let demoCache = null;
async function demoJourney() {
  if (!demoCache) {
    demoCache = (async () => {
      const tl = await importTimeline({ json: demoTimeline(new Date().getFullYear() - 1) });
      return buildJourney(tl, {});
    })();
  }
  return demoCache;
}

function LiveReel() {
  const ref = useRef();
  useEffect(() => {
    let eng = null, alive = true;
    (async () => {
      await loadFonts('./fonts/');
      const j = await demoJourney();
      if (!alive) return;
      const plan = planFrames(j, { mode: 'active', overview_bottom_reserve: 0.24 }, { width: 800, height: 450, fps: 30, durationS: 24 });
      eng = new PreviewEngine(ref.current);
      eng.setPlan(plan, j);
      await eng.setLook({ theme: 'neon_dark_blue', map: 'world', labels: true, lang: settings.value.language });
      eng.setOverlays({ trail: {}, title: { name: 'Java · Bali · Perth', language: settings.value.language, layout: 'corner', timeline_bar: true }, vignette: true, grain: false });
      eng.onState = (playing) => { if (!playing && alive) setTimeout(() => { if (alive) { eng.seek(0); eng.play(); } }, 1600); };
      if (!settings.value.reducedMotion) eng.play(); else { eng.seek(0.62); }
    })();
    return () => { alive = false; eng?.dispose(); };
  }, [settings.value.language]);
  return html`<div class="hero"><canvas ref=${ref} width="800" height="450"></canvas><div class="shade"></div>
    <div class="live"><i></i>${t('app.home.live')}</div></div>`;
}

// ---------------------------------------------------------------- route sketch
export function RouteSketch({ info, w = 172, h = 172, cls = 'sketch' }) {
  const ref = useRef();
  useEffect(() => {
    const c = ref.current;
    if (!c || !info?.xs?.length) return;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    c.width = w * dpr; c.height = h * dpr;
    const ctx = c.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const xs = info.xs, ys = info.ys;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < xs.length; i++) { x0 = Math.min(x0, xs[i]); x1 = Math.max(x1, xs[i]); y0 = Math.min(y0, ys[i]); y1 = Math.max(y1, ys[i]); }
    const pad = 10, sx = Math.max(1, x1 - x0), sy = Math.max(1, y1 - y0);
    const k = Math.min((w - 2 * pad) / sx, (h - 2 * pad) / sy);
    const ox = (w - sx * k) / 2, oy = (h - sy * k) / 2;
    const P = (i) => [ox + (xs[i] - x0) * k, h - (oy + (ys[i] - y0) * k)];
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    for (let i = 1; i < xs.length; i++) {
      const fl = info.hopMode[i] === Mode.FLIGHT;
      ctx.strokeStyle = fl ? 'rgba(51,221,255,.75)' : '#4c9dff';
      ctx.lineWidth = fl ? 1.2 : 2;
      ctx.setLineDash(fl ? [3, 3] : []);
      const a = P(i - 1), b = P(i);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    ctx.setLineDash([]);
    const e = P(xs.length - 1);
    ctx.fillStyle = '#fff'; ctx.shadowColor = '#33ddff'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.arc(e[0], e[1], 3.2, 0, Math.PI * 2); ctx.fill();
  }, [info, w, h]);
  return html`<canvas ref=${ref} class=${cls} style=${`width:${w}px;height:${h}px`}></canvas>`;
}

// ---------------------------------------------------------------- home
export function Home() {
  const tl = timeline.value;
  const ji = journeyInfo.value;
  const vids = library.value.slice(0, 8);
  return html`
    <div class="page">
      <div class="topbar"><div class="brand grow"><img src="./brand/lockup_dark.png" alt="TimelinerX" /></div>
        <button class="iconbtn plain" aria-label=${t('app.nav.about')} onClick=${() => go('about')}>${Icon.info()}</button></div>
      <${LiveReel} />
      <h1 class="headline">${t('app.home.h1a')} <span class="g">${t('app.home.h1b')}</span></h1>
      <p class="lede">${t('app.home.lede')}</p>
      <div class="cta">
        <${FilePick} cls="btn primary block" accept=${ACCEPT} onFile=${(file) => importFrom({ file })}>${Icon.upload()} ${t('app.home.import')}<//>
        <button class="btn block" onClick=${() => importFrom({ demo: true })}>${Icon.sparkle()} ${t('app.home.demo')}</button>
      </div>
      <div class="privacy">
        <span>${Icon.shield()} ${t('app.home.p_local')}</span><span>${Icon.check()} ${t('app.home.p_account')}</span><span>${Icon.globe()} ${t('app.home.p_offline')}</span>
      </div>

      ${tl && html`
        <div class="section-title">${t('app.home.continue')}</div>
        <button class="card glow-card continue" style="width:100%;text-align:start;color:inherit" onClick=${() => go('studio')}>
          ${ji ? html`<${RouteSketch} info=${ji} w=${86} h=${86} />` : html`<div class="sketch"></div>`}
          <div class="grow">
            <div style="font-family:var(--display);font-weight:700;font-size:17px" class="ellipsis">${project.value.name || tl.name}</div>
            <div class="muted tiny">${formatNumber(tl.summary.points, 0)} ${t('app.common.points')} · ${dateRange(tl.summary)}</div>
            ${ji && html`<div class="tiny" style="margin-top:4px">${formatDistance(ji.totalKm, settings.value.unit)} · ${ji.stats.days} ${t('app.common.days')} · ${ji.trips} ${t('app.common.trips')}</div>`}
          </div>
          ${Icon.studio({ style: 'width:26px;height:26px;color:var(--accent-2)' })}
        </button>`}

      <div class="section-title">${t('app.home.how_title')}</div>
      <button class="card" style="width:100%;text-align:start;color:inherit" onClick=${() => (sheet.value = { name: 'tutorial' })}>
        <div class="row"><div class="grow"><b>${t('ui.tutorial.card_title')}</b><div class="muted tiny">${t('app.home.how_body')}</div></div>${Icon.open({ style: 'width:22px;height:22px' })}</div>
      </button>

      ${vids.length > 0 && html`
        <div class="section-title">${t('app.home.recent')}</div>
        <div class="hscroll">
          ${vids.map((v) => html`<button class="vthumb" onClick=${() => (sheet.value = { name: 'video', item: v })}>
            ${v.thumb ? html`<img src=${v.thumb} alt="" />` : html`<div class="ph"></div>`}
            <div class="meta"><b>${v.title}</b>${v.width}×${v.height} · ${fmtTime(v.duration)}</div></button>`)}
        </div>`}
    </div>`;
}

export function dateRange(s) {
  if (!s || !Number.isFinite(s.minDay)) return '';
  const a = new Date(s.minDay * 86400000), b = new Date(s.maxDay * 86400000);
  const pa = { y: a.getUTCFullYear(), m: a.getUTCMonth() + 1, d: a.getUTCDate() }, pb = { y: b.getUTCFullYear(), m: b.getUTCMonth() + 1, d: b.getUTCDate() };
  return `${formatDate(pa, undefined, { short: true })} – ${formatDate(pb, undefined, { short: true })}`;
}

// ---------------------------------------------------------------- import overlay
export function ImportOverlay() {
  const st = importState.value;
  if (!st) return null;
  const err = st.error;
  return html`
    <div class="full">
      <div class="page no-nav" style="text-align:center;padding-top:40px">
        ${!err && html`
          <${Ring} value=${st.progress || 0} />
          <h2>${t('tut.parsing')}</h2>
          <p class="muted ellipsis">${st.name}</p>
          <p class="tiny">${t('app.import.local_note')}</p>`}
        ${err && html`
          <div style="font-size:54px;margin:20px 0">⚠️</div>
          <h2>${t('ui.import.failed')}</h2>
          <div class="errbox" style="text-align:start">${errText(err)}</div>
          ${err.hint && !KNOWN_ERRORS[err.code] && html`<p class="muted" style="text-align:start">${err.hint}</p>`}
          <div class="col" style="margin-top:18px">
            <${FilePick} cls="btn primary block" accept=${ACCEPT} onFile=${(file) => importFrom({ file })}>${Icon.upload()} ${t('app.import.try_other')}<//>
            <button class="btn block" onClick=${() => { closeImport(); sheet.value = { name: 'tutorial' }; }}>${t('ui.tutorial.title')}</button>
            <button class="btn ghost block" onClick=${closeImport}>${t('app.common.close')}</button>
          </div>`}
      </div>
    </div>`;
}

const KNOWN_ERRORS = { not_json: 'app.err.not_json', unsupported: 'app.err.unsupported', no_data: 'app.err.no_data', bad_zip: 'app.err.bad_zip', no_json_in_zip: 'app.err.no_json_in_zip', empty: 'app.err.empty', too_large: 'app.err.too_large' };
function errText(err) { return KNOWN_ERRORS[err.code] ? t(KNOWN_ERRORS[err.code]) : err.message; }

// ---------------------------------------------------------------- analysis sheet
export function AnalysisSheet() {
  const tl = timeline.value;
  if (!tl) return null;
  const d = tl.diagnostics, s = tl.summary;
  const skipped = Object.values(d.skipped || {}).reduce((a, b) => a + b, 0);
  const months = monthly(s);
  const maxM = Math.max(1, ...months.map((m) => m[1]));
  const fmtKey = { 'device-object': 'app.fmt.android', 'device-array': 'app.fmt.ios', 'takeout-semantic': 'app.fmt.takeout_semantic', 'takeout-records': 'app.fmt.takeout_records' }[d.detected_format];
  return html`
    <h2>${t('app.analysis.title')}</h2>
    <p class="muted">${tl.demo ? t('app.demo.note') : tl.name}</p>
    <div class="stats" style="margin:12px 0">
      <${Stat} k=${t('ui.analysis.points')} v=${formatNumber(s.points, 0)} />
      <${Stat} k=${t('ui.analysis.days')} v=${formatNumber(s.days.length, 0)} />
      <${Stat} k=${t('ui.analysis.format')} v=${fmtKey ? t(fmtKey) : d.detected_format} />
      <${Stat} k=${t('ui.import.time')} v=${`${d.parse_seconds.toFixed(1)} s`} />
    </div>
    <div class="muted tiny" style="margin-bottom:6px">${t('ui.analysis.range')}: ${dateRange(s)}</div>
    ${months.length > 1 && html`<div class="months" aria-label=${t('ui.analysis.activity')}>${months.map(([, n]) => html`<div style=${`height:${Math.max(3, (n / maxM) * 100)}%`}></div>`)}</div>
      <div class="row tiny" style="justify-content:space-between;margin-top:4px"><span>${months[0][0]}</span><span>${months[months.length - 1][0]}</span></div>`}
    ${d.direction_reversed && html`<div class="okbox">${t('ui.import.reversed')}</div>`}
    ${d.truncated && html`<div class="warnbox">${t('app.import.truncated')}</div>`}
    ${skipped > 0 && html`<div class="warnbox">${t('app.import.skipped', { n: formatNumber(skipped, 0) })}</div>`}
    ${d.duplicates_removed > 0 && html`<div class="tiny">${t('ui.import.dups')}: ${formatNumber(d.duplicates_removed, 0)}</div>`}
    <div class="actions">
      <button class="btn primary block" onClick=${() => { sheet.value = null; go('studio'); }}>${Icon.film()} ${t('app.analysis.build')}</button>
    </div>`;
}

function monthly(s) {
  const m = new Map();
  for (const [day, n] of s.days) {
    const d = new Date(day * 86400000);
    const k = d.getUTCFullYear() * 12 + d.getUTCMonth();
    m.set(k, (m.get(k) || 0) + n);
  }
  const keys = [...m.keys()].sort((a, b) => a - b);
  if (!keys.length) return [];
  const out = [];
  for (let k = Math.max(keys[0], keys[keys.length - 1] - 35); k <= keys[keys.length - 1]; k++) {
    out.push([`${monthName((k % 12) + 1, undefined, { short: true })} ${Math.floor(k / 12)}`, m.get(k) || 0]);
  }
  return out;
}

// ---------------------------------------------------------------- tutorial sheet
export function TutorialSheet() {
  const [os, setOs] = useState('android');
  const steps = [1, 2, 3, 4, 5, 6, 7].map((i) => t(`tut.${os === 'android' ? 'a' : 'i'}.step${i}`));
  return html`
    <h2>${t('ui.tutorial.title')}</h2>
    <p class="muted">${t('app.tutorial.intro')}</p>
    <div class="seg" style="margin:12px 0">
      <button class=${os === 'android' ? 'on' : ''} onClick=${() => setOs('android')}>${t('tut.platform.android')}</button>
      <button class=${os === 'iphone' ? 'on' : ''} onClick=${() => setOs('iphone')}>${t('tut.platform.iphone')}</button>
    </div>
    <ol class="steps">${steps.map((s) => html`<li>${s}</li>`)}
      <li>${t(os === 'android' ? 'app.tutorial.open_android' : 'app.tutorial.open_iphone')}</li></ol>
    <p class="tiny">${t(os === 'android' ? 'ui.tutorial.android_note' : 'ui.tutorial.iphone_note')}</p>
    <div class="card" style="margin-top:10px"><b>${t('app.tutorial.takeout_title')}</b><div class="muted tiny">${t('app.tutorial.takeout_body')}</div></div>
    <div class="actions">
      <${FilePick} cls="btn primary block" accept=${ACCEPT} onFile=${(file) => importFrom({ file })}>${Icon.upload()} ${t('ui.tutorial.go_import')}<//>
    </div>`;
}
