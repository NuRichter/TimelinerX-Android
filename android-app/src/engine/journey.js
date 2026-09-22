// Journey model: the route for a selected period, ready for camera planning (port of journeys/journey.py).
// Trip-leg detection, monotone Hermite distance-compression pacing and the Journal-style
// detailed-first route fusion are adapted from Google Timeline Visualizer (c) 2025 mahlernim, MIT.
import {
  WORLD_SPAN, bisectLeft, bisectRight, cumulativeKm, haversineKm, interpolateGreatCircle,
  latlonToMeters, projectRoute, pyRound, median,
} from './geo.js';
import { interp } from './easing.js';
import { ARC_MIN_KM, Mode, inferFlight } from './modes.js';
import { filterExcursions } from './outliers.js';
import { concatColumns, takeColumns, localDay } from './extractor.js';

export const COMPRESSION_EXPONENTS = { natural: 1.0, balanced: 0.85, faster: 0.75, fastest: 0.65, off: 1.0, gentle: 0.92, strong: 0.75, stronger: 0.65 };
export const TRIP_DETECTION_MULTIPLIERS = { conservative: 1.35, balanced: 1.0, sensitive: 0.7 };
const MIN_TRANSFER_THRESHOLD_KM = 60.0;
const MAX_TRANSFER_THRESHOLD_KM = 120.0;
const TRANSFER_TO_TYPICAL_RATIO = 3.0;
const DEVIATION_MULTIPLIER = 6.0;
const ARC_BULGE = 0.16;
const ARC_TABLE_SAMPLES = 96;

export class NoDataError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function arcControl(x0, y0, x1, y1) {
  const mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  const dx = x1 - x0, dy = y1 - y0;
  const L = Math.hypot(dx, dy);
  if (L <= 0) return [mx, my];
  let nx = -dy / L, ny = dx / L;
  if (ny < -1e-9 || (Math.abs(ny) <= 1e-9 && nx < 0)) { nx = -nx; ny = -ny; }
  const k = 2 * ARC_BULGE * L;
  return [mx + nx * k, my + ny * k];
}

// Arc-length parameterised quadratic Bezier: constant on-screen speed along a flight arc.
export class Arc {
  constructor(x0, y0, x1, y1) {
    this.p0 = [x0, y0]; this.p1 = [x1, y1];
    this.c = arcControl(x0, y0, x1, y1);
    const n = ARC_TABLE_SAMPLES + 1;
    this.u = new Float64Array(n); this.s = new Float64Array(n);
    let px = 0, py = 0, acc = 0;
    for (let k = 0; k < n; k++) {
      const t = k / ARC_TABLE_SAMPLES;
      this.u[k] = t;
      const [x, y] = this.bez(t);
      if (k > 0) acc += Math.hypot(x - px, y - py);
      this.s[k] = acc;
      px = x; py = y;
    }
    if (acc > 0) for (let k = 0; k < n; k++) this.s[k] /= acc; else this.s.set(this.u);
  }
  bez(t) {
    const a = (1 - t) ** 2, b = 2 * (1 - t) * t, c = t * t;
    return [a * this.p0[0] + b * this.c[0] + c * this.p1[0], a * this.p0[1] + b * this.c[1] + c * this.p1[1]];
  }
  at(frac) { return this.bez(interp(frac, this.s, this.u)); }
  tangent(frac) {
    const t = interp(frac, this.s, this.u);
    return [2 * (1 - t) * (this.c[0] - this.p0[0]) + 2 * t * (this.p1[0] - this.c[0]),
      2 * (1 - t) * (this.c[1] - this.p0[1]) + 2 * t * (this.p1[1] - this.c[1])];
  }
}

export function localParts(t, offMin) {
  const d = new Date((t + offMin * 60) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), H: d.getUTCHours(), M: d.getUTCMinutes(), day: Math.floor((t + offMin * 60) / 86400) };
}

export class Journey {
  constructor(o) {
    Object.assign(this, o);
    if (!this.hopMode) this.hopMode = new Uint8Array(this.lats.length);
    if (!this.arcs) this.arcs = new Map();
  }
  static fromData(d) {
    const arcs = new Map();
    for (const i of d.arcIdx) arcs.set(i, new Arc(d.xs[i - 1], d.ys[i - 1], d.xs[i], d.ys[i]));
    return new Journey({ ...d, arcs });
  }
  toData() {
    const { arcs, ...rest } = this;
    return { ...rest, arcIdx: [...arcs.keys()] };
  }
  get totalKm() { return this.cum.length ? this.cum[this.cum.length - 1] : 0; }
  get tripCount() { return this.legs.filter((l) => l[2]).length; }
  hopIndex(d) {
    const c = this.cum;
    if (c.length < 2) return 0;
    d = Math.max(0, Math.min(c[c.length - 1], d));
    return Math.min(Math.max(bisectLeft(c, d), 1), c.length - 1);
  }
  modeAt(d) { return this.cum.length > 1 ? this.hopMode[this.hopIndex(d)] : 0; }
  hopFraction(d) {
    const i = this.hopIndex(d);
    const seg = i > 0 ? this.cum[i] - this.cum[i - 1] : 0;
    const dd = Math.max(0, Math.min(this.cum[this.cum.length - 1], d));
    return [i, seg <= 0 ? 0 : (dd - this.cum[i - 1]) / seg];
  }
  xyAt(d) {
    if (this.cum.length < 2) return [this.xs[0], this.ys[0]];
    const [i, fr] = this.hopFraction(d);
    const arc = this.arcs.get(i);
    if (arc) return arc.at(fr);
    const [lat, lon] = interpolateGreatCircle(this.lats[i - 1], this.lons[i - 1], this.lats[i], this.lons[i], fr);
    let [x, y] = latlonToMeters(lat, lon);
    const ref = fr < 0.5 ? this.xs[i - 1] : this.xs[i];
    x += WORLD_SPAN * pyRound((ref - x) / WORLD_SPAN);
    return [x, y];
  }
  directionAt(d) {
    const [i, fr] = this.hopFraction(d);
    const arc = this.arcs.get(i);
    if (arc) return arc.tangent(fr);
    return [this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]];
  }
  indexAtDistance(d) { return Math.min(Math.max(bisectRight(this.cum, d) - 1, 0), this.cum.length - 1); }
  timeAtDistance(d) {
    const [k, fr] = this.hopFraction(d);
    return k > 0 ? this.t[k - 1] + (this.t[k] - this.t[k - 1]) * fr : this.t[0];
  }
  partsAtDistance(d) { const i = this.indexAtDistance(d); return localParts(this.t[i], this.off[i]); }
}

// ------------------------------------------------------------------ period / fusion
export function dayNumber(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}
export function isoOfDay(day) { return new Date(day * 86400000).toISOString().slice(0, 10); }

function selectPeriod(cols, cfg) {
  if (!cols.n) return cols;
  const s = dayNumber(cfg.start), e = dayNumber(cfg.end);
  if (s === null && e === null) return cols;
  const idx = [];
  for (let i = 0; i < cols.n; i++) {
    const d = localDay(cols.t[i], cols.off[i]);
    if ((s === null || d >= s) && (e === null || d <= e)) idx.push(i);
  }
  return takeColumns(cols, idx);
}

export function fuseDetailedRoute(semantic, raw, maxAccuracyM) {
  const stats = { detailed_input: raw.n, detailed_usable: 0, detailed_islands: 0, semantic_backup: semantic.n };
  if (!raw.n) return [semantic, stats];
  const keepIdx = [];
  for (let i = 0; i < raw.n; i++) if (Number.isFinite(raw.acc[i]) && raw.acc[i] <= maxAccuracyM) keepIdx.push(i);
  const r = takeColumns(raw, keepIdx);
  const rows = [];
  for (let i = 0; i < r.n; i++) rows.push([r.t[i], r.lat[i], r.lon[i], r.acc[i], i]);
  const norm = [];
  for (let i = 0; i < rows.length;) {
    let j = i + 1;
    while (j < rows.length && rows[j][0] === rows[i][0]) j++;
    const group = new Map();
    for (let k = i; k < j; k++) {
      const row = rows[k];
      const key = row[1] + ',' + row[2];
      const g = group.get(key);
      if (!g || row[3] < g[3]) group.set(key, row);
    }
    if (group.size === 1) norm.push(group.values().next().value);
    i = j;
  }
  let ws = [];
  if (norm.length < 3) ws = norm;
  else {
    ws.push(norm[0]);
    for (let k = 1; k < norm.length - 1; k++) {
      const b = ws[ws.length - 1], c = norm[k], a = norm[k + 1];
      const window = a[0] - b[0];
      const rejoin = Math.max(0.2, ((b[3] + a[3]) * 2) / 1000);
      const ing = haversineKm(b[1], b[2], c[1], c[2]);
      const egr = haversineKm(c[1], c[2], a[1], a[2]);
      const minSpike = Math.max(0.5, (c[3] * 5) / 1000);
      const ih = (c[0] - b[0]) / 3600, eh = (a[0] - c[0]) / 3600;
      const spike = window >= 0 && window <= 1200 && haversineKm(b[1], b[2], a[1], a[2]) <= rejoin
        && ing >= minSpike && egr >= minSpike && (ih <= 0 || ing / ih > 250) && (eh <= 0 || egr / eh > 250);
      if (!spike) ws.push(c);
    }
    ws.push(norm[norm.length - 1]);
  }
  const stab = [];
  for (const c of ws) {
    if (!stab.length) { stab.push(c); continue; }
    const p = stab[stab.length - 1];
    const el = c[0] - p[0];
    const unc = Math.max(0.025, (p[3] + c[3]) / 1000);
    if (el >= 0 && el <= 600 && haversineKm(p[1], p[2], c[1], c[2]) <= unc) { if (c[3] < p[3]) stab[stab.length - 1] = c; }
    else stab.push(c);
  }
  if (!stab.length) return [semantic, stats];
  const islands = [];
  for (const p of stab) {
    if (!islands.length || p[0] - islands[islands.length - 1][islands[islands.length - 1].length - 1][0] > 1800) islands.push([p]);
    else islands[islands.length - 1].push(p);
  }
  stats.detailed_usable = stab.length; stats.detailed_islands = islands.length;
  const detailed = takeColumns(r, stab.map((p) => p[4]));
  if (detailed.tzm.some((v) => v) || semantic.tzm.some((v) => v)) { stats.semantic_backup = 0; return [detailed, stats]; }
  const cov = islands.map((isl) => [isl[0][0], isl[isl.length - 1][0]]);
  const keepSem = [];
  let k = 0;
  for (let idx = 0; idx < semantic.n; idx++) {
    const t = semantic.t[idx];
    while (k < cov.length && cov[k][1] < t) k++;
    if (!(k < cov.length && cov[k][0] <= t && t <= cov[k][1])) keepSem.push(idx);
  }
  stats.semantic_backup = keepSem.length;
  const all = concatColumns([detailed, takeColumns(semantic, keepSem)]);
  const order = Array.from({ length: all.n }, (_, i) => i).sort((a, b) => all.t[a] - all.t[b] || a - b);
  return [takeColumns(all, order), stats];
}

export function transferThresholdKm(cum, tripDetection = 'balanced') {
  const mult = TRIP_DETECTION_MULTIPLIERS[tripDetection] ?? 1.0;
  const ordinary = [];
  for (let i = 1; i < cum.length; i++) { const h = cum[i] - cum[i - 1]; if (h > 0 && h < MAX_TRANSFER_THRESHOLD_KM) ordinary.push(h); }
  if (!ordinary.length) return MAX_TRANSFER_THRESHOLD_KM * mult;
  ordinary.sort((a, b) => a - b);
  const typical = median(ordinary);
  const dev = median(ordinary.map((h) => Math.abs(h - typical)).sort((a, b) => a - b));
  const th = Math.max(MIN_TRANSFER_THRESHOLD_KM, typical * TRANSFER_TO_TYPICAL_RATIO, typical + dev * DEVIATION_MULTIPLIER);
  return Math.min(MAX_TRANSFER_THRESHOLD_KM, th) * mult;
}

// Split the route into local episodes and long trips. Leg = [startKm, endKm, isTransfer].
export function buildLegs(cum, thresholdKm, flights = null) {
  const n = cum.length;
  if (n < 2 || cum[n - 1] <= 0) return [];
  const legs = [];
  let localStart = 0;
  for (let k = 0; k < n - 1; k++) {
    const a = cum[k], b = cum[k + 1];
    const flight = flights !== null && !!flights[k + 1] && b - a >= ARC_MIN_KM;
    if (b - a < Math.max(1.0, thresholdKm) && !flight) continue;
    if (a > localStart) legs.push([localStart, a, false]);
    legs.push([a, b, true]);
    localStart = b;
  }
  if (cum[n - 1] > localStart) legs.push([localStart, cum[n - 1], false]);
  return legs;
}

export function selectRoutePoints(tl, cfg) {
  const sem = selectPeriod(tl.semantic, cfg);
  const stats = {};
  let cols;
  if (cfg.route_source === 'detailed') {
    const raw = selectPeriod(tl.raw, cfg);
    const [c, fstats] = fuseDetailedRoute(sem, raw, cfg.max_accuracy_m ?? 100);
    cols = c; stats.fusion = fstats;
  } else {
    cols = sem.n ? sem : selectPeriod(tl.raw, cfg);
    if (!sem.n && cols.n) stats.note = 'raw_used';
  }
  if (!cols.n) throw new NoDataError('empty_period', 'No points found in the selected period.');
  return [cols, stats];
}

export function filterRoutePoints(cols, cfg) {
  if (cfg.outlier_filter === 'off' || cols.n < 3) return [cols, 0];
  const [kept, removed] = filterExcursions(cols.t, cols.lat, cols.lon);
  return [takeColumns(cols, kept), removed];
}

export function journeyFromColumns(cols, tripDetection = 'balanced', removed = 0, stats = {}) {
  if (!cols.n) throw new NoDataError('empty_after_filter', 'No points remain after filtering.');
  stats = { ...stats };
  const lats = Float64Array.from(cols.lat), lons = Float64Array.from(cols.lon);
  const [xs, ys] = projectRoute(lats, lons);
  const cum = cumulativeKm(lats, lons);
  const hopMode = Uint8Array.from(cols.mode);
  if (hopMode.length) hopMode[0] = 0;
  const t = Float64Array.from(cols.t);
  let inferred = 0;
  for (let i = 1; i < cum.length; i++) {
    if (hopMode[i] === Mode.UNKNOWN && inferFlight(cum[i] - cum[i - 1], t[i] - t[i - 1])) { hopMode[i] = Mode.FLIGHT; inferred++; }
  }
  const flights = Uint8Array.from(hopMode, (m) => (m === Mode.FLIGHT ? 1 : 0));
  const arcs = new Map();
  for (let i = 1; i < cum.length; i++) if (flights[i] && cum[i] - cum[i - 1] >= ARC_MIN_KM) arcs.set(i, new Arc(xs[i - 1], ys[i - 1], xs[i], ys[i]));
  const legs = buildLegs(cum, transferThresholdKm(cum, tripDetection), flights);
  const first = localParts(t[0], cols.off[0]);
  const last = localParts(t[t.length - 1], cols.off[cols.n - 1]);
  const modeKm = {};
  for (let i = 1; i < cum.length; i++) modeKm[hopMode[i]] = (modeKm[hopMode[i]] || 0) + (cum[i] - cum[i - 1]);
  Object.assign(stats, {
    points: cols.n, first_t: t[0], last_t: t[t.length - 1], first_day: first.day, last_day: last.day,
    days: last.day - first.day + 1, total_km: cum[cum.length - 1], trips: legs.filter((l) => l[2]).length,
    outliers_removed: removed, flights: arcs.size, flights_inferred: inferred, mode_km: modeKm,
  });
  return new Journey({
    t, off: Int16Array.from(cols.off), lats, lons, xs, ys, cum, legs, outliersRemoved: removed, stats, hopMode, arcs,
  });
}

export function buildJourney(tl, cfg) {
  let [cols, stats] = selectRoutePoints(tl, cfg);
  let removed;
  [cols, removed] = filterRoutePoints(cols, cfg);
  return journeyFromColumns(cols, cfg.trip_detection || 'balanced', removed, stats);
}

// ------------------------------------------------------------------ pacing helpers
function endpointSlope(w1, w2, d1, d2) {
  const s = ((2 * w1 + w2) * d1 - w1 * d2) / (w1 + w2);
  return s <= 0 ? 0 : Math.min(s, 3 * d1);
}

export function monotoneSlopes(x, y) {
  const n = x.length - 1;
  const delta = new Float64Array(n);
  for (let i = 0; i < n; i++) delta[i] = (y[i + 1] - y[i]) / (x[i + 1] - x[i]);
  if (n === 1) return Float64Array.of(delta[0], delta[0]);
  const sl = new Float64Array(x.length);
  sl[0] = endpointSlope(x[1] - x[0], x[2] - x[1], delta[0], delta[1]);
  for (let i = 1; i < x.length - 1; i++) {
    const wb = x[i] - x[i - 1], wa = x[i + 1] - x[i];
    const a1 = 2 * wa + wb, a2 = wa + 2 * wb;
    sl[i] = delta[i - 1] <= 0 || delta[i] <= 0 ? 0 : (a1 + a2) / (a1 / delta[i - 1] + a2 / delta[i]);
  }
  sl[x.length - 1] = endpointSlope(x[x.length - 1] - x[x.length - 2], x[x.length - 2] - x[x.length - 3], delta[n - 1], delta[n - 2]);
  return sl;
}

export function hermiteMap(xl, yl) {
  const sl = monotoneSlopes(xl, yl);
  const n = xl.length;
  return (p) => {
    const e = Math.max(0, Math.min(1, p));
    const ti = Math.min(Math.max(bisectLeft(xl, e), 1), n - 1);
    const fi = ti - 1;
    const w = xl[ti] - xl[fi];
    const t = w <= 0 ? 0 : (e - xl[fi]) / w;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * yl[fi] + (t3 - 2 * t2 + t) * w * sl[fi] + (-2 * t3 + 3 * t2) * yl[ti] + (t3 - t2) * w * sl[ti];
  };
}

export function distanceCompressionTiming(cum, compression = 'balanced') {
  const total = cum.length ? cum[cum.length - 1] : 0;
  const exp = COMPRESSION_EXPONENTS[compression] ?? 0.85;
  const linear = (p) => total * Math.max(0, Math.min(1, p));
  if (exp >= 1 || cum.length < 2 || total <= 0) return linear;
  const dist = [0], eff = [0];
  let et = 0;
  for (let i = 1; i < cum.length; i++) {
    const seg = cum[i] - cum[i - 1];
    if (seg <= 0) continue;
    et += seg ** exp;
    dist.push(cum[i]); eff.push(et);
  }
  if (et <= 0 || dist.length < 3) return linear;
  return hermiteMap(Float64Array.from(eff, (v) => v / et), Float64Array.from(dist));
}
