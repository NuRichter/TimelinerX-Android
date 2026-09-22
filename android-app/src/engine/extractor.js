// Timeline extraction and reconciliation (port of timeline/parser.py TimelineExtractor).
// Semantic-segment extraction (visit / activity / timelinePath, offset-based path timestamps,
// descending-export detection, standalone-path reconciliation, timezone-missing handling) is
// adapted from Google Timeline Visualizer (c) 2025 mahlernim, MIT License.
import { parseCoordinateDetailed, parseE7Pair, parseInstant } from './values.js';
import { Mode, modeFromType } from './modes.js';
import { bisectRight } from './geo.js';

export const PointKind = { VISIT: 0, ACTIVITY: 1, PATH: 2, RAW_SIGNAL: 3, LEGACY_RECORD: 4, LEGACY_VISIT: 5, LEGACY_ACTIVITY: 6 };
export const MALFORMED = Symbol('malformed');
const SEGMENT_DIRECTION_SIGNAL_S = 36 * 3600;
const LEGACY = 1_000_000_000;

export function newDiagnostics() {
  return {
    detected_format: 'unknown', containers: [], segments_seen: 0, records_seen: 0, skipped: {},
    warnings: [], direction_reversed: false, standalone_paths_dropped: 0, duplicates_removed: 0,
    source_bytes: 0, parse_seconds: 0, truncated: false,
  };
}
function skip(d, reason, n = 1) { d.skipped[reason] = (d.skipped[reason] || 0) + n; }
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ------------------------------------------------------------------ columns
export function emptyColumns(n = 0) {
  return {
    n, t: new Float64Array(n), off: new Int16Array(n), tzm: new Uint8Array(n), lat: new Float64Array(n),
    lon: new Float64Array(n), kind: new Uint8Array(n), acc: new Float32Array(n), mode: new Uint8Array(n),
  };
}
const FIELDS = ['t', 'off', 'tzm', 'lat', 'lon', 'kind', 'acc', 'mode'];

export function columnsFromRows(rows, modes = null) {
  const c = emptyColumns(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    c.t[i] = r[0]; c.off[i] = r[1]; c.tzm[i] = r[2] ? 1 : 0; c.lat[i] = r[3]; c.lon[i] = r[4];
    c.kind[i] = r[5]; c.acc[i] = r[6] == null ? NaN : r[6]; c.mode[i] = modes ? modes[i] : 0;
  }
  return c;
}
export function takeColumns(c, idx) {
  const o = emptyColumns(idx.length);
  for (let k = 0; k < idx.length; k++) { const i = idx[k]; for (const f of FIELDS) o[f][k] = c[f][i]; }
  return o;
}
export function concatColumns(parts) {
  const n = parts.reduce((s, p) => s + p.n, 0);
  const o = emptyColumns(n);
  let at = 0;
  for (const p of parts) { for (const f of FIELDS) o[f].set(p[f], at); at += p.n; }
  return o;
}
export function localDay(t, offMin) { return Math.floor((t + offMin * 60) / 86400); }

// ------------------------------------------------------------------ extractor
export class TimelineExtractor {
  constructor(diagnostics) {
    this.d = diagnostics;
    this.canonical = []; this.standalone = []; this.raw = [];
    this.intervals = []; this.anchors = []; this.activities = [];
    this.segmentIndex = 0; this.rawIndex = 0; this.legacyIndex = 0;
  }

  consume(container, el) {
    if (!this.d.containers.includes(container)) this.d.containers.push(container);
    if (el === MALFORMED) { skip(this.d, 'malformed_record'); return; }
    if (container === 'semanticSegments' || container === '$root') this._segment(el);
    else if (container === 'rawSignals') this._rawSignal(el);
    else if (container === 'locations') this._legacyRecord(el);
    else if (container === 'timelineObjects') this._legacyObject(el);
  }

  _segment(seg) {
    const idx = this.segmentIndex++;
    this.d.segments_seen++;
    if (!isObj(seg)) { skip(this.d, 'segment_not_object'); return; }
    const startI = parseInstant(seg.startTime);
    const endRaw = seg.endTime;
    if (startI) this.anchors.push([idx, startI[0]]);
    const activity = seg.activity, visit = seg.visit;
    const cand = isObj(visit) ? visit.topCandidate : undefined;
    const aStart = isObj(activity) ? parseCoordinateDetailed(activity.start)[0] : null;
    const aEnd = isObj(activity) ? parseCoordinateDetailed(activity.end)[0] : null;
    const vLoc = isObj(cand) ? parseCoordinateDetailed(cand.placeLocation)[0] : null;
    const hasSemantic = aStart !== null || aEnd !== null || vLoc !== null;
    const out = hasSemantic ? this.canonical : this.standalone;

    const path = seg.timelinePath === undefined ? [] : seg.timelinePath;
    if (Array.isArray(path)) {
      const endI = parseInstant(endRaw);
      for (let j = 0; j < path.length; j++) {
        const pp = path[j];
        if (!isObj(pp)) { skip(this.d, 'path_point_not_object'); continue; }
        const ts = pathTs(pp, startI, endI);
        const [coord, reason] = parseCoordinateDetailed(pp.point);
        if (ts === null) { skip(this.d, 'missing_timestamp'); continue; }
        if (coord === null) { skip(this.d, reason || 'invalid_coordinate'); continue; }
        out.push([ts[0], ts[1], ts[2], coord[0], coord[1], PointKind.PATH, null, idx, 1, j]);
      }
    }
    if (hasSemantic) {
      const endI = parseInstant(endRaw);
      if (isObj(activity)) {
        const tc = activity.topCandidate;
        this._activity(startI, endI, isObj(tc) ? tc.type : null);
        if (startI && aStart) add(this.canonical, startI, aStart, PointKind.ACTIVITY, idx, 0, 0);
        if (endI && aEnd) add(this.canonical, endI, aEnd, PointKind.ACTIVITY, idx, 2, 0);
        if (!startI) skip(this.d, 'missing_timestamp');
      }
      if (isObj(cand) && vLoc) {
        if (startI) add(this.canonical, startI, vLoc, PointKind.VISIT, idx, 0, 1);
        else skip(this.d, 'missing_timestamp');
      }
      if (startI && endI && !startI[2] && !endI[2] && endI[0] >= startI[0]) this.intervals.push([startI[0], endI[0]]);
    } else if (isObj(activity) || isObj(cand)) {
      skip(this.d, 'invalid_coordinate');
    }
  }

  _activity(startI, endI, type) {
    const m = modeFromType(type);
    if (m === Mode.UNKNOWN || !startI || !endI || startI[2] || endI[2]) return;
    if (endI[0] >= startI[0]) this.activities.push([startI[0], endI[0], m]);
  }

  _hopModes(rows) {
    const acts = [...this.activities].sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const out = new Uint8Array(rows.length);
    if (!acts.length || !rows.length) return out;
    const starts = acts.map((a) => a[0]);
    for (let r = 1; r < rows.length; r++) {
      const prev = rows[r - 1], cur = rows[r];
      if (prev[2] || cur[2]) continue;
      const mid = 0.5 * (prev[0] + cur[0]);
      const k = bisectRight(starts, mid) - 1;
      for (let j = k; j > Math.max(-1, k - 4); j--) {
        if (acts[j][0] <= mid && mid <= acts[j][1]) { out[r] = acts[j][2]; break; }
      }
    }
    return out;
  }

  _rawSignal(sig) {
    const i = this.rawIndex++;
    this.d.records_seen++;
    const pos = isObj(sig) ? sig.position : null;
    if (!isObj(pos)) { skip(this.d, 'raw_signal_without_position'); return; }
    const [coord, reason] = parseCoordinateDetailed(pos.LatLng || pos.latLng);
    const inst = parseInstant(pos.timestamp);
    let acc = pyFloatOrNull(pos.accuracyMeters);
    if (acc !== null && (!Number.isFinite(acc) || acc < 0)) acc = null;
    if (!coord) { skip(this.d, reason || 'invalid_coordinate'); return; }
    if (!inst) { skip(this.d, 'missing_timestamp'); return; }
    add(this.raw, inst, coord, PointKind.RAW_SIGNAL, i, 0, 0, acc);
  }

  _legacyRecord(rec) {
    const i = this.legacyIndex++;
    this.d.records_seen++;
    if (!isObj(rec)) { skip(this.d, 'record_not_object'); return; }
    const [coord, reason] = parseE7Pair(rec);
    const inst = parseInstant(rec.timestamp) || parseInstant(rec.timestampMs);
    if (!coord) { skip(this.d, reason || 'invalid_coordinate'); return; }
    if (!inst) { skip(this.d, 'missing_timestamp'); return; }
    const acc = typeof rec.accuracy === 'number' ? rec.accuracy : null;
    add(this.canonical, inst, coord, PointKind.LEGACY_RECORD, LEGACY + i, 0, 0, acc);
  }

  _legacyObject(obj) {
    const i = this.legacyIndex++;
    this.d.segments_seen++;
    if (!isObj(obj)) { skip(this.d, 'segment_not_object'); return; }
    const order0 = LEGACY + i;
    const dur = (o) => {
      const d = isObj(o) ? o.duration : null;
      if (!isObj(d)) return [null, null];
      return [parseInstant(d.startTimestamp) || parseInstant(d.startTimestampMs),
        parseInstant(d.endTimestamp) || parseInstant(d.endTimestampMs)];
    };
    const pv = obj.placeVisit;
    if (isObj(pv)) {
      const [s] = dur(pv);
      const [coord, reason] = parseE7Pair(pv.location || {});
      if (!coord || !s) { skip(this.d, reason || 'missing_timestamp'); return; }
      add(this.canonical, s, coord, PointKind.LEGACY_VISIT, order0, 0, 0);
      this.anchors.push([order0, s[0]]);
      return;
    }
    const seg = obj.activitySegment;
    if (isObj(seg)) {
      const [s, e] = dur(seg);
      this._activity(s, e, seg.activityType);
      if (s) this.anchors.push([order0, s[0]]);
      const sc = parseE7Pair(isObj(seg.startLocation) ? seg.startLocation : {})[0];
      const ec = parseE7Pair(isObj(seg.endLocation) ? seg.endLocation : {})[0];
      let added = false;
      if (s && sc) { add(this.canonical, s, sc, PointKind.LEGACY_ACTIVITY, order0, 0, 0); added = true; }
      const srp = isObj(seg.simplifiedRawPath) ? seg.simplifiedRawPath.points : null;
      const rawPath = Array.isArray(srp) ? srp : [];
      for (let j = 0; j < rawPath.length; j++) {
        const p = rawPath[j];
        if (!isObj(p)) continue;
        const c = parseE7Pair(p, 'latE7', 'lngE7')[0];
        const t = parseInstant(p.timestamp) || parseInstant(p.timestampMs);
        if (c && t) { add(this.canonical, t, c, PointKind.LEGACY_ACTIVITY, order0, 1, j); added = true; }
      }
      if (e && ec) { add(this.canonical, e, ec, PointKind.LEGACY_ACTIVITY, order0, 2, 0); added = true; }
      if (!added) skip(this.d, 'invalid_coordinate');
      return;
    }
    skip(this.d, 'unknown_timeline_object');
  }

  finalize() {
    const [reversed, robust] = descending(this.anchors);
    this.d.direction_reversed = reversed && robust;
    const orderKey = (r) => [reversed && r[7] < LEGACY ? -r[7] : r[7], r[8], r[9]];

    const intervals = [...this.intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [a, b] of intervals) {
      if (!merged.length || a > merged[merged.length - 1][1]) merged.push([a, b]);
      else if (b > merged[merged.length - 1][1]) merged[merged.length - 1][1] = b;
    }
    const standalone = ordered(this.standalone, orderKey);
    const kept = [...this.canonical];
    let k = 0, dropped = 0;
    for (const r of standalone) {
      const t = r[0];
      if (r[2]) { kept.push(r); continue; }
      while (k < merged.length && merged[k][1] < t) k++;
      if (k < merged.length && merged[k][0] <= t && t <= merged[k][1]) { dropped++; continue; }
      kept.push(r);
    }
    this.d.standalone_paths_dropped = dropped;

    const seen = new Set();
    const unique = [];
    for (const r of ordered(kept, orderKey)) {
      const key = r[0] + '|' + r[3] + '|' + r[4];
      if (seen.has(key)) { this.d.duplicates_removed++; continue; }
      seen.add(key);
      unique.push(r);
    }
    const rawSorted = ordered(this.raw, orderKey);
    return [columnsFromRows(unique, this._hopModes(unique)), columnsFromRows(rawSorted)];
  }
}

function pathTs(pp, startI, endI) {
  const absolute = parseInstant(pp.time);
  if (absolute) return absolute;
  let off = pp.durationMinutesOffsetFromStartTime;
  if (typeof off === 'boolean' || !startI) return null;
  if (typeof off === 'string' && /^\s*[+-]?\d+\s*$/.test(off)) off = parseInt(off, 10);
  else if (typeof off === 'number' && Number.isFinite(off)) off = Math.trunc(off);
  else return null;
  if (off < 0) return null;
  const t = startI[0] + off * 60;
  if (endI && !startI[2] && !endI[2] && t > endI[0] + 60) return null;
  return [t, startI[1], startI[2]];
}

function add(out, inst, coord, kind, o0, o1, o2, acc = null) {
  out.push([inst[0], inst[1], inst[2], coord[0], coord[1], kind, acc, o0, o1, o2]);
}

function pyFloatOrNull(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function cmpTuple(a, b) {
  for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; }
  return 0;
}

function ordered(rows, orderKey) {
  const anyMissing = rows.some((r) => r[2]);
  const keyed = rows.map((r) => [anyMissing ? orderKey(r) : [r[0], ...orderKey(r)], r]);
  keyed.sort((a, b) => cmpTuple(a[0], b[0]));
  return keyed.map((x) => x[1]);
}

function descending(anchors) {
  const a = [...anchors].sort((x, y) => x[0] - y[0] || x[1] - y[1]).filter((x) => x[0] < LEGACY).map((x) => x[1]);
  let asc = 0, desc = 0, endpointDesc = false;
  for (let i = 1; i < a.length; i++) {
    const delta = a[i] - a[i - 1];
    if (Math.abs(delta) < SEGMENT_DIRECTION_SIGNAL_S) continue;
    if (delta > 0) asc++; else desc++;
  }
  if (a.length >= 2) {
    const ed = a[a.length - 1] - a[0];
    if (Math.abs(ed) >= SEGMENT_DIRECTION_SIGNAL_S) {
      if (ed > 0) asc += 2; else { desc += 2; endpointDesc = true; }
    }
  }
  return [desc > asc, endpointDesc];
}

export function detectFormat(containers) {
  if (containers.includes('semanticSegments') || containers.includes('rawSignals')) return 'device-object';
  if (containers.includes('$root')) return 'device-array';
  if (containers.includes('timelineObjects')) return 'takeout-semantic';
  if (containers.includes('locations')) return 'takeout-records';
  return 'unknown';
}
