// End-to-end render test (runs in a real browser): demo Timeline -> journey -> camera plan ->
// Offline World tiles graded by theme -> frames -> WebCodecs H.264 -> MP4 bytes.
import { demoTimeline } from '../../src/engine/demo.js';
import { importTimeline } from '../../src/engine/importer.js';
import { buildJourney } from '../../src/engine/journey.js';
import { planFrames } from '../../src/engine/planner.js';
import { getTheme, THEME_IDS } from '../../src/render/grading.js';
import { makeProvider, MapCompositor } from '../../src/render/tiles.js';
import { FrameRenderer } from '../../src/render/renderer.js';
import { loadFonts } from '../../src/render/fonts.js';
import { renderVideo, MemorySink, bitrateFor, encoderCapabilities } from '../../src/export/encoder.js';

const q = new URLSearchParams(location.search);
async function setup(themeId, w, h, fps, dur, lang = 'en', layout = 'corner', mode = 'active', provider = 'world') {
  await loadFonts('/fonts/');
  const tl = await importTimeline({ json: demoTimeline(2025) });
  const j = buildJourney(tl, {});
  const plan = planFrames(j, { mode }, { width: w, height: h, fps, durationS: dur });
  const theme = getTheme(themeId);
  const prov = await makeProvider(provider, theme, { worldBase: '/world/' });
  const comp = new MapCompositor(prov, theme, { lang });
  const renderer = new FrameRenderer({ journey: j, plan, theme, compositor: comp, trail: {}, title: { name: 'Java · Bali · Perth', language: lang, layout }, attribution: prov.attribution, grain: q.get('grain') !== '0' });
  const canvas = document.getElementById('c'); canvas.width = w; canvas.height = h;
  return { j, plan, renderer, canvas };
}

window.__frames = async (themeId, frames, w = 1280, h = 720, lang = 'en', layout = 'corner', mode = 'active') => {
  const { renderer, canvas, plan } = await setup(themeId, w, h, 30, 20, lang, layout, mode);
  const ctx = canvas.getContext('2d');
  const out = [];
  for (const fr of frames) {
    const f = Math.round(fr * (plan.frameCount - 1));
    const t0 = performance.now();
    await renderer.prepare(f);
    const t1 = performance.now();
    renderer.draw(ctx, f);
    const t2 = performance.now();
    out.push({ f, prep: t1 - t0, draw: t2 - t1, png: canvas.toDataURL('image/png') });
  }
  return out;
};

window.__render = async (themeId, w, h, fps, dur) => {
  const { renderer, canvas, plan } = await setup(themeId, w, h, fps, dur);
  const sink = new MemorySink();
  const res = await renderVideo({ renderer, canvas, fps, frames: plan.frameCount, bitrate: bitrateFor(w, h, fps, 'high'), sink });
  const buf = new Uint8Array(await res.blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return { ...res, blob: undefined, b64: btoa(s) };
};
window.__caps = () => encoderCapabilities();
window.__themes = THEME_IDS;
window.__ready = true;
window.__profile = async (themeId, w, h, fps, dur, n = 90) => {
  const { renderer, canvas, plan } = await setup(themeId, w, h, fps, dur);
  const ctx = canvas.getContext('2d');
  const comp = renderer.comp;
  let produced = 0; const orig = comp._produce.bind(comp);
  let prodMs = 0;
  comp._produce = async (...a) => { const t = performance.now(); const r = await orig(...a); prodMs += performance.now() - t; produced++; return r; };
  let tp = 0, td = 0, tv = 0;
  const step = Math.max(1, Math.floor(plan.frameCount / n));
  for (let f = 0; f < plan.frameCount; f += step) {
    let t = performance.now(); await renderer.prepare(f); tp += performance.now() - t;
    t = performance.now(); renderer.draw(ctx, f); td += performance.now() - t;
    t = performance.now(); const vf = new VideoFrame(canvas, { timestamp: f }); vf.close(); tv += performance.now() - t;
  }
  return { frames: Math.ceil(plan.frameCount / step), prepMs: tp, drawMs: td, frameGrabMs: tv, tilesProduced: produced, produceMs: prodMs };
};
window.__encbench = async (w, h, latency, n = 60) => {
  const canvas = document.getElementById('c'); canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const out = {};
  for (const lm of latency) {
    let chunks = 0;
    const enc = new VideoEncoder({ output: () => chunks++, error: (e) => console.error(e) });
    enc.configure({ codec: 'avc1.64001f', width: w, height: h, bitrate: 3e6, framerate: 30, latencyMode: lm, avc: { format: 'avc' } });
    const t0 = performance.now();
    let wait = 0;
    for (let f = 0; f < n; f++) {
      ctx.fillStyle = `hsl(${f * 5},60%,40%)`; ctx.fillRect(0, 0, w, h); ctx.fillStyle = '#fff'; ctx.fillRect(f * 10 % w, 100, 200, 200);
      const vf = new VideoFrame(canvas, { timestamp: f * 33333 });
      enc.encode(vf, { keyFrame: f % 60 === 0 }); vf.close();
      const tw = performance.now();
      while (enc.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 1));
      wait += performance.now() - tw;
    }
    await enc.flush();
    out[lm] = { ms: performance.now() - t0, wait, chunks };
    enc.close();
  }
  return out;
};
window.__encbench2 = async (n = 30) => {
  const { renderer, canvas, plan } = await setup('neon_dark_purple', 1280, 720, 30, 6);
  const ctx = canvas.getContext('2d');
  await renderer.prepare(60); renderer.draw(ctx, 60);
  const img = ctx.getImageData(0, 0, 1280, 720);
  const res = {};
  for (const mode of ['canvas', 'rgba']) {
    const enc = new VideoEncoder({ output: () => {}, error: (e) => console.error(e) });
    enc.configure({ codec: 'avc1.64001f', width: 1280, height: 720, bitrate: 3e6, framerate: 30, latencyMode: 'quality', avc: { format: 'avc' } });
    const t0 = performance.now();
    for (let f = 0; f < n; f++) {
      const vf = mode === 'canvas' ? new VideoFrame(canvas, { timestamp: f * 33333 }) : new VideoFrame(img.data, { format: 'RGBA', codedWidth: 1280, codedHeight: 720, timestamp: f * 33333 });
      enc.encode(vf, { keyFrame: f === 0 }); vf.close();
      while (enc.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 1));
    }
    await enc.flush(); enc.close();
    res[mode] = performance.now() - t0;
  }
  return res;
};
