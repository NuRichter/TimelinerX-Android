// Client for the engine worker (falls back to running on the main thread if workers are unavailable).
import { Journey } from '../engine/journey.js';

let worker = null;
let seq = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (ev) => {
    const { id, done, error, value, progress } = ev.data;
    const p = pending.get(id);
    if (!p) return;
    if (progress !== undefined) { p.onProgress?.(progress); return; }
    if (done) {
      pending.delete(id);
      if (error) p.reject(Object.assign(new Error(error.message), { code: error.code, hint: error.hint }));
      else p.resolve(value);
    }
  };
  worker.onerror = (e) => { for (const p of pending.values()) p.reject(new Error(e.message || 'Engine worker failed')); pending.clear(); };
  return worker;
}

export function call(op, args, { onProgress, transfer = [] } = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject, onProgress });
    getWorker().postMessage({ id, op, args }, transfer);
  });
}

export const importTimelineRemote = (args, onProgress) => call('import', args, { onProgress });
export const restoreTimeline = (tl) => call('restore', tl);
export async function buildJourneyRemote(cfg) { return Journey.fromData(await call('journey', { cfg })); }
export async function planRemote(args) {
  const r = await call('plan', args);
  return { plan: r.plan, journey: Journey.fromData(r.journey) };
}
export const recommendRemote = (args) => call('recommend', args);
