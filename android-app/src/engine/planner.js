// Camera Planner, the "Absolute Cinema" camera (port of camera/planner.py, engine tlx-2.0.0).
// Framing layer adapted from Google Timeline Visualizer (c) 2025 mahlernim (MIT); cinema layer
// (zero-phase smoothing, Catmull-Rom sampling, anticipation, rule-of-thirds lead room, van Wijk-Nuij
// intro/outro, Director's-Cut keyframes, visibility guard) by NuRichter.
import {
  EASINGS, catmullRomSample, gaussianSmooth, interp, lerp, smootherstep, smoothstep, zoomPanInterpolator, spikeRatio,
} from './easing.js';
import { WORLD_SPAN, bisectLeft, bisectRight, latlonToMeters, pyRound, median } from './geo.js';
import { buildLegs, distanceCompressionTiming, hermiteMap, transferThresholdKm } from './journey.js';
import { Mode } from './modes.js';

export const CAMERA_MODES = {
  fixed: { context_fraction: 0.10, minimum_context_km: 25.0, maximum_context_km: 350.0, padding: 2.6, minimum_span: 0.00060, zoom_out_alpha: 0.0, zoom_in_alpha: 0.0, leg_aware: false, fixed_zoom: true, lead: 0.0, anticipation_s: 0.0, smooth_s: 0.9 },
  balanced: { context_fraction: 1.00, minimum_context_km: 650.0, maximum_context_km: 650.0, padding: 2.8, minimum_span: 0.00060, zoom_out_alpha: 0.14, zoom_in_alpha: 0.035, leg_aware: false, fixed_zoom: false, lead: 0.35, anticipation_s: 0.25, smooth_s: 1.1 },
  active: { context_fraction: 0.10, minimum_context_km: 100.0, maximum_context_km: 350.0, padding: 2.2, minimum_span: 0.00045, zoom_out_alpha: 0.24, zoom_in_alpha: 0.06, leg_aware: true, fixed_zoom: false, lead: 0.6, anticipation_s: 0.30, smooth_s: 0.8 },
  close_up: { context_fraction: 0.035, minimum_context_km: 6.0, maximum_context_km: 120.0, padding: 1.7, minimum_span: 0.00030, zoom_out_alpha: 0.30, zoom_in_alpha: 0.075, leg_aware: true, fixed_zoom: false, lead: 0.7, anticipation_s: 0.30, smooth_s: 0.7 },
};
export const ZOOM_STYLES = ['fixed', 'balanced', 'active', 'close_up'];
export const LEGACY_CAMERA_MODES = { steady: 'balanced', dynamic: 'active' };
export const LONG_TRIP_PACING = { natural: 1.0, balanced: 0.72, faster: 0.48, fastest: 0.30 };
export const LEGACY_PACING = { off: 'natural', gentle: 'balanced', strong: 'faster', stronger: 'fastest' };
const MIN_LONG_TRIP_S = 0.45;
const COMFORT_SPEED_VP_S = 0.30;
const BRISK_SPEED_VP_S = 0.55;
export const LOCAL_FRAMING = { off: [false, 1.0], balanced: [true, 1.0], close: [true, 0.78] };
const TRANSFER_PADDING = 2.8;
const DEAD_ZONE_HALF = 0.20;
const FIXED_ZOOM_PERCENTILE = 0.80;
const VISUAL_ZOOM_WORK_WEIGHT = 0.35;
const EPISODE_ARRIVAL_ZOOM_START = 0.65;
const MIN_CONTEXT_KM = 15.0;
export const MAX_SPAN = 0.72 * WORLD_SPAN;
const LN2 = Math.log(2);

export function defaultCameraConfig() {
  return {
    mode: 'active', composition: 'thirds', local_framing: 'balanced', pacing: 'visual_zoom', compression: 'balanced',
    trip_detection: 'balanced', smoothing: 1.0, anticipation: 1.0, intro_s: 1.2, outro_transition_s: 1.2,
    outro_hold_s: 1.0, progress_ramp: 0.05, keyframes: [], overview_bottom_reserve: 0.0, outro_start_frame: null,
  };
}

// ---------------------------------------------------------------- range min/max (segment tree)
class RangeMinMax {
  constructor(a) {
    let size = 1; while (size < a.length) size <<= 1;
    this.size = size;
    this.mn = new Float64Array(2 * size).fill(Infinity);
    this.mx = new Float64Array(2 * size).fill(-Infinity);
    for (let i = 0; i < a.length; i++) { this.mn[size + i] = a[i]; this.mx[size + i] = a[i]; }
    for (let i = size - 1; i > 0; i--) {
      this.mn[i] = Math.min(this.mn[2 * i], this.mn[2 * i + 1]);
      this.mx[i] = Math.max(this.mx[2 * i], this.mx[2 * i + 1]);
    }
  }
  query(lo, hi) { // [lo, hi)
    let mn = Infinity, mx = -Infinity;
    for (lo += this.size, hi += this.size; lo < hi; lo >>= 1, hi >>= 1) {
      if (lo & 1) { if (this.mn[lo] < mn) mn = this.mn[lo]; if (this.mx[lo] > mx) mx = this.mx[lo]; lo++; }
      if (hi & 1) { hi--; if (this.mn[hi] < mn) mn = this.mn[hi]; if (this.mx[hi] > mx) mx = this.mx[hi]; }
    }
    return [mn, mx];
  }
}

export class RouteGeometry {
  constructor(j) {
    this.j = j; this.cum = j.cum; this.xs = j.xs; this.ys = j.ys;
    this.rx = new RangeMinMax(j.xs); this.ry = new RangeMinMax(j.ys);
    this._legs = new Map();
  }
  xyAt(d) { return this.j.xyAt(d); }
  legs(tripDetection) {
    if (!this._legs.has(tripDetection)) {
      const flights = Uint8Array.from(this.j.hopMode, (m) => (m === Mode.FLIGHT ? 1 : 0));
      const legs = buildLegs(this.cum, transferThresholdKm(this.cum, tripDetection), flights);
      this._legs.set(tripDetection, { legs, starts: Float64Array.from(legs, (l) => l[0]) });
    }
    return this._legs.get(tripDetection);
  }
}

function rawSample(geo, d, mode, L, aspect, framing) {
  const cum = geo.cum;
  const total = cum[cum.length - 1];
  const [cx, cy] = geo.xyAt(d);
  const propCtx = Math.max(mode.minimum_context_km, Math.min(mode.maximum_context_km, total * mode.context_fraction));
  let leg = null, nxt = null;
  const legs = L.legs;
  if (mode.leg_aware && legs.length) {
    let k = bisectRight(L.starts, Math.max(0, Math.min(total, d))) - 1;
    k = Math.max(0, Math.min(k, legs.length - 1));
    leg = legs[k];
    nxt = k < legs.length - 1 && !legs[k + 1][2] ? legs[k + 1] : null;
  }
  const [enabled, padMult] = framing;
  let blend = 0;
  if (enabled && leg && leg[2] && nxt) {
    const ll = leg[1] - leg[0];
    if (ll > 0) blend = smoothstep(((d - leg[0]) / ll - EPISODE_ARRIVAL_ZOOM_START) / (1 - EPISODE_ARRIVAL_ZOOM_START));
  }
  let ctx, padding, r0, look;
  if (leg && leg[2]) {
    const ll = leg[1] - leg[0];
    if (blend > 0) {
      const arr = Math.max(MIN_CONTEXT_KM, Math.min(propCtx, nxt[1] - nxt[0]));
      ctx = Math.exp(lerp(Math.log(Math.max(MIN_CONTEXT_KM, ll)), Math.log(arr), blend));
      padding = lerp(TRANSFER_PADDING, mode.padding * padMult, blend);
    } else { ctx = ll; padding = TRANSFER_PADDING; }
    r0 = leg[0]; look = leg[1];
  } else {
    padding = mode.padding * (enabled ? padMult : 1.0);
    r0 = leg ? leg[0] : 0.0;
    look = total;
    ctx = propCtx;
  }
  const tail = Math.max(r0, d - ctx), ahead = Math.min(look, d + ctx);
  const i0 = bisectLeft(cum, tail), i1 = bisectRight(cum, ahead);
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  if (i1 > i0) {
    [minx, maxx] = geo.rx.query(i0, i1);
    [miny, maxy] = geo.ry.query(i0, i1);
  }
  for (const e of [tail, d, ahead]) {
    const [ex, ey] = e === d ? [cx, cy] : geo.xyAt(e);
    if (ex < minx) minx = ex; if (ex > maxx) maxx = ex;
    if (ey < miny) miny = ey; if (ey > maxy) maxy = ey;
  }
  const minSpan = mode.minimum_span * WORLD_SPAN;
  const sx = maxx - minx, sy = maxy - miny;
  const spanY = Math.max(sy * padding, (sx * padding) / Math.max(0.1, aspect), minSpan);
  return [cx, cy, Math.min(spanY, MAX_SPAN)];
}

function percentileFixed(values) {
  const s = Float64Array.from(values).sort();
  return s[Math.trunc((s.length - 1) * FIXED_ZOOM_PERCENTILE)];
}

export function buildTrack(geo, modeName, distanceAt, samples, aspect, tripDetection, localFraming) {
  const mode = CAMERA_MODES[modeName];
  const L = geo.legs(tripDetection);
  const framing = LOCAL_FRAMING[localFraming] || LOCAL_FRAMING.balanced;
  const n = samples + 1;
  const rx = new Float64Array(n), ry = new Float64Array(n), rs = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const r = rawSample(geo, distanceAt(s / samples), mode, L, aspect, framing);
    rx[s] = r[0]; ry[s] = r[1]; rs[s] = r[2];
  }
  const fixed = mode.fixed_zoom ? percentileFixed(rs) : null;
  const tx = new Float64Array(n), ty = new Float64Array(n), ts = new Float64Array(n);
  for (let s = 0; s < n; s++) {
    const target = fixed !== null ? fixed : rs[s];
    if (s === 0) { tx[0] = rx[0]; ty[0] = ry[0]; ts[0] = target; continue; }
    let cx = tx[s - 1], cy = ty[s - 1];
    const prev = ts[s - 1];
    const alpha = target > prev ? mode.zoom_out_alpha : mode.zoom_in_alpha;
    const span = mode.fixed_zoom ? target : Math.exp(Math.log(prev) + (Math.log(target) - Math.log(prev)) * alpha);
    const dx = span * aspect * DEAD_ZONE_HALF, dy = span * DEAD_ZONE_HALF;
    if (rx[s] < cx - dx) cx = rx[s] + dx; else if (rx[s] > cx + dx) cx = rx[s] - dx;
    if (ry[s] < cy - dy) cy = ry[s] + dy; else if (ry[s] > cy + dy) cy = ry[s] - dy;
    tx[s] = cx; ty[s] = cy; ts[s] = span;
  }
  return { cx: tx, cy: ty, span: ts };
}

// How much the picture changes along the route (see planner.py visual_work).
export function visualWork(geo, modeName, aspect, tripDetection, localFraming, includeZoom, samples = 480) {
  const cum = geo.cum;
  const total = cum.length ? cum[cum.length - 1] : 0;
  if (cum.length < 2 || total <= 0) return null;
  const mode = CAMERA_MODES[modeName];
  const L = geo.legs(tripDetection);
  const framing = LOCAL_FRAMING[localFraming] || LOCAL_FRAMING.balanced;
  const grid = new Float64Array(samples + 1);
  const raw = new Float64Array(samples + 1);
  for (let k = 0; k <= samples; k++) {
    grid[k] = (total * k) / samples;
    raw[k] = rawSample(geo, grid[k], mode, L, aspect, framing)[2];
  }
  grid[samples] = total;
  if (mode.fixed_zoom) raw.fill(percentileFixed(raw));
  const logspan = gaussianSmooth(Float64Array.from(raw, (v) => Math.log(Math.max(1, v))), 2.0);
  let verts = cum;
  if (cum.length > 12000) {
    verts = new Float64Array(12000);
    for (let k = 0; k < 12000; k++) verts[k] = cum[Math.trunc((k * (cum.length - 1)) / 11999)];
  }
  const all = [...grid, ...verts];
  for (const i of geo.j.arcs.keys()) {
    const a = cum[i - 1], b = cum[i];
    for (let k = 1; k < 12; k++) all.push(a + ((b - a) * k) / 12);
  }
  all.sort((a, b) => a - b);
  const D0 = [];
  for (const v of all) if (v >= 0 && v <= total && (D0.length === 0 || v !== D0[D0.length - 1])) D0.push(v);
  const D = [D0[0]];
  for (let k = 1; k < D0.length; k++) if (D0[k] - D0[k - 1] > 1e-9) D.push(D0[k]);
  const m = D.length;
  const px = new Float64Array(m), py = new Float64Array(m), ls = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const p = geo.xyAt(D[k]); px[k] = p[0]; py[k] = p[1];
    ls[k] = interp(D[k], grid, logspan);
  }
  const w = new Float64Array(m - 1);
  const pos = [];
  for (let k = 0; k < m - 1; k++) {
    const sy = Math.exp(0.5 * (ls[k] + ls[k + 1]));
    const sx = sy * aspect;
    const g = Math.hypot((px[k + 1] - px[k]) / sx, (py[k + 1] - py[k]) / sy);
    const z = includeZoom ? (VISUAL_ZOOM_WORK_WEIGHT * Math.abs(ls[k + 1] - ls[k])) / LN2 : 0;
    w[k] = g + z;
    if (Number.isFinite(w[k]) && w[k] > 1e-12) pos.push(w[k]);
  }
  if (!pos.length) return null;
  pos.sort((a, b) => a - b);
  const med = median(pos);
  for (let k = 0; k < w.length; k++) {
    const v = Number.isFinite(w[k]) ? w[k] : med;
    w[k] = Math.min(med * 20, Math.max(med * 0.05, v));
  }
  const transfer = new Uint8Array(m - 1);
  for (const [a, b, isT] of L.legs) {
    if (!isT) continue;
    for (let k = 0; k < m - 1; k++) { const mid = 0.5 * (D[k] + D[k + 1]); if (mid >= a && mid <= b) transfer[k] = 1; }
  }
  return { distances: Float64Array.from(D), work: w, transfer, legs: L.legs, grid, logspan };
}

export function visualTiming(geo, modeName, aspect, tripDetection, localFraming, includeZoom, samples = 480,
  longTripPacing = 'balanced', journeyS = null) {
  const total = geo.cum.length ? geo.cum[geo.cum.length - 1] : 0;
  const linear = (p) => total * Math.max(0, Math.min(1, p));
  const vw = visualWork(geo, modeName, aspect, tripDetection, localFraming, includeZoom, samples);
  if (!vw) return linear;
  const pacing = LEGACY_PACING[longTripPacing] || longTripPacing;
  const tripW = LONG_TRIP_PACING[pacing] ?? 0.72;
  const n = vw.work.length;
  const share = new Float64Array(n);
  let tw = 0;
  for (let k = 0; k < n; k++) { share[k] = vw.work[k] * (vw.transfer[k] ? tripW : 1); tw += share[k]; }
  if (tw <= 0) return linear;
  for (let k = 0; k < n; k++) share[k] /= tw;
  const trips = vw.legs.filter((l) => l[2]);
  const D = vw.distances;
  if (journeyS && trips.length) {
    const scale = { natural: 1.25, balanced: 1.0, faster: 0.8, fastest: 0.6 }[pacing] ?? 1.0;
    let wants = [];
    for (const [a, b] of trips) {
      const idx = [];
      for (let k = 0; k < n; k++) { const mid = 0.5 * (D[k] + D[k + 1]); if (mid >= a && mid <= b) idx.push(k); }
      if (!idx.length) continue;
      const lsIn = interp(0.5 * (a + b), vw.grid, vw.logspan);
      const lsA = interp(Math.max(0, a - 1e-6), vw.grid, vw.logspan);
      const lsB = interp(Math.min(total, b + 1e-6), vw.grid, vw.logspan);
      const dbl = (Math.max(0, lsIn - lsA) + Math.max(0, lsIn - lsB)) / LN2;
      const needS = Math.max(MIN_LONG_TRIP_S, 0.3 + 0.26 * dbl) * scale;
      wants.push([idx, needS / journeyS]);
    }
    const tot = wants.reduce((s, x) => s + x[1], 0);
    if (tot > 0.5) wants = wants.map(([m, wv]) => [m, (wv * 0.5) / tot]);
    let extraTotal = 0;
    const grow = [];
    for (const [idx, want] of wants) {
      let have = 0; for (const k of idx) have += share[k];
      if (have < want) { grow.push([idx, have, want]); extraTotal += want - have; }
    }
    if (grow.length) {
      const donors = new Uint8Array(n).fill(1);
      for (const [idx] of grow) for (const k of idx) donors[k] = 0;
      let dsum = 0; for (let k = 0; k < n; k++) if (donors[k]) dsum += share[k];
      if (dsum > extraTotal && extraTotal > 0) {
        const f = (dsum - extraTotal) / dsum;
        for (let k = 0; k < n; k++) if (donors[k]) share[k] *= f;
        for (const [idx, have, want] of grow) {
          if (have > 0) for (const k of idx) share[k] *= want / have;
          else for (const k of idx) share[k] = want / idx.length;
        }
      }
    }
  }
  const el = new Float64Array(n + 1);
  for (let k = 0; k < n; k++) el[k + 1] = el[k] + share[k];
  const last = el[n];
  for (let k = 0; k <= n; k++) el[k] /= last;
  const xv = [el[0]], yv = [D[0]];
  for (let k = 1; k <= n; k++) if (el[k] - el[k - 1] > 1e-12) { xv.push(el[k]); yv.push(D[k]); }
  xv[xv.length - 1] = 1; yv[yv.length - 1] = total;
  if (xv.length < 3) return linear;
  return hermiteMap(Float64Array.from(xv), Float64Array.from(yv));
}

export function overviewViewport(xs, ys, aspect) {
  let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] < mnx) mnx = xs[i]; if (xs[i] > mxx) mxx = xs[i];
    if (ys[i] < mny) mny = ys[i]; if (ys[i] > mxy) mxy = ys[i];
  }
  const sx = Math.max(mxx - mnx, 1000), sy = Math.max(mxy - mny, 1000);
  const spanY = Math.max(sy * 1.35, (sx * 1.35) / Math.max(0.1, aspect));
  return [(mnx + mxx) / 2, (mny + mxy) / 2, Math.min(spanY, MAX_SPAN * 1.2)];
}

export function rampedProgress(u, ramp) {
  u = Math.max(0, Math.min(1, u));
  const r = Math.max(1e-6, Math.min(0.45, ramp));
  const vmax = 1 / (1 - r);
  const area = (x) => {
    if (x <= r) { const t = x / r; return vmax * r * (t ** 3 - 0.5 * t ** 4); }
    if (x <= 1 - r) return vmax * (0.5 * r + (x - r));
    return 1 - area(1 - x);
  };
  return Math.max(0, Math.min(1, area(u)));
}

function nonzeroPhase(phase, v) { const out = []; for (let i = 0; i < phase.length; i++) if (phase[i] === v) out.push(i); return out; }

// ---------------------------------------------------------------- planner
export function planFrames(journey, cfgIn, { width, height, fps, durationS, onStage } = {}) {
  const cfg = { ...defaultCameraConfig(), ...cfgIn };
  const modeName = LEGACY_CAMERA_MODES[cfg.mode] || cfg.mode;
  if (!CAMERA_MODES[modeName]) throw new Error(`Unknown zoom style ${cfg.mode}`);
  const mode = CAMERA_MODES[modeName];
  const aspect = width / height;
  const geo = new RouteGeometry(journey);
  const cum = geo.cum;
  const totalKm = cum.length ? cum[cum.length - 1] : 0;
  const totalFrames = Math.max(2, Math.round(durationS * fps));
  const ov0 = overviewViewport(journey.xs, journey.ys, aspect);
  let introS = cfg.intro_s, outroTrS = cfg.outro_transition_s;
  if (cum.length && totalKm > 0) {
    const L = geo.legs(cfg.trip_detection);
    const fr = LOCAL_FRAMING[cfg.local_framing] || LOCAL_FRAMING.balanced;
    const s0 = rawSample(geo, 0, mode, L, aspect, fr)[2];
    const s1 = rawSample(geo, totalKm, mode, L, aspect, fr)[2];
    const cap = 0.18 * durationS;
    if (introS > 0) introS = Math.max(introS, Math.min(cap, 0.55 + 0.30 * Math.abs(Math.log2(ov0[2] / Math.max(1, s0)))));
    if (outroTrS > 0) outroTrS = Math.max(outroTrS, Math.min(cap, 0.55 + 0.30 * Math.abs(Math.log2(ov0[2] / Math.max(1, s1)))));
  }
  let introF = Math.round(Math.max(0, introS) * fps);
  let outroF = Math.round((Math.max(0, outroTrS) + Math.max(0, cfg.outro_hold_s)) * fps);
  if (cfg.outro_start_frame != null) outroF = Math.max(Math.trunc(0.5 * fps), totalFrames - Math.trunc(cfg.outro_start_frame));
  const minJourney = Math.max(2, Math.trunc(0.4 * totalFrames));
  if (introF + outroF > totalFrames - minJourney) {
    const scale = (totalFrames - minJourney) / Math.max(1, introF + outroF);
    introF = Math.trunc(introF * scale); outroF = Math.trunc(outroF * scale);
  }
  const journeyF = totalFrames - introF - outroF;
  const journeyS = journeyF / fps;

  const pacing = LEGACY_PACING[cfg.compression] || cfg.compression;
  onStage?.('pacing');
  let distanceAt = cfg.pacing === 'distance'
    ? distanceCompressionTiming(cum, pacing)
    : visualTiming(geo, modeName, aspect, cfg.trip_detection, cfg.local_framing, cfg.pacing === 'visual_zoom', 480, pacing, journeyS);

  const samples = Math.trunc(Math.min(4000, Math.max(480, Math.floor(journeyF / 2))));
  const smoothS = mode.smooth_s * Math.max(0, cfg.smoothing);
  const antic = (mode.anticipation_s * Math.max(0, cfg.anticipation)) / Math.max(1e-6, journeyS);
  const n = totalFrames;
  const phase = new Uint8Array(n);
  const prog = new Float64Array(n);
  for (let f = 0; f < n; f++) {
    let u;
    if (f < introF) { phase[f] = 0; u = 0; }
    else if (f < introF + journeyF) { phase[f] = 1; u = (f - introF) / Math.max(1, journeyF - 1); }
    else { phase[f] = 2; u = 1; }
    prog[f] = rampedProgress(u, cfg.progress_ramp);
  }

  const journeyPass = (distAt) => {
    const track = buildTrack(geo, modeName, distAt, samples, aspect, cfg.trip_detection, cfg.local_framing);
    const sigma = (smoothS / Math.max(1e-6, journeyS)) * samples;
    const ns = samples + 1;
    const lsIn = new Float64Array(ns), ox = new Float64Array(ns), oy = new Float64Array(ns);
    for (let k = 0; k < ns; k++) {
      const [mxk, myk] = geo.xyAt(distAt(k / samples));
      const sp = track.span[k];
      ox[k] = (track.cx[k] - mxk) / (sp * aspect);
      oy[k] = (track.cy[k] - myk) / sp;
      lsIn[k] = Math.log(sp);
    }
    const ls = gaussianSmooth(lsIn, sigma), oxs = gaussianSmooth(ox, sigma), oys = gaussianSmooth(oy, sigma);
    const md = new Float64Array(n), mx = new Float64Array(n), my = new Float64Array(n);
    for (let f = 0; f < n; f++) { md[f] = distAt(prog[f]); const p = geo.xyAt(md[f]); mx[f] = p[0]; my[f] = p[1]; }
    const sigM = Math.max(0.5, 0.2 * fps);
    const ax = gaussianSmooth(mx, sigM), ay = gaussianSmooth(my, sigM);
    const sy = new Float64Array(n), cx = new Float64Array(n), cy = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      const pcs = Math.min(1, prog[f] + antic * (1 - prog[f]));
      const pos = pcs * samples;
      sy[f] = Math.exp(catmullRomSample(ls, pos));
      cx[f] = ax[f] + catmullRomSample(oxs, pos) * sy[f] * aspect;
      cy[f] = ay[f] + catmullRomSample(oys, pos) * sy[f];
    }
    return { md, mx, my, ax, ay, cx, cy, sy };
  };

  onStage?.('camera');
  let P = journeyPass(distanceAt);

  // Screen-speed equalisation: two damped passes re-time the journey so on-screen travel is even.
  if (cfg.pacing !== 'distance' && journeyF > 8 && cum.length && totalKm > 0) {
    const tripW = LONG_TRIP_PACING[pacing] ?? 0.72;
    const legsT = geo.legs(cfg.trip_detection).legs.filter((l) => l[2]);
    const jf = nonzeroPhase(phase, 1);
    for (let pass = 0; pass < 2; pass++) {
      const m = jf.length;
      const travel = new Float64Array(m - 1);
      let tot = 0;
      for (let k = 0; k < m - 1; k++) {
        const a = jf[k], b = jf[k + 1];
        const vx = (P.mx[b] - P.mx[a]) / (P.sy[b] * aspect);
        const vy = (P.my[b] - P.my[a]) / P.sy[b];
        let tr = Math.hypot(vx, vy) + VISUAL_ZOOM_WORK_WEIGHT * Math.abs(Math.log2(P.sy[b]) - Math.log2(P.sy[a]));
        if (legsT.length && tripW !== 1) {
          const midd = 0.5 * (P.md[b] + P.md[a]);
          for (const [a0, b0] of legsT) if (midd >= a0 && midd <= b0) { tr *= tripW; break; }
        }
        travel[k] = tr; tot += tr;
      }
      if (tot <= 0) break;
      const pj = Float64Array.from(jf, (f) => prog[f]);
      const T = new Float64Array(m);
      for (let k = 1; k < m; k++) T[k] = T[k - 1] + travel[k - 1];
      const den = Math.max(1e-12, pj[m - 1] - pj[0]);
      const Td = new Float64Array(m);
      let run = -Infinity;
      for (let k = 0; k < m; k++) {
        const v = 0.5 * (T[k] / tot) + 0.5 * ((pj[k] - pj[0]) / den) + k * 1e-9;
        run = Math.max(run, v); Td[k] = run;
      }
      const t0 = Td[0], t1 = Td[m - 1];
      for (let k = 0; k < m; k++) Td[k] = (Td[k] - t0) / (t1 - t0);
      const old = distanceAt, p0 = pj[0], p1 = pj[m - 1];
      distanceAt = (p) => (p <= p0 || p >= p1 ? old(p) : old(interp((p - p0) / (p1 - p0), Td, pj)));
      P = journeyPass(distanceAt);
    }
  }
  let { md, mx, my, ax, ay, cx, cy, sy } = P;
  cx = Float64Array.from(cx); cy = Float64Array.from(cy); sy = Float64Array.from(sy);
  const outroB = new Float64Array(n), introB = new Float64Array(n);

  // rule-of-thirds lead room along the direction of travel
  const lead = cfg.composition === 'thirds' ? mode.lead : 0;
  if (lead > 0 && n > 3) {
    const win = Math.max(1, Math.trunc(0.25 * fps));
    const dx = new Float64Array(n), dy = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      if (phase[f] !== 1) continue;
      const a0 = Math.max(0, f - win), b0 = Math.min(n - 1, f + win);
      const sxf = sy[f] * aspect;
      const vx = ((ax[b0] - ax[a0]) / Math.max(1, b0 - a0)) * fps / sxf;
      const vy = ((ay[b0] - ay[a0]) / Math.max(1, b0 - a0)) * fps / sy[f];
      const speed = Math.hypot(vx, vy);
      if (speed < 1e-9) continue;
      const ux = vx / speed, uy = vy / speed;
      const k = smoothstep(speed / 0.12);
      const along = ((cx[f] - ax[f]) / sxf) * ux + ((cy[f] - ay[f]) / sy[f]) * uy;
      const corr = (lead / 6 - along) * k;
      dx[f] = ux * corr * sxf; dy[f] = uy * corr * sy[f];
    }
    const sig = 0.6 * fps;
    const gx = gaussianSmooth(dx, sig), gy = gaussianSmooth(dy, sig);
    for (let f = 0; f < n; f++) { cx[f] += gx[f]; cy[f] += gy[f]; }
  }

  // Director's-Cut keyframes take precedence over automatic framing
  const kfWeight = new Float64Array(n);
  const kfs = [...(cfg.keyframes || [])].sort((a, b) => a.time_s - b.time_s);
  for (const kf of kfs) {
    const ease = EASINGS[kf.ease || 'smootherstep'] || smootherstep;
    const [kx, ky] = latlonToMeters(kf.lat, kf.lon);
    const kspan = (Math.max(0.2, kf.span_km) * 1000) / Math.max(0.05, Math.cos((kf.lat * Math.PI) / 180));
    const ramp = Math.max(1 / fps, kf.ramp_s ?? 1.2);
    const hold = kf.hold_s ?? 1.0;
    const t0 = kf.time_s - ramp, t1 = kf.time_s, t2 = kf.time_s + hold, t3 = kf.time_s + hold + ramp;
    for (let f = 0; f < n; f++) {
      const t = f / fps;
      if (t <= t0 || t >= t3) continue;
      const w = t < t1 ? ease((t - t0) / ramp) : t <= t2 ? 1 : ease((t3 - t) / ramp);
      kfWeight[f] = Math.max(kfWeight[f], w);
      const ux = kx + WORLD_SPAN * pyRound((cx[f] - kx) / WORLD_SPAN);
      const r = zoomPanInterpolator([cx[f], cy[f], sy[f]], [ux, ky, kspan])(w);
      cx[f] = r[0]; cy[f] = r[1]; sy[f] = r[2];
    }
  }

  // intro / outro blends with the overview viewport
  let ov = overviewViewport(journey.xs, journey.ys, aspect);
  if (cfg.overview_bottom_reserve > 0) {
    const r = Math.min(0.4, cfg.overview_bottom_reserve);
    const syR = ov[2] / (1 - r);
    ov = [ov[0], ov[1] - (syR * r) / 2, syR];
  }
  for (let f = 0; f < n; f++) {
    let w;
    if (phase[f] === 0 && introF > 0) {
      w = introF > 1 ? 1 - smootherstep(f / Math.max(1, introF - 1)) : 0;
      introB[f] = w;
    } else if (phase[f] === 2) {
      const transF = Math.max(1, Math.min(outroF, Math.round(outroTrS * fps)));
      w = smootherstep((f - introF - journeyF + 1) / transF);
      outroB[f] = w;
    } else continue;
    const r = zoomPanInterpolator([cx[f], cy[f], sy[f]], ov)(w);
    cx[f] = r[0]; cy[f] = r[1]; sy[f] = r[2];
  }

  // final per-frame low-pass (~2 frames)
  cx = gaussianSmooth(cx, 1.5); cy = gaussianSmooth(cy, 1.5);
  const lsy = gaussianSmooth(Float64Array.from(sy, Math.log), 1.5);
  sy = Float64Array.from(lsy, Math.exp);

  // soft marker visibility guard, then a hard safety clamp at 46 %
  const guardCorr = (limit) => {
    const ox = new Float64Array(n), oy = new Float64Array(n);
    for (let f = 0; f < n; f++) {
      if (phase[f] !== 1 || kfWeight[f] > 0) continue;
      const hx = sy[f] * aspect * limit, hy = sy[f] * limit;
      if (mx[f] < cx[f] - hx) ox[f] = (mx[f] + hx - cx[f]) / (sy[f] * aspect);
      else if (mx[f] > cx[f] + hx) ox[f] = (mx[f] - hx - cx[f]) / (sy[f] * aspect);
      if (my[f] < cy[f] - hy) oy[f] = (my[f] + hy - cy[f]) / sy[f];
      else if (my[f] > cy[f] + hy) oy[f] = (my[f] - hy - cy[f]) / sy[f];
    }
    return [ox, oy];
  };
  let [ox, oy] = guardCorr(0.40);
  if (ox.some((v) => v !== 0) || oy.some((v) => v !== 0)) {
    const sigG = Math.max(1, 0.22 * fps);
    const win = Math.trunc(sigG);
    const spread = (a) => {
      if (win < 1) return a;
      const out = Float64Array.from(a);
      for (let k = 0; k < a.length; k++) {
        let best = 0, bestAbs = -1;
        for (let j = k - win; j <= k + win; j++) {
          const v = a[Math.max(0, Math.min(a.length - 1, j))];
          if (Math.abs(v) > bestAbs) { bestAbs = Math.abs(v); best = v; }
        }
        out[k] = best;
      }
      return out;
    };
    const sx2 = gaussianSmooth(spread(ox), sigG), sy2 = gaussianSmooth(spread(oy), sigG);
    for (let f = 0; f < n; f++) { cx[f] += sx2[f] * sy[f] * aspect; cy[f] += sy2[f] * sy[f]; }
  }
  [ox, oy] = guardCorr(0.46);
  for (let f = 0; f < n; f++) {
    cx[f] += ox[f] * sy[f] * aspect; cy[f] += oy[f] * sy[f];
    sy[f] = Math.min(sy[f], MAX_SPAN * 1.2);
  }
  return {
    fps, width, height, cx, cy, span: sy, mx: Float64Array.from(mx), my: Float64Array.from(my), md: Float64Array.from(md),
    phase, outro: outroB, intro: introB, overview: ov, frameCount: n, aspect,
  };
}

export function screenTravel(plan) {
  const jf = nonzeroPhase(plan.phase, 1);
  if (jf.length < 3) return 0;
  let tr = 0;
  for (let k = 1; k < jf.length; k++) {
    const a = jf[k - 1], b = jf[k];
    const vx = (plan.mx[b] - plan.mx[a]) / (plan.span[b] * plan.aspect);
    const vy = (plan.my[b] - plan.my[a]) / plan.span[b];
    tr += Math.hypot(vx, vy) + VISUAL_ZOOM_WORK_WEIGHT * Math.abs(Math.log2(plan.span[b]) - Math.log2(plan.span[a]));
  }
  return tr;
}

// Video lengths at which the marker moves at a comfortable / brisk on-screen pace (an estimate).
export function recommendDuration(journey, cfgIn, width, height) {
  const cfg = { ...defaultCameraConfig(), ...cfgIn };
  const fixed = Math.max(0, cfg.intro_s) + Math.max(0, cfg.outro_transition_s) + Math.max(0, cfg.outro_hold_s);
  if (journey.cum.length < 2 || journey.totalKm <= 0) {
    return { comfortable_s: Math.max(10, fixed + 8), brisk_s: Math.max(8, fixed + 5), travel_vp: 0 };
  }
  const probe = { ...cfg, keyframes: [], outro_start_frame: null };
  const plan = planFrames(journey, probe, { width, height, fps: 12, durationS: 60 });
  const tr = screenTravel(plan);
  return {
    comfortable_s: Math.min(1800, Math.max(10, fixed + tr / COMFORT_SPEED_VP_S)),
    brisk_s: Math.min(1800, Math.max(8, fixed + tr / BRISK_SPEED_VP_S)),
    travel_vp: tr,
  };
}

export function jerkReport(plan) {
  const s = plan.span, n = plan.cx.length;
  let axm = 0, aym = 0, azm = 0;
  for (let i = 2; i < n; i++) {
    const vx1 = (plan.cx[i - 1] - plan.cx[i - 2]) / (s[i - 1] * plan.aspect), vx2 = (plan.cx[i] - plan.cx[i - 1]) / (s[i] * plan.aspect);
    const vy1 = (plan.cy[i - 1] - plan.cy[i - 2]) / s[i - 1], vy2 = (plan.cy[i] - plan.cy[i - 1]) / s[i];
    axm = Math.max(axm, Math.abs(vx2 - vx1)); aym = Math.max(aym, Math.abs(vy2 - vy1));
    azm = Math.max(azm, Math.abs(Math.log(s[i]) - 2 * Math.log(s[i - 1]) + Math.log(s[i - 2])));
  }
  return { max_accel_x_vp: axm, max_accel_y_vp: aym, max_accel_zoom: azm, spike_ratio_zoom: spikeRatio(Array.from(s, Math.log)), frames: n };
}
