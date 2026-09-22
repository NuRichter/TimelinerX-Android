// Studio: live preview on top, five editing tabs, and the render bar.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.js';
import { Card, Seg, Chips, Options, Toggle, Slider, Field, Stat, FilePick, fmtTime, fmtBytes } from './components.js';
import { RouteSketch, dateRange } from './home.js';
import { t, formatNumber, formatDistance, LANGUAGES } from '../i18n/index.js';
import { project, timeline, journeyInfo, journeyError, estimate, settings, effectiveSettings, device, updateProject, go, sheet } from '../app/state.js';
import { persistProject, refreshJourney, setPeriod, yearsInTimeline, dayIso, startRender, setSoundtrack, importFrom } from '../app/actions.js';
import { cameraConfig, journeyConfig, resolveDimensions, RESOLUTIONS, FPS_CHOICES, QUALITY, TITLE_LAYOUTS } from '../app/project.js';
import { planRemote } from '../app/engine.js';
import { PreviewEngine, previewDims } from '../app/preview.js';
import { allThemes } from '../render/grading.js';
import { bitrateFor } from '../export/encoder.js';
import { MODE_KEYS } from '../engine/modes.js';

const edit = (fn, { journey = false } = {}) => { updateProject(fn); persistProject(); if (journey) refreshJourney(); };

// ---------------------------------------------------------------- preview player
function Player() {
  const ref = useRef(), eng = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [busy, setBusy] = useState(true);
  const [missingKey, setMissingKey] = useState(false);
  const p = project.value;
  const planKey = JSON.stringify([journeyConfig(p), cameraConfig(p), p.video.aspect, p.video.fps, p.video.duration_s, timeline.value?.name]);
  const lookKey = JSON.stringify([p.visual.theme, p.visual.map_provider, p.visual.labels, p.title.language, effectiveSettings.value.cartoKey, settings.value.xyzTemplate]);
  const ovKey = JSON.stringify([p.visual.trail, p.title, p.visual.vignette, p.visual.grain]);

  useEffect(() => {
    eng.current = new PreviewEngine(ref.current, { onTime: setPos, onState: setPlaying });
    return () => eng.current.dispose();
  }, []);

  useEffect(() => {
    let alive = true;
    const h = setTimeout(async () => {
      setBusy(true);
      try {
        const [w, hh] = previewDims(p.video.aspect, 960);
        const { plan, journey } = await planRemote({ jcfg: journeyConfig(p), ccfg: cameraConfig(p), width: w, height: hh, fps: p.video.fps, durationS: p.video.duration_s });
        if (!alive) return;
        const e = eng.current;
        const frac = pos;
        e.setPlan(plan, journey);
        await e.setLook({ theme: p.visual.theme, map: p.visual.map_provider, labels: p.visual.labels, lang: p.title.language, settings: effectiveSettings.value });
        setMissingKey(e.missingKey);
        e.setOverlays({ trail: p.visual.trail, title: p.title, vignette: p.visual.vignette, grain: p.visual.grain });
        e.seek(frac || 0.35);
      } catch (err) { /* journey errors are shown by the Journey tab */ }
      if (alive) setBusy(false);
    }, 250);
    return () => { alive = false; clearTimeout(h); };
  }, [planKey]);

  useEffect(() => {
    const e = eng.current;
    if (!e?.plan) return;
    (async () => {
      await e.setLook({ theme: p.visual.theme, map: p.visual.map_provider, labels: p.visual.labels, lang: p.title.language, settings: effectiveSettings.value });
      setMissingKey(e.missingKey);
      e.setOverlays({ trail: p.visual.trail, title: p.title, vignette: p.visual.vignette, grain: p.visual.grain });
      e.refresh();
    })();
  }, [lookKey, ovKey]);

  const [w, h] = previewDims(p.video.aspect, 960);
  const portrait = h > w;
  const style = portrait ? `aspect-ratio:${w}/${h};height:min(52dvh, 560px);` : `aspect-ratio:${w}/${h};width:100%;max-height:48dvh`;
  const dur = p.video.duration_s;
  return html`
    <div class="player" dir="ltr" style=${style} onClick=${(e) => { if (e.target.tagName === 'CANVAS') eng.current?.toggle(); }}>
      <canvas ref=${ref} width=${w} height=${h}></canvas>
      ${busy && html`<div class="busy">${t('app.studio.updating')}</div>`}
      <div class="ctrl">
        <button class="iconbtn plain" aria-label=${t('ui.preview.play')} onClick=${() => eng.current?.toggle()}>${playing ? Icon.pause() : Icon.play()}</button>
        <input type="range" min="0" max="1000" value=${Math.round(pos * 1000)} style=${`--p:${pos * 100}%`}
          aria-label=${t('ui.preview.scrub')} onInput=${(e) => { const v = Number(e.currentTarget.value) / 1000; setPos(v); eng.current?.seek(v); }} />
        <span class="time">${fmtTime(pos * dur)} / ${fmtTime(dur)}</span>
      </div>
    </div>
    ${missingKey && html`<div class="tiny center" style="margin-top:6px">${t('app.studio.world_fallback')}</div>`}`;
}

function StatLine() {
  const ji = journeyInfo.value;
  if (!ji) return journeyError.value ? html`<div class="statline" style="color:var(--warn)">${journeyError.value.message}</div>` : null;
  const u = settings.value.unit;
  return html`<div class="statline">
    <span><b>${formatDistance(ji.totalKm, u, undefined, 0)}</b></span>
    <span><b>${ji.stats.days}</b> ${t('app.common.days')}</span>
    <span><b>${ji.trips}</b> ${t('app.common.trips')}</span>
    <span>${Icon.plane({ style: 'width:13px;height:13px;vertical-align:-2px' })} <b>${ji.stats.flights}</b></span>
  </div>`;
}

// ---------------------------------------------------------------- tabs
function JourneyTab() {
  const p = project.value, tl = timeline.value, ji = journeyInfo.value;
  const years = yearsInTimeline();
  const s = tl.summary;
  const minIso = dayIso(s.minDay), maxIso = dayIso(s.maxDay);
  const cur = p.period.start || p.period.end ? 'custom' : 'all';
  const yearOf = (y) => [`${y}-01-01`, `${y}-12-31`];
  const isYear = years.find((y) => p.period.start === yearOf(y)[0] && p.period.end === yearOf(y)[1]);
  const last = (days) => [dayIso(s.maxDay - days + 1), maxIso];
  const presetVal = isYear ? 'y' + isYear : p.period.start === last(30)[0] && p.period.end === maxIso ? 'l30' : p.period.start === last(7)[0] && p.period.end === maxIso ? 'l7' : cur;
  const onPreset = (v) => {
    if (v === 'all') setPeriod(null, null);
    else if (v === 'l7') setPeriod(...last(7));
    else if (v === 'l30') setPeriod(...last(30));
    else if (v.startsWith('y')) setPeriod(...yearOf(Number(v.slice(1))));
  };
  const modeKm = ji?.stats?.mode_km || {};
  const maxKm = Math.max(1, ...Object.values(modeKm));
  return html`
    <${Card} title=${t('ui.journey.project')}>
      <${Field} label=${t('ui.journey.name')}>
        <input class="input" value=${p.name} placeholder=${tl.name} maxlength="80" onInput=${(e) => edit((q) => { q.name = e.currentTarget.value; q.title.name = e.currentTarget.value; })} />
      <//>
    <//>
    <${Card} title=${t('ui.journey.period')} desc=${dateRange(s)}>
      <${Chips} value=${presetVal} onChange=${onPreset} options=${[['all', t('ui.journey.preset.all')], ['l7', t('app.journey.last7')], ['l30', t('app.journey.last30')], ...years.map((y) => ['y' + y, String(y)])]} />
      <div class="row" style="margin-top:6px">
        <${Field} label=${t('ui.journey.start')}><input class="input" type="date" min=${minIso} max=${maxIso} value=${p.period.start || minIso} onChange=${(e) => setPeriod(e.currentTarget.value || null, p.period.end)} /><//>
        <${Field} label=${t('ui.journey.end')}><input class="input" type="date" min=${minIso} max=${maxIso} value=${p.period.end || maxIso} onChange=${(e) => setPeriod(p.period.start, e.currentTarget.value || null)} /><//>
      </div>
      ${journeyError.value && html`<div class="warnbox">${journeyError.value.code === 'empty_period' ? t('app.journey.empty_period') : journeyError.value.message}</div>`}
    <//>
    ${ji && html`
      <${Card} title=${t('ui.journey.result')}>
        <div class="row" style="align-items:flex-start;gap:14px">
          <${RouteSketch} info=${ji} w=${118} h=${118} />
          <div class="stats grow" style="grid-template-columns:1fr 1fr">
            <${Stat} k=${t('ui.journey.stat.distance')} v=${formatDistance(ji.totalKm, settings.value.unit, undefined, 0)} />
            <${Stat} k=${t('ui.journey.stat.days')} v=${formatNumber(ji.stats.days, 0)} />
            <${Stat} k=${t('ui.journey.stat.trips')} v=${formatNumber(ji.trips, 0)} />
            <${Stat} k=${t('ui.journey.stat.flights')} v=${formatNumber(ji.stats.flights, 0)} />
          </div>
        </div>
        <div class="tiny" style="margin:10px 0 6px">${t('ui.journey.by_mode')}</div>
        <div class="bars">
          ${Object.entries(modeKm).filter(([m, km]) => km > 0.05 && Number(m) > 0).sort((a, b) => b[1] - a[1]).map(([m, km]) => html`
            <div class="bar"><span class="ellipsis">${t('ui.mode.' + MODE_KEYS[m])}</span><div class="track"><div class="fill" style=${`width:${(km / maxKm) * 100}%`}></div></div><span class="tiny nowrap">${formatDistance(km, settings.value.unit, undefined, 0)}</span></div>`)}
        </div>
        <div class="tiny" style="margin-top:10px">${formatNumber(ji.stats.points, 0)} ${t('app.common.points')}${ji.stats.outliers_removed ? ' · ' + t('ui.journey.stat.outliers') + ': ' + ji.stats.outliers_removed : ''}</div>
      <//>`}
    <${Card} title=${t('ui.journey.trip_detection')}>
      <${Options} value=${p.journey.trip_detection} onChange=${(v) => edit((q) => { q.journey.trip_detection = v; }, { journey: true })}
        options=${['conservative', 'balanced', 'sensitive'].map((k) => [k, t('ui.journey.trips.' + k), t('ui.journey.trips.' + k + '.desc')])} />
    <//>
    <${Card} title=${t('ui.journey.processing')} desc=${t('ui.journey.processing_note')}>
      <div class="label" style="margin-bottom:6px">${t('ui.journey.source')}</div>
      <${Seg} value=${p.journey.route_source} onChange=${(v) => edit((q) => { q.journey.route_source = v; }, { journey: true })}
        options=${[['semantic', t('app.journey.src_semantic')], ['detailed', t('app.journey.src_detailed')]]} />
      <${Toggle} label=${t('ui.journey.outliers')} desc=${t('ui.journey.outliers.conservative')} value=${p.journey.outlier_filter === 'conservative'}
        onChange=${(v) => edit((q) => { q.journey.outlier_filter = v ? 'conservative' : 'off'; }, { journey: true })} />
    <//>
    <div class="spacer"></div>
    <${FilePick} cls="btn ghost block" accept=".json,.zip,application/json,application/zip,application/octet-stream" onFile=${(file) => importFrom({ file })}>${Icon.upload()} ${t('app.studio.replace')}<//>`;
}

function CameraTab() {
  const c = project.value.camera;
  const set = (fn) => edit((q) => fn(q.camera), { journey: true });
  return html`
    <${Card} title=${t('ui.camera.zoom_style')}>
      <${Options} value=${c.mode} onChange=${(v) => set((cc) => { cc.mode = v; })}
        options=${['active', 'balanced', 'close_up', 'fixed'].map((k) => [k, t('ui.camera.zoom.' + k), t('ui.camera.zoom.' + k + '.desc')])} />
    <//>
    <${Card} title=${t('ui.camera.long_trip_pacing')}>
      <${Options} value=${c.compression} onChange=${(v) => set((cc) => { cc.compression = v; })}
        options=${['natural', 'balanced', 'faster', 'fastest'].map((k) => [k, t('ui.camera.ltp.' + k), t('ui.camera.ltp.' + k + '.desc')])} />
    <//>
    <${Card} title=${t('ui.camera.framing')}>
      <${Options} value=${c.local_framing} onChange=${(v) => set((cc) => { cc.local_framing = v; })}
        options=${['balanced', 'close', 'off'].map((k) => [k, t('ui.camera.framing.' + k), t('ui.camera.framing.' + k + '.desc')])} />
    <//>
    <${Card} title=${t('app.camera.fine')}>
      <div class="label" style="margin-bottom:6px">${t('ui.camera.composition')}</div>
      <${Seg} value=${c.composition} onChange=${(v) => set((cc) => { cc.composition = v; })} options=${[['thirds', t('ui.camera.thirds')], ['centered', t('ui.camera.centered')]]} />
      <div class="label" style="margin:14px 0 6px">${t('ui.camera.pacing')}</div>
      <${Options} value=${c.pacing} onChange=${(v) => set((cc) => { cc.pacing = v; })} options=${['visual_zoom', 'visual', 'distance'].map((k) => [k, t('ui.camera.pacing.' + k)])} />
      <${Slider} label=${t('ui.camera.smoothing')} value=${c.smoothing} min=${0.3} max=${2} step=${0.1} format=${(v) => '×' + v.toFixed(1)} onChange=${(v) => set((cc) => { cc.smoothing = v; })} />
      <${Slider} label=${t('ui.camera.anticipation')} value=${c.anticipation} min=${0} max=${2} step=${0.1} format=${(v) => '×' + v.toFixed(1)} onChange=${(v) => set((cc) => { cc.anticipation = v; })} />
      <${Slider} label=${t('ui.camera.intro')} value=${c.intro_s} min=${0} max=${4} step=${0.1} format=${(v) => v.toFixed(1) + ' s'} onChange=${(v) => set((cc) => { cc.intro_s = v; })} />
      <${Slider} label=${t('ui.camera.outro_transition')} value=${c.outro_transition_s} min=${0} max=${4} step=${0.1} format=${(v) => v.toFixed(1) + ' s'} onChange=${(v) => set((cc) => { cc.outro_transition_s = v; })} />
      <${Slider} label=${t('ui.camera.outro_hold')} value=${c.outro_hold_s} min=${0} max=${5} step=${0.1} format=${(v) => v.toFixed(1) + ' s'} onChange=${(v) => set((cc) => { cc.outro_hold_s = v; })} />
    <//>`;
}

function ThemeSwatch({ th, on, onClick }) {
  const pal = th.palette;
  const land = th.base === 'dark' ? '#1c2028' : '#e9e6e0';
  return html`<button class=${'theme' + (on ? ' on' : '')} onClick=${onClick} aria-pressed=${on}>
    <svg viewBox="0 0 160 100">
      <rect width="160" height="100" fill=${pal.background.slice(0, 7)} />
      <path d="M-5 70 C 20 55, 35 72, 60 60 S 95 30, 120 42 S 150 60, 170 50 L170 110 L-5 110Z" fill=${land} opacity=".9" />
      <path d="M18 78 C 40 70, 52 52, 74 55 S 104 35, 122 28" fill="none" stroke=${pal.trail_old.slice(0, 7)} stroke-opacity=".35" stroke-width="2.4" stroke-linecap="round" />
      <path d="M74 55 C 92 58, 104 35, 122 28" fill="none" stroke=${pal.route_glow.slice(0, 7)} stroke-width="7" stroke-opacity=".25" stroke-linecap="round" />
      <path d="M74 55 C 92 58, 104 35, 122 28" fill="none" stroke=${pal.route.slice(0, 7)} stroke-width="3" stroke-linecap="round" />
      <circle cx="122" cy="28" r="7" fill=${pal.marker_ring.slice(0, 7)} opacity=".35" />
      <circle cx="122" cy="28" r="4" fill=${pal.marker_core.slice(0, 7)} stroke=${pal.marker_ring.slice(0, 7)} stroke-width="1.6" />
      <rect x="10" y="10" width="62" height="16" rx="5" fill=${pal.card_bg.slice(0, 7)} opacity=".9" />
      <rect x="15" y="15" width="38" height="6" rx="3" fill=${pal.text_primary.slice(0, 7)} />
    </svg>
    <div class="n"><span class="ellipsis">${th.name}</span>${th.experimental ? html`<span class="tiny">β</span>` : ''}</div>
  </button>`;
}

function LookTab() {
  const v = project.value.visual;
  const set = (fn) => edit((q) => fn(q.visual));
  const hasKey = !!effectiveSettings.value.cartoKey;
  const maps = [
    ['auto', t('app.map.auto'), t(hasKey ? 'app.map.auto_carto' : 'app.map.auto_world')],
    ['world', t('app.map.world'), t('app.map.world_desc')],
    ['carto', t('app.map.carto'), hasKey ? t('app.map.carto_desc') : t('app.map.carto_nokey')],
    ['carto-voyager', t('app.map.voyager'), hasKey ? t('app.map.voyager_desc') : t('app.map.carto_nokey')],
    ['plain', t('app.map.plain'), t('app.map.plain_desc')],
    ...(settings.value.xyzTemplate ? [['xyz', t('app.map.xyz'), settings.value.xyzTemplate]] : []),
  ];
  return html`
    <${Card} title=${t('app.look.theme')}>
      <div class="themes">${allThemes().map((th) => html`<${ThemeSwatch} th=${th} on=${th.id === v.theme} onClick=${() => set((vv) => { vv.theme = th.id; })} />`)}</div>
    <//>
    <${Card} title=${t('ui.visual.provider')}>
      <${Options} value=${v.map_provider} onChange=${(x) => set((vv) => { vv.map_provider = x; })} options=${maps} />
      ${!hasKey && html`<button class="btn small ghost" style="margin-top:10px" onClick=${() => go('settings')}>${Icon.key()} ${t('app.map.add_key')}</button>`}
      ${(v.map_provider === 'world' || (v.map_provider === 'auto' && !hasKey)) && html`<${Toggle} label=${t('app.map.labels')} value=${v.labels} onChange=${(x) => set((vv) => { vv.labels = x; })} />`}
    <//>
    <${Card} title=${t('app.look.trail')}>
      <${Slider} label=${t('ui.visual.trail_length')} value=${v.trail.length} min=${0.2} max=${3} step=${0.1} format=${(x) => '×' + x.toFixed(1)} onChange=${(x) => set((vv) => { vv.trail.length = x; })} />
      <${Slider} label=${t('ui.visual.trail_width')} value=${v.trail.width} min=${0.5} max=${2.5} step=${0.1} format=${(x) => '×' + x.toFixed(1)} onChange=${(x) => set((vv) => { vv.trail.width = x; })} />
      <${Toggle} label=${t('ui.visual.gradient')} value=${v.trail.gradient} onChange=${(x) => set((vv) => { vv.trail.gradient = x; })} />
      <${Toggle} label=${t('ui.visual.glow')} value=${v.trail.glow} onChange=${(x) => set((vv) => { vv.trail.glow = x; })} />
      <${Toggle} label=${t('ui.visual.shadow')} value=${v.trail.shadow} onChange=${(x) => set((vv) => { vv.trail.shadow = x; })} />
      <${Toggle} label=${t('ui.visual.pulse')} value=${v.trail.pulse} onChange=${(x) => set((vv) => { vv.trail.pulse = x; })} />
      <${Toggle} label=${t('ui.visual.full_route')} value=${v.trail.show_full_route} onChange=${(x) => set((vv) => { vv.trail.show_full_route = x; })} />
    <//>
    <${Card} title=${t('app.look.film')}>
      <${Toggle} label=${t('ui.visual.vignette')} value=${v.vignette} onChange=${(x) => set((vv) => { vv.vignette = x; })} />
      <${Toggle} label=${t('ui.visual.grain')} value=${v.grain} onChange=${(x) => set((vv) => { vv.grain = x; })} />
    <//>`;
}

function TitlesTab() {
  const ti = project.value.title;
  const set = (fn) => edit((q) => fn(q.title));
  const insert = (ph) => set((tt) => { tt.template = (tt.template + ' ' + ph).trim(); });
  return html`
    <${Card} title=${t('ui.titles.layout')}>
      <${Chips} value=${ti.layout} onChange=${(v) => set((tt) => { tt.layout = v; })} options=${TITLE_LAYOUTS.map((k) => [k, t('ui.titles.layout.' + k)])} />
    <//>
    <${Card} title=${t('ui.titles.template')} desc=${t('ui.titles.safe_area')}>
      <${Field} label=${t('ui.titles.name')}><input class="input" value=${ti.name} maxlength="80" onInput=${(e) => edit((q) => { q.title.name = e.currentTarget.value; q.name = e.currentTarget.value; })} /><//>
      <${Field} label=${t('ui.titles.template')}>
        <input class="input" value=${ti.template} maxlength="120" onInput=${(e) => set((tt) => { tt.template = e.currentTarget.value; })} />
        <div class="tplchips">${['{name}', '{year}', '{start}', '{end}', '{distance}', '{trips}', '{days}'].map((ph) => html`<button onClick=${() => insert(ph)}>${ph}</button>`)}</div>
      <//>
      <${Toggle} label=${t('ui.titles.show_date')} value=${ti.show_date} onChange=${(v) => set((tt) => { tt.show_date = v; })} />
      ${ti.show_date && html`<${Seg} value=${ti.date_format} onChange=${(v) => set((tt) => { tt.date_format = v; })} options=${[['month', t('ui.titles.date.month')], ['day', t('ui.titles.date.day')]]} />`}
      <${Toggle} label=${t('ui.titles.show_distance')} value=${ti.show_distance} onChange=${(v) => set((tt) => { tt.show_distance = v; })} />
      <${Toggle} label=${t('app.titles.ribbon')} desc=${t('ui.titles.timeline_bar')} value=${ti.timeline_bar} onChange=${(v) => set((tt) => { tt.timeline_bar = v; })} />
    <//>
    <${Card} title=${t('ui.titles.ending')}>
      <${Toggle} label=${t('ui.titles.ending')} value=${ti.ending_title} onChange=${(v) => set((tt) => { tt.ending_title = v; })} />
      <${Toggle} label=${t('ui.titles.count_up')} value=${ti.count_up} onChange=${(v) => set((tt) => { tt.count_up = v; })} />
    <//>
    <${Card} title=${t('ui.titles.language')}>
      <select class="input" value=${ti.language} onChange=${(e) => set((tt) => { tt.language = e.currentTarget.value; })}>
        ${Object.entries(LANGUAGES).map(([k, n]) => html`<option value=${k}>${n}</option>`)}
      </select>
      <div class="spacer"></div>
      <${Seg} value=${ti.unit} onChange=${(v) => set((tt) => { tt.unit = v; })} options=${[['km', t('ui.settings.unit.km')], ['mi', t('ui.settings.unit.mi')]]} />
    <//>`;
}

function VideoTab() {
  const v = project.value.video, a = project.value.audio;
  const set = (fn) => edit((q) => fn(q.video));
  const setJ = (fn) => edit((q) => fn(q.video), { journey: true });
  const caps = device.value.caps;
  const est = estimate.value;
  const [w, h] = resolveDimensions(v.resolution, v.aspect);
  const size = (bitrateFor(w, h, v.fps, v.quality) * v.duration_s) / 8;
  const lowRam = device.value.info?.lowRam || (device.value.info?.totalMemMB || 8192) < 3500;
  return html`
    <${Card} title=${t('ui.video.aspect')}>
      <div class="aspects">
        ${[['16:9', 34, 19, 'app.video.aspect_yt'], ['9:16', 19, 34, 'app.video.aspect_reels'], ['1:1', 26, 26, 'app.video.aspect_feed']].map(([k, iw, ih, sub]) => html`
          <button class=${'aspect' + (v.aspect === k ? ' on' : '')} onClick=${() => setJ((vv) => { vv.aspect = k; })}>
            <i style=${`width:${iw}px;height:${ih}px`}></i>${k}<span class="tiny">${t(sub)}</span></button>`)}
      </div>
    <//>
    <${Card} title=${t('ui.video.resolution')}>
      <${Chips} value=${v.resolution} onChange=${(x) => set((vv) => { vv.resolution = x; })}
        options=${RESOLUTIONS.map((r) => [r, r === '2160p' ? '4K' : r, caps?.sizes && caps.sizes[r] && !caps.sizes[r].ok])} />
      <div class="tiny" style="margin-top:8px">${w} × ${h} px · ≈ ${fmtBytes(size)}${caps?.sizes?.[v.resolution]?.hw ? ' · ' + t('app.video.hw') : ''}</div>
      ${v.resolution === '2160p' && lowRam && html`<div class="warnbox">${t('app.video.4k_warn')}</div>`}
      <div class="label" style="margin:14px 0 6px">${t('ui.video.fps')}</div>
      <${Seg} value=${v.fps} onChange=${(x) => setJ((vv) => { vv.fps = x; })} options=${FPS_CHOICES.map((f) => [f, f + ' fps'])} />
      <div class="label" style="margin:14px 0 6px">${t('ui.video.quality')}</div>
      <${Seg} value=${v.quality} onChange=${(x) => set((vv) => { vv.quality = x; })} options=${QUALITY.map((q) => [q, t('ui.video.quality.' + q)])} />
    <//>
    <${Card} title=${t('ui.video.duration')}>
      <${Slider} label=${t('ui.video.duration')} value=${v.duration_s} min=${5} max=${300} step=${1} format=${fmtTime} onChange=${(x) => setJ((vv) => { vv.duration_s = x; })} />
      ${est ? html`<div class="row wrap">
          <button class="btn small" onClick=${() => setJ((vv) => { vv.duration_s = Math.round(est.comfortable_s); })}>${t('app.video.calm', { s: fmtTime(est.comfortable_s) })}</button>
          <button class="btn small" onClick=${() => setJ((vv) => { vv.duration_s = Math.round(est.brisk_s); })}>${t('app.video.lively', { s: fmtTime(est.brisk_s) })}</button>
        </div>` : html`<div class="tiny">${t('ui.journey.pace_wait')}</div>`}
    <//>
    <${Card} title=${t('ui.audio.title')} desc=${t('app.audio.desc')}>
      ${a.enabled ? html`
        <div class="row"><span class="grow ellipsis">${Icon.music({ style: 'width:18px;height:18px;vertical-align:-3px' })} ${a.name}</span>
          <button class="btn small danger" onClick=${() => setSoundtrack(null)}>${t('app.common.remove')}</button></div>
        <${Slider} label=${t('ui.audio.volume')} value=${a.volume} min=${0} max=${1.5} step=${0.05} format=${(x) => Math.round(x * 100) + '%'} onChange=${(x) => edit((q) => { q.audio.volume = x; })} />
        <${Slider} label=${t('ui.audio.fade')} value=${a.fade_out_s} min=${0} max=${8} step=${0.5} format=${(x) => x.toFixed(1) + ' s'} onChange=${(x) => edit((q) => { q.audio.fade_out_s = x; })} />`
      : html`<${FilePick} cls="btn block" accept="audio/*,.mp3,.m4a,.aac,.wav,.ogg,.flac" onFile=${setSoundtrack}>${Icon.music()} ${t('app.audio.pick')}<//>`}
    <//>`;
}

const TABS = [
  ['journey', 'route', 'app.tab.journey'], ['camera', 'camera', 'app.tab.camera'], ['look', 'palette', 'app.tab.look'],
  ['titles', 'type', 'app.tab.titles'], ['video', 'video', 'app.tab.video'],
];

export function Studio() {
  const [tab, setTab] = useState('journey');
  if (!timeline.value) {
    return html`<div class="page"><div class="topbar"><h1>${t('app.nav.studio')}</h1></div>
      <div class="empty">${Icon.studio()}<p>${t('app.studio.empty')}</p>
      <button class="btn primary" onClick=${() => go('home')}>${t('app.home.import')}</button></div></div>`;
  }
  const v = project.value.video;
  const Tab = { journey: JourneyTab, camera: CameraTab, look: LookTab, titles: TitlesTab, video: VideoTab }[tab];
  return html`
    <div class="page">
      <div class="studio-preview"><${Player} /><${StatLine} /></div>
      <div class="tabs" role="tablist">
        ${TABS.map(([k, ic, label]) => html`<button role="tab" aria-selected=${tab === k} class=${tab === k ? 'on' : ''} onClick=${() => setTab(k)}>${Icon[ic]()} ${t(label)}</button>`)}
      </div>
      <${Tab} />
    </div>
    <div class="renderbar"><div class="inner">
      <div class="sum"><b>${project.value.name || timeline.value.name}</b>${v.resolution === '2160p' ? '4K' : v.resolution} · ${v.fps} fps · ${v.aspect} · ${fmtTime(v.duration_s)}</div>
      <button class="btn primary" disabled=${!journeyInfo.value} onClick=${startRender}>${Icon.film()} ${t('app.studio.render')}</button>
    </div></div>`;
}
