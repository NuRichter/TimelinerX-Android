// Engine worker: import, journey building and camera planning run off the UI thread.
import { importTimeline, timelineSummary } from '../engine/importer.js';
import { buildJourney } from '../engine/journey.js';
import { planFrames, recommendDuration } from '../engine/planner.js';
import { demoTimeline } from '../engine/demo.js';

let timeline = null;
let journey = null;
let journeyKey = '';

const cols = (c) => [c.t.buffer, c.off.buffer, c.tzm.buffer, c.lat.buffer, c.lon.buffer, c.kind.buffer, c.acc.buffer, c.mode.buffer];
function cloneCols(c) {
  const o = { n: c.n };
  for (const k of ['t', 'off', 'tzm', 'lat', 'lon', 'kind', 'acc', 'mode']) o[k] = c[k].slice();
  return o;
}
function summary(tl) {
  const s = timelineSummary(tl);
  const days = [...s.perDay.entries()].sort((a, b) => a[0] - b[0]);
  return { points: s.points, semantic: s.semantic, raw: s.raw, minDay: s.minDay, maxDay: s.maxDay, days };
}

const handlers = {
  async import({ file, url, size, name, demo }, post) {
    const onProgress = (p) => post({ progress: p });
    let src;
    if (demo) src = { json: demoTimeline(demo) };
    else if (file) src = file;
    else if (url) {
      const r = await fetch(url);
      if (!r.ok) throw new Error('Cannot read the received file (' + r.status + ')');
      src = { stream: r.body, size: size || Number(r.headers.get('content-length')) || 0 };
    }
    timeline = await importTimeline(src, { onProgress, name });
    journey = null; journeyKey = '';
    const semantic = cloneCols(timeline.semantic), raw = cloneCols(timeline.raw);
    return { value: { semantic, raw, diagnostics: timeline.diagnostics, summary: summary(timeline) }, transfer: [...cols(semantic), ...cols(raw)] };
  },
  async restore({ semantic, raw, diagnostics }) {
    timeline = { semantic, raw, diagnostics };
    journey = null; journeyKey = '';
    return { value: { summary: summary(timeline) } };
  },
  async journey({ cfg }) {
    if (!timeline) throw Object.assign(new Error('No Timeline loaded'), { code: 'no_timeline' });
    const key = JSON.stringify(cfg);
    if (key !== journeyKey || !journey) { journey = buildJourney(timeline, cfg); journeyKey = key; }
    return { value: journey.toData() };
  },
  async plan({ jcfg, ccfg, width, height, fps, durationS }) {
    const r = await handlers.journey({ cfg: jcfg });
    const plan = planFrames(journey, ccfg, { width, height, fps, durationS });
    const tr = [plan.cx.buffer, plan.cy.buffer, plan.span.buffer, plan.mx.buffer, plan.my.buffer, plan.md.buffer, plan.phase.buffer, plan.outro.buffer, plan.intro.buffer];
    return { value: { plan, journey: r.value }, transfer: tr };
  },
  async recommend({ jcfg, ccfg, width, height }) {
    await handlers.journey({ cfg: jcfg });
    return { value: recommendDuration(journey, ccfg, width, height) };
  },
};

self.onmessage = async (ev) => {
  const { id, op, args } = ev.data;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    const res = await handlers[op](args || {}, post);
    self.postMessage({ id, done: true, value: res.value }, res.transfer || []);
  } catch (e) {
    self.postMessage({ id, done: true, error: { message: e.message || String(e), code: e.code || 'error', hint: e.hint || '' } });
  }
};
