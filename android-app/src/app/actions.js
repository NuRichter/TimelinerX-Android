// App actions: import, journey refresh, render orchestration, library and settings.
import {
  settings, project, timeline, importState, journeyInfo, journeyError, estimate, renderJob, library, device, sheet,
  toast, go, updateProject, langTick, effectiveSettings,
} from './state.js';
import { defaultProject, mergeProject, cameraConfig, journeyConfig, resolveDimensions, toNrproj, fromNrproj, RENDER_ENGINE_VERSION } from './project.js';
import { importTimelineRemote, restoreTimeline, buildJourneyRemote, planRemote, recommendRemote } from './engine.js';
import { kvGet, kvSet, kvDel, libraryAll, libraryPut, libraryDel, persistStorage } from '../platform/store.js';
import {
  isNative, NativeSink, keepAwake, deviceInfo, onIncomingFile, fileSrc, deleteMedia, mediaExists, clearExports, downloadBlob, nativeFetchBlob, shareFile, deleteCacheFile,
} from '../platform/native.js';
import { isoOfDay } from '../engine/journey.js';
import { getTheme } from '../render/grading.js';
import { makeProvider, MapCompositor, setNativeFetch, fetchTileBytes } from '../render/tiles.js';
import { FrameRenderer } from '../render/renderer.js';
import { loadFonts } from '../render/fonts.js';
import { renderVideo, MemorySink, bitrateFor, encoderCapabilities, decodeAudioFile, prepareSoundtrack, RenderCancelled } from '../export/encoder.js';
import { setLanguage, guessLanguage, t } from '../i18n/index.js';

setNativeFetch(nativeFetchBlob);
let audioBlob = null;

// ------------------------------------------------------------------ boot
export async function init() {
  const s = await kvGet('settings');
  const lang = s?.language || guessLanguage(navigator.languages || [navigator.language]);
  settings.value = { ...settings.value, ...(s || {}), language: lang };
  setLanguage(lang);
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  const p = await kvGet('project');
  project.value = mergeProject(defaultProject(lang, settings.value.unit), p || {});
  audioBlob = (await kvGet('audio')) || null;
  const tl = await kvGet('timeline');
  if (tl?.semantic) {
    try {
      const r = await restoreTimeline({ semantic: tl.semantic, raw: tl.raw, diagnostics: tl.diagnostics });
      timeline.value = { name: tl.name, summary: r.summary, diagnostics: tl.diagnostics };
      refreshJourney(true);
    } catch (e) { console.warn('restore', e); }
  }
  library.value = await libraryAll();
  persistStorage();
  clearExports();
  loadFonts('./fonts/');
  onIncomingFile((f) => {
    if (f.error) { toast(t('app.import.receive_failed'), 'error'); return; }
    importFrom({ url: f.url, name: f.name, size: f.size });
  });
  deviceInfo().then((info) => { device.value = { ...device.value, info }; });
  encoderCapabilities().then((caps) => { device.value = { ...device.value, caps }; }).catch(() => {});
  verifyLibrary();
}

export async function saveSettings(patch) {
  const prev = settings.value;
  settings.value = { ...prev, ...patch };
  await kvSet('settings', settings.value);
  if (patch.language && patch.language !== prev.language) {
    setLanguage(patch.language);
    document.documentElement.lang = patch.language;
    document.documentElement.dir = patch.language === 'ar' ? 'rtl' : 'ltr';
    langTick.value++;
  }
}

let saveTimer = null;
export function persistProject() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => kvSet('project', project.value), 400);
}

// ------------------------------------------------------------------ import
export async function importFrom(src) {
  const name = src.demo ? t('app.demo.name') : (src.name || src.file?.name || 'Timeline.json');
  importState.value = { name, progress: 0 };
  sheet.value = null;
  go('home');
  try {
    const args = src.demo ? { demo: new Date().getFullYear() - 1 } : src.file ? { file: src.file, name } : { url: src.url, size: src.size, name };
    const r = await importTimelineRemote(args, (p) => { importState.value = { name, progress: p }; });
    await kvSet('timeline', { name, semantic: r.semantic, raw: r.raw, diagnostics: r.diagnostics });
    timeline.value = { name, summary: r.summary, diagnostics: r.diagnostics, demo: !!src.demo };
    updateProject((p) => {
      p.timeline = { name, points: r.summary.points };
      p.period = { start: null, end: null };
      p.camera.keyframes = [];
      if (src.demo) { p.name = t('app.demo.title'); p.title.name = p.name; p.video.duration_s = 30; }
      else if (!p.name) p.name = '';
    });
    persistProject();
    importState.value = null;
    await refreshJourney(true);
    sheet.value = { name: 'analysis' };
  } catch (e) {
    importState.value = { name, progress: 1, error: { message: e.message, code: e.code, hint: e.hint } };
  }
}

export function closeImport() { importState.value = null; }

// ------------------------------------------------------------------ journey + estimate
let jTimer = null, jSeq = 0;
export function refreshJourney(now = false) {
  clearTimeout(jTimer);
  return new Promise((resolve) => {
    jTimer = setTimeout(async () => {
      const seq = ++jSeq;
      if (!timeline.value) { resolve(); return; }
      const p = project.value;
      try {
        const j = await buildJourneyRemote(journeyConfig(p));
        if (seq !== jSeq) { resolve(); return; }
        journeyError.value = null;
        journeyInfo.value = { stats: j.stats, totalKm: j.totalKm, trips: j.tripCount, legs: j.legs, xs: j.xs, ys: j.ys, hopMode: j.hopMode, cum: j.cum };
        const [w, h] = resolveDimensions(p.video.resolution, p.video.aspect);
        estimate.value = null;
        recommendRemote({ jcfg: journeyConfig(p), ccfg: cameraConfig(p), width: w, height: h })
          .then((r) => { if (seq === jSeq) estimate.value = r; }).catch(() => {});
      } catch (e) {
        if (seq !== jSeq) { resolve(); return; }
        journeyInfo.value = null;
        journeyError.value = { message: e.message, code: e.code };
      }
      resolve();
    }, now ? 0 : 350);
  });
}

export function setPeriod(start, end) {
  updateProject((p) => { p.period = { start, end }; });
  persistProject();
  refreshJourney();
}

export function yearsInTimeline() {
  const s = timeline.value?.summary;
  if (!s) return [];
  const y0 = new Date(s.minDay * 86400000).getUTCFullYear(), y1 = new Date(s.maxDay * 86400000).getUTCFullYear();
  const out = [];
  for (let y = y1; y >= y0; y--) out.push(y);
  return out;
}
export const dayIso = isoOfDay;

// ------------------------------------------------------------------ dialogs
export function ask(opts) {
  return new Promise((resolve) => { sheet.value = { name: 'ask', ...opts, resolve: (v) => { sheet.value = null; resolve(v); } }; });
}

// ------------------------------------------------------------------ audio
export async function setSoundtrack(file) {
  if (!file) { audioBlob = null; await kvDel('audio'); updateProject((p) => { p.audio.enabled = false; p.audio.name = ''; }); persistProject(); return; }
  try {
    const buf = await decodeAudioFile(file);
    audioBlob = file;
    await kvSet('audio', file);
    updateProject((p) => { p.audio.enabled = true; p.audio.name = file.name; p.audio.duration = buf.duration; });
    persistProject();
  } catch { toast(t('app.audio.bad'), 'error'); }
}

// ------------------------------------------------------------------ render
let abortCtl = null;
export function cancelRender() { abortCtl?.abort(); }

function slug(s) { return (s || 'timelinerx').normalize('NFKD').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60) || 'timelinerx'; }

export async function startRender() {
  const p = structuredClone(project.value);
  const [w, h] = resolveDimensions(p.video.resolution, p.video.aspect);
  const fps = p.video.fps, dur = p.video.duration_s;
  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  const job = { stage: 'plan', w, h, fps, dur, frame: 0, frames: Math.round(dur * fps), started: Date.now(), preview: null };
  const set = (patch) => { Object.assign(job, patch); renderJob.value = { ...job }; };
  set({});
  go('render');
  await keepAwake(true);
  let comp = null;
  try {
    await loadFonts('./fonts/');
    const { plan, journey } = await planRemote({ jcfg: journeyConfig(p), ccfg: cameraConfig(p), width: w, height: h, fps, durationS: dur });
    if (signal.aborted) throw new RenderCancelled();
    const theme = getTheme(p.visual.theme);
    let provider = await makeProvider(p.visual.map_provider, theme, effectiveSettings.value);
    if (provider.missingKey) {
      const choice = await ask({ title: t('app.render.nokey_title'), body: t('app.render.nokey_body'), actions: [['world', t('app.render.use_world')], ['cancel', t('app.common.cancel')]] });
      if (choice !== 'world') throw new RenderCancelled();
      provider = await makeProvider('world', theme, effectiveSettings.value);
    }
    comp = new MapCompositor(provider, theme, { lang: p.title.language, labels: p.visual.labels, lru: w * h > 4e6 ? 480 : 320 });
    set({ stage: 'tiles', tilesDone: 0, tilesTotal: 0 });
    const rep = await comp.prefetchPlan(plan, w, { signal, onProgress: (d, n) => set({ tilesDone: d, tilesTotal: n }) });
    if (signal.aborted) throw new RenderCancelled();
    if (rep.failed.size) {
      const choice = await ask({
        title: t('app.render.tiles_failed_title'), body: t('app.render.tiles_failed_body', { n: rep.failed.size, total: rep.requested }),
        actions: [['placeholder', t('app.render.continue_placeholder')], ['world', t('app.render.use_world')], ['cancel', t('app.common.cancel')]],
      });
      if (choice === 'cancel' || !choice) throw new RenderCancelled();
      if (choice === 'world') { comp.dispose(); provider = await makeProvider('world', theme, effectiveSettings.value); comp = new MapCompositor(provider, theme, { lang: p.title.language, labels: p.visual.labels }); }
    }
    let soundtrack = null;
    if (p.audio.enabled && audioBlob) {
      set({ stage: 'audio' });
      try { soundtrack = await prepareSoundtrack(await decodeAudioFile(audioBlob), { durationS: dur, volume: p.audio.volume, fadeOutS: p.audio.fade_out_s }); } catch (e) { console.warn(e); toast(t('app.audio.bad'), 'error'); }
    }
    const renderer = new FrameRenderer({
      journey, plan, theme, compositor: comp, trail: p.visual.trail, title: p.title, attribution: provider.attribution,
      vignette: p.visual.vignette, grain: p.visual.grain,
    });
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const fileName = `TimelinerX-${slug(p.name || renderer.overlays.title)}-${stamp}.mp4`;
    const sink = isNative ? new NativeSink(fileName, fileName) : new MemorySink();
    let thumb = null;
    const thumbAt = Math.floor(plan.frameCount * 0.62);
    const previewCanvas = document.createElement('canvas');
    const pw = 480, ph = Math.round((480 * h) / w);
    previewCanvas.width = pw; previewCanvas.height = ph;
    set({ stage: 'frames', preview: previewCanvas });
    const res = await renderVideo({
      renderer, canvas, fps, frames: plan.frameCount, bitrate: bitrateFor(w, h, fps, p.video.quality), codec: p.video.codec,
      soundtrack, sink, signal,
      onProgress: (pr) => set({ frame: pr.frame, rfps: pr.fps, eta: pr.eta }),
      onFrame: (f) => {
        if (f % 3 === 0 || f === plan.frameCount - 1) previewCanvas.getContext('2d').drawImage(canvas, 0, 0, pw, ph);
        if (f === thumbAt) {
          const c = document.createElement('canvas');
          c.width = 360; c.height = Math.round((360 * h) / w);
          c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
          thumb = c.toDataURL('image/jpeg', 0.82);
        }
      },
    });
    set({ stage: 'saving' });
    const item = {
      id: 'v' + Date.now(), created: Date.now(), title: renderer.overlays.title, fileName, width: w, height: h, fps,
      duration: dur, frames: res.frames, bytes: res.bytes, codec: res.codec, hardware: res.hardware, audio: res.audio,
      uri: res.uri || null, path: res.path || null, thumb, theme: p.visual.theme, km: journey.totalKm, trips: journey.tripCount,
      days: journey.stats.days, engine: RENDER_ENGINE_VERSION, seconds: res.seconds, settings: toNrproj(p),
      blob: isNative ? null : res.blob,
    };
    await libraryPut(item);
    library.value = await libraryAll();
    set({ stage: 'done', result: { ...item, url: res.path ? fileSrc(res.path) : res.blob ? URL.createObjectURL(res.blob) : null } });
  } catch (e) {
    if (e instanceof RenderCancelled || e?.code === 'cancelled' || signal.aborted) set({ stage: 'cancelled' });
    else { console.error(e); set({ stage: 'error', error: { message: e.message || String(e), code: e.code } }); }
  } finally {
    comp?.dispose();
    await keepAwake(false);
  }
}

export function leaveRender() {
  const r = renderJob.value?.result;
  if (r?.path && r.uri) deleteCacheFile(r.path);   // the gallery copy is the one we keep
  renderJob.value = null;
  go('studio');
}

// ------------------------------------------------------------------ library
export async function verifyLibrary() {
  if (!isNative) return;
  const items = await libraryAll();
  let changed = false;
  for (const it of items) {
    if (it.uri && !(await mediaExists(it.uri))) { await libraryDel(it.id); changed = true; }
  }
  if (changed) library.value = await libraryAll();
}

export async function removeFromLibrary(item, alsoDeleteFile) {
  if (alsoDeleteFile && item.uri) {
    try { await deleteMedia(item.uri); } catch (e) { toast(e.message || t('app.library.delete_failed'), 'error'); return; }
  }
  await libraryDel(item.id);
  library.value = await libraryAll();
  sheet.value = null;
}

export function applySettingsFrom(item) {
  if (!item.settings) return;
  project.value = fromNrproj(item.settings, project.value);
  persistProject();
  refreshJourney(true);
  sheet.value = null;
  go('studio');
  toast(t('app.library.applied'));
}

// ------------------------------------------------------------------ settings helpers
export async function verifyCartoKey(key) {
  key = (key || '').trim();
  if (!key) return { ok: false, message: t('app.settings.key_empty') };
  const base = 'https://basemaps.cartocdn.com/rastertiles/voyager/2/3/1.png';
  const keyed = await fetchTileBytes(base + '?key=' + encodeURIComponent(key));
  if (!keyed.ok) {
    if (keyed.status === 401 || keyed.status === 403) return { ok: false, message: t('app.settings.key_rejected', { code: keyed.status }) };
    return { ok: false, message: t('app.settings.key_unreachable') };
  }
  const plain = await fetchTileBytes(base);
  if (plain.ok) {
    const [a, b] = await Promise.all([keyed.blob.arrayBuffer(), plain.blob.arrayBuffer()].map((p) => p.then((x) => crypto.subtle.digest('SHA-256', x))));
    const same = new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);
    if (same) return { ok: false, message: t('app.settings.key_watermarked') };
  }
  return { ok: true, message: t('app.settings.key_ok') };
}

export async function exportProjectFile() {
  const blob = new Blob([JSON.stringify(toNrproj(project.value), null, 2)], { type: 'application/json' });
  const name = `${slug(project.value.name || 'journey')}.nrproj`;
  try { await shareFile(blob, name, 'application/json'); } catch (e) { toast(e.message || String(e), 'error'); }
}

export async function importProjectFile(file) {
  try {
    const d = JSON.parse(await file.text());
    project.value = fromNrproj(d, project.value);
    persistProject();
    refreshJourney(true);
    toast(t('app.settings.project_loaded'));
  } catch (e) { toast(e.message, 'error'); }
}

export async function resetApp() {
  for (const k of ['timeline', 'project', 'audio']) await kvDel(k);
  for (const it of await libraryAll()) await libraryDel(it.id);
  await clearExports();
  timeline.value = null; journeyInfo.value = null; library.value = [];
  project.value = defaultProject(settings.value.language, settings.value.unit);
  go('home');
}
