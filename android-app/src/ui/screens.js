// Render screen, Library, Settings, About, and the video / confirm sheets.
import { html } from 'htm/preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Icon } from './icons.js';
import { Card, Seg, Toggle, Field, Back, Ring, FilePick, fmtTime, fmtBytes } from './components.js';
import { t, formatNumber, formatDistance, LANGUAGES } from '../i18n/index.js';
import { renderJob, library, settings, device, sheet, go, project, BUILD_CARTO_KEY } from '../app/state.js';
import { cancelRender, leaveRender, saveSettings, verifyCartoKey, removeFromLibrary, applySettingsFrom, exportProjectFile, importProjectFile, resetApp, ask, startRender } from '../app/actions.js';
import { shareVideo, openVideo, openUrl, isNative, downloadBlob } from '../platform/native.js';
import { clearTileCache, tileCacheStats } from '../render/tiles.js';
import { APP_VERSION, RENDER_ENGINE_VERSION } from '../app/project.js';

// ---------------------------------------------------------------- render
export function RenderScreen() {
  const j = renderJob.value;
  const holder = useRef();
  useEffect(() => {
    const el = holder.current;
    if (!el || !j?.preview || j.stage !== 'frames') return;
    if (el.firstChild !== j.preview) { el.innerHTML = ''; el.appendChild(j.preview); }
  }, [j?.preview, j?.stage]);
  if (!j) return null;
  const stages = [['plan', 'app.render.s_plan'], ['tiles', 'app.render.s_tiles'], ['audio', 'app.render.s_audio'], ['frames', 'app.render.s_frames'], ['saving', 'app.render.s_saving']];
  const idx = stages.findIndex((s) => s[0] === j.stage);
  const pct = j.stage === 'frames' ? j.frame / j.frames : j.stage === 'tiles' && j.tilesTotal ? j.tilesDone / j.tilesTotal : j.stage === 'saving' ? 1 : 0;

  if (j.stage === 'done') {
    const r = j.result;
    return html`<div class="full"><div class="page no-nav">
      <div class="topbar"><h1>${t('app.render.done_title')}</h1></div>
      <div class="renderview"><video src=${r.url} controls playsinline autoplay muted loop poster=${r.thumb || ''}></video></div>
      <div class="okbox">${isNative ? t('app.render.saved_gallery') : t('app.render.saved_browser')}</div>
      <div class="stats three" style="margin:10px 0">
        <div class="stat"><div class="v">${Math.min(r.width, r.height) >= 2160 ? '4K' : Math.min(r.width, r.height) + 'p'}</div><div class="k">${r.width}×${r.height} · ${r.fps} fps</div></div>
        <div class="stat"><div class="v">${fmtTime(r.duration)}</div><div class="k">${fmtBytes(r.bytes)}</div></div>
        <div class="stat"><div class="v">${Math.round(r.frames / Math.max(1, r.seconds))} fps</div><div class="k">${t('app.render.speed')}${r.hardware ? ' · HW' : ''}</div></div>
      </div>
      <div class="col">
        <button class="btn primary block" onClick=${() => shareVideo(r)}>${Icon.share()} ${t('app.common.share')}</button>
        ${isNative ? html`<button class="btn block" onClick=${() => openVideo(r)}>${Icon.open()} ${t('app.render.open_player')}</button>`
          : html`<button class="btn block" onClick=${() => downloadBlob(r.blob, r.fileName)}>${Icon.download()} ${t('app.common.download')}</button>`}
        <button class="btn ghost block" onClick=${leaveRender}>${t('app.render.back_studio')}</button>
      </div>
    </div></div>`;
  }
  if (j.stage === 'error' || j.stage === 'cancelled') {
    return html`<div class="full"><div class="page no-nav" style="padding-top:40px">
      <h1>${j.stage === 'cancelled' ? t('app.render.cancelled') : t('app.render.failed')}</h1>
      ${j.error && html`<div class="errbox">${j.error.code === 'no_encoder' ? t('app.render.no_encoder') : j.error.message}</div>`}
      <div class="col" style="margin-top:16px">
        ${j.stage === 'error' && html`<button class="btn primary block" onClick=${startRender}>${t('app.render.retry')}</button>`}
        <button class="btn block" onClick=${leaveRender}>${t('app.render.back_studio')}</button>
      </div></div></div>`;
  }
  return html`<div class="full"><div class="page no-nav">
    <div class="topbar"><h1>${t('app.render.title')}</h1></div>
    ${j.stage === 'frames' ? html`<div class="renderview" ref=${holder}></div>` : html`<${Ring} value=${pct} />`}
    ${j.stage === 'frames' && html`
      <div class="progress"><div style=${`width:${pct * 100}%`}></div></div>
      <div class="row" style="justify-content:space-between;margin-top:8px;font-variant-numeric:tabular-nums">
        <span>${Math.round(pct * 100)}%</span>
        <span class="muted">${formatNumber(j.frame, 0)} / ${formatNumber(j.frames, 0)}</span>
        <span class="muted">${(j.rfps || 0).toFixed(1)} fps</span>
        <span>${t('app.render.eta', { t: fmtTime(j.eta || 0) })}</span>
      </div>`}
    <div class="stagelist">
      ${stages.filter(([k]) => k !== 'audio' || j.stage === 'audio' || project.value.audio.enabled).map(([k, label], i) => {
        const si = stages.findIndex((s) => s[0] === k);
        const cls = si < idx ? 'stage done' : si === idx ? 'stage on' : 'stage';
        const extra = k === 'tiles' && j.tilesTotal ? ` (${j.tilesDone}/${j.tilesTotal})` : '';
        return html`<div class=${cls}><i></i>${t(label)}${extra}</div>`;
      })}
    </div>
    <p class="tiny">${t('app.render.keep_open', { w: j.w, h: j.h, fps: j.fps })}</p>
    <button class="btn danger block" onClick=${async () => { if ((await ask({ title: t('app.render.cancel_q'), actions: [['yes', t('app.render.cancel_yes')], ['no', t('app.render.cancel_no')]] })) === 'yes') cancelRender(); }}>${t('app.common.cancel')}</button>
  </div></div>`;
}

// ---------------------------------------------------------------- library
export function Library() {
  const items = library.value;
  return html`<div class="page">
    <div class="topbar"><div class="grow"><h1>${t('ui.library.title')}</h1><div class="sub">${t('app.library.sub')}</div></div></div>
    ${items.length === 0 ? html`<div class="empty">${Icon.film()}<p>${t('app.library.empty')}</p>
      <button class="btn primary" onClick=${() => go('studio')}>${t('app.nav.studio')}</button></div>`
    : html`<div class="list">${items.map((v) => html`
        <button class="vitem" onClick=${() => (sheet.value = { name: 'video', item: v })}>
          ${v.thumb ? html`<img src=${v.thumb} alt="" />` : html`<div class="ph"></div>`}
          <div class="grow" style="min-width:0">
            <div class="t ellipsis">${v.title}</div>
            <div class="m">${new Date(v.created).toLocaleDateString()} · ${fmtTime(v.duration)} · ${v.height >= 2160 || v.width >= 2160 ? '4K' : Math.min(v.width, v.height) + 'p'}</div>
            <div class="m">${formatDistance(v.km || 0, settings.value.unit, undefined, 0)} · ${fmtBytes(v.bytes)}</div>
          </div></button>`)}</div>`}
  </div>`;
}

export function VideoSheet({ item }) {
  const v = item;
  return html`
    ${v.thumb && html`<img src=${v.thumb} alt="" style="width:100%;border-radius:14px;display:block;margin-bottom:12px" />`}
    <h2>${v.title}</h2>
    <dl class="kv">
      <dt>${t('ui.video.resolution')}</dt><dd>${v.width}×${v.height} · ${v.fps} fps</dd>
      <dt>${t('ui.video.duration')}</dt><dd>${fmtTime(v.duration)} · ${fmtBytes(v.bytes)}</dd>
      <dt>${t('ui.journey.stat.distance')}</dt><dd>${formatDistance(v.km || 0, settings.value.unit)}</dd>
      <dt>${t('ui.video.codec')}</dt><dd>${v.codec}${v.hardware ? ' · HW' : ''}${v.audio ? ' · ' + v.audio.toUpperCase() : ''}</dd>
      <dt>${t('ui.about.row.engine')}</dt><dd>${v.engine}</dd>
    </dl>
    <div class="actions">
      <button class="btn primary block" onClick=${() => (isNative || v.blob ? openVideo(v) : null)} disabled=${!isNative && !v.blob}>${Icon.play()} ${t('ui.library.play')}</button>
      <button class="btn block" onClick=${() => shareVideo(v)} disabled=${!isNative && !v.blob}>${Icon.share()} ${t('app.common.share')}</button>
      ${v.settings && html`<button class="btn block" onClick=${() => applySettingsFrom(v)}>${Icon.wand()} ${t('app.library.reuse')}</button>`}
      <button class="btn ghost block" onClick=${async () => {
        const choice = await ask({ title: t('app.library.remove_q'), actions: [...(isNative && v.uri ? [['file', t('app.library.remove_file')]] : []), ['entry', t('app.library.remove_entry')], ['no', t('app.common.cancel')]] });
        if (choice === 'file') removeFromLibrary(v, true); else if (choice === 'entry') removeFromLibrary(v, false);
      }}>${Icon.trash()} ${t('app.common.remove')}</button>
    </div>`;
}

export function AskSheet({ title, body, actions, resolve }) {
  return html`<h2>${title}</h2>${body && html`<p class="muted">${body}</p>`}
    <div class="actions">${actions.map(([k, label], i) => html`<button class=${'btn block' + (i === 0 ? ' primary' : k === 'cancel' || k === 'no' ? ' ghost' : '')} onClick=${() => resolve(k)}>${label}</button>`)}</div>`;
}

// ---------------------------------------------------------------- settings
export function Settings() {
  const s = settings.value;
  const [key, setKey] = useState(s.cartoKey);
  const [showKey, setShowKey] = useState(false);
  const [check, setCheck] = useState(null);
  const [xyz, setXyz] = useState(s.xyzTemplate);
  const [xyzAttr, setXyzAttr] = useState(s.xyzAttribution);
  const [tiles, setTiles] = useState(null);
  useEffect(() => { tileCacheStats().then(setTiles); }, []);
  const caps = device.value.caps, info = device.value.info;
  return html`<div class="page">
    <div class="topbar"><h1 class="grow">${t('ui.settings.title')}</h1></div>
    <${Card} title=${t('ui.settings.language')}>
      <select class="input" value=${s.language} onChange=${(e) => saveSettings({ language: e.currentTarget.value })}>
        ${Object.entries(LANGUAGES).map(([k, n]) => html`<option value=${k}>${n}</option>`)}
      </select>
      <div class="label" style="margin:14px 0 6px">${t('ui.settings.distance_unit')}</div>
      <${Seg} value=${s.unit} onChange=${(v) => saveSettings({ unit: v })} options=${[['km', t('ui.settings.unit.km')], ['mi', t('ui.settings.unit.mi')]]} />
      <${Toggle} label=${t('ui.settings.reduced_motion')} value=${s.reducedMotion} onChange=${(v) => { saveSettings({ reducedMotion: v }); document.body.classList.toggle('reduced', v); }} />
    <//>
    <${Card} title=${t('ui.settings.carto_key')} desc=${t('app.settings.key_note')}>
      <div class="row">
        <input class="input grow" type=${showKey ? 'text' : 'password'} value=${key} placeholder=${t('ui.settings.carto_key_placeholder')} autocomplete="off" autocapitalize="off" spellcheck="false" onInput=${(e) => setKey(e.currentTarget.value)} />
        <button class="iconbtn" aria-label=${t('ui.settings.carto_key_show')} onClick=${() => setShowKey(!showKey)}>${Icon.key()}</button>
      </div>
      <div class="row wrap" style="margin-top:10px">
        <button class="btn small primary" onClick=${async () => { await saveSettings({ cartoKey: key.trim() }); setCheck({ busy: true }); setCheck(await verifyCartoKey(key)); }}>${t('app.settings.save_verify')}</button>
        <button class="btn small ghost" onClick=${() => openUrl('https://carto.com/basemaps/apikey/')}>${t('app.settings.get_key')}</button>
        ${s.cartoKey && html`<button class="btn small ghost" onClick=${() => { setKey(''); saveSettings({ cartoKey: '' }); setCheck(null); }}>${t('app.common.remove')}</button>`}
      </div>
      ${!s.cartoKey && BUILD_CARTO_KEY && html`<div class="tiny" style="margin-top:8px">${t('ui.settings.carto_key_from_build')}</div>`}
      ${check?.busy && html`<div class="tiny" style="margin-top:8px">${t('ui.settings.carto_key_checking')}</div>`}
      ${check && !check.busy && html`<div class=${check.ok ? 'okbox' : 'warnbox'}>${check.message}</div>`}
    <//>
    <${Card} title=${t('app.settings.xyz')} desc=${t('app.settings.xyz_note')}>
      <${Field} label=${t('app.settings.xyz_url')}><input class="input" value=${xyz} placeholder="https://tiles.example.com/{z}/{x}/{y}.png" autocapitalize="off" spellcheck="false" onInput=${(e) => setXyz(e.currentTarget.value)} /><//>
      <${Field} label=${t('app.settings.xyz_attr')}><input class="input" value=${xyzAttr} placeholder="© …" onInput=${(e) => setXyzAttr(e.currentTarget.value)} /><//>
      <button class="btn small" disabled=${xyz && !/^https:\/\/.+\{z\}.+\{x\}.+\{y\}/.test(xyz)} onClick=${() => saveSettings({ xyzTemplate: xyz.trim(), xyzAttribution: xyzAttr.trim() })}>${t('app.common.save')}</button>
    <//>
    <${Card} title=${t('ui.settings.maps')}>
      <div class="row"><span class="grow muted">${t('app.settings.tile_cache', { n: formatNumber(tiles?.count || 0, 0) })}</span>
        <button class="btn small ghost" onClick=${async () => { await clearTileCache(); setTiles(await tileCacheStats()); }}>${t('ui.settings.clear_cache')}</button></div>
      <p class="tiny">${t('ui.settings.tiles_policy')}</p>
    <//>
    <${Card} title=${t('app.settings.projects')}>
      <div class="row wrap">
        <button class="btn small" onClick=${exportProjectFile}>${Icon.download()} ${t('app.settings.export_project')}</button>
        <${FilePick} cls="btn small" accept=".nrproj,application/json" onFile=${importProjectFile}>${Icon.folder()} ${t('app.settings.import_project')}<//>
      </div>
      <p class="tiny">${t('app.settings.projects_note')}</p>
    <//>
    <${Card} title=${t('app.settings.device')}>
      <dl class="kv">
        <dt>${t('app.settings.model')}</dt><dd class="ellipsis">${info?.model || '–'}</dd>
        ${info?.sdk ? html`<dt>Android</dt><dd>${info.release} (API ${info.sdk})</dd>` : ''}
        ${info?.totalMemMB ? html`<dt>RAM</dt><dd>${formatNumber(info.totalMemMB / 1024, 1)} GB</dd>` : ''}
        ${caps?.sizes && Object.entries(caps.sizes).map(([k, v]) => html`<dt>${k === '2160p' ? '4K' : k}</dt><dd>${v.ok ? (v.hw ? t('app.settings.hw') : t('app.settings.sw')) : t('app.settings.unsupported')}</dd>`)}
      </dl>
    <//>
    <${Card}>
      <button class="btn block" onClick=${() => go('about')}>${Icon.info()} ${t('app.nav.about')}</button>
      <div class="spacer"></div>
      <button class="btn danger block" onClick=${async () => { if ((await ask({ title: t('app.settings.reset_q'), body: t('app.settings.reset_body'), actions: [['yes', t('app.settings.reset')], ['no', t('app.common.cancel')]] })) === 'yes') resetApp(); }}>${Icon.trash()} ${t('app.settings.reset')}</button>
    <//>
  </div>`;
}

// ---------------------------------------------------------------- about
export function About() {
  const nodes = ['import', 'journey', 'camera', 'tiles', 'frames', 'encode', 'verify'];
  return html`<div class="page">
    <div class="topbar"><${Back} onClick=${() => history.length > 1 ? go('settings') : go('home')} /><h1 class="grow">${t('ui.about.title')}</h1></div>
    <div class="card glow-card center" style="padding:22px">
      <img src="./brand/lockup_dark.png" alt="TimelinerX" style="max-width:280px;width:80%" />
      <p class="muted" style="margin:14px 0 4px">${t('app.about.tagline')}</p>
      <div class="tiny">${t('ui.about.version', { version: APP_VERSION + ' (Android)', engine: RENDER_ENGINE_VERSION })}</div>
    </div>
    <${Card} title=${t('ui.settings.privacy')}><p class="muted" style="margin:0">${t('app.about.privacy')}</p><//>
    <${Card} title=${t('ui.about.flow')}>
      <div class="pipeline">${nodes.map((n, i) => html`<div class="pipe"><div class="rail"><i></i>${i < nodes.length - 1 ? html`<b></b>` : ''}</div>
        <div class="body"><strong>${t('ui.about.node.' + n)}</strong><p>${t('app.about.detail.' + n)}</p></div></div>`)}</div>
    <//>
    <div class="card madewith">
      <img src="./brand/mark_square.png" alt="" />
      <h2 style="margin-top:10px">${t('ui.about.made_with', { workspace: 'NuRichter Workspace' })}</h2>
      <div class="row" style="justify-content:center;margin-top:14px">
        <button class="btn small" onClick=${() => openUrl('https://www.linkedin.com/in/nurichter/')}>${Icon.linkedin()} LinkedIn</button>
        <button class="btn small" onClick=${() => openUrl('https://github.com/NuRichter')}>${Icon.github()} GitHub</button>
      </div>
    </div>
    <${Card} title=${t('ui.about.credits')}>
      <p class="muted tiny" style="margin:0">${t('app.about.credits')}</p>
      <div class="tiny" style="margin-top:10px">${t('ui.about.row.license')}: MIT</div>
    <//>
  </div>`;
}
