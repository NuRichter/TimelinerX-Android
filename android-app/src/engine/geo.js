// Geodesy and Web Mercator projection.
// latlonToMeters, metersToLatlon, haversineKm, interpolateGreatCircle and positionAtDistance are
// adapted from Google Timeline Visualizer (c) 2025 mahlernim, MIT License, via TimelinerX desktop.

export const R_EARTH_M = 6378137.0;
export const MAX_EXTENT = 20037508.342789244;
export const WORLD_SPAN = 2 * MAX_EXTENT;
export const MAX_LAT = 85.05112878;
export const EARTH_MEAN_RADIUS_KM = 6371.0088;
export const KM_TO_MILES = 0.621371192237334;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function latlonToMeters(lat, lon) {
  const latC = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));
  return [R_EARTH_M * lon * D2R, R_EARTH_M * Math.log(Math.tan(Math.PI / 4 + (latC * D2R) / 2))];
}

export function metersToLatlon(x, y) {
  return [(2 * Math.atan(Math.exp(y / R_EARTH_M)) - Math.PI / 2) * R2D, (x / R_EARTH_M) * R2D];
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dlat = (lat2 - lat1) * D2R;
  const dlon = (lon2 - lon1) * D2R;
  const s1 = Math.sin(dlat / 2), s2 = Math.sin(dlon / 2);
  const a = s1 * s1 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * s2 * s2;
  return EARTH_MEAN_RADIUS_KM * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function interpolateGreatCircle(lat1, lon1, lat2, lon2, f) {
  if (f <= 0) return [lat1, lon1];
  if (f >= 1) return [lat2, lon2];
  const p1 = lat1 * D2R, l1 = lon1 * D2R, p2 = lat2 * D2R, l2 = lon2 * D2R;
  const ax = Math.cos(p1) * Math.cos(l1), ay = Math.cos(p1) * Math.sin(l1), az = Math.sin(p1);
  const bx = Math.cos(p2) * Math.cos(l2), by = Math.cos(p2) * Math.sin(l2), bz = Math.sin(p2);
  const dot = Math.max(-1, Math.min(1, ax * bx + ay * by + az * bz));
  const omega = Math.acos(dot);
  let left, right;
  if (Math.sin(omega) < 1e-8) { left = 1 - f; right = f; }
  else { left = Math.sin((1 - f) * omega) / Math.sin(omega); right = Math.sin(f * omega) / Math.sin(omega); }
  const x = left * ax + right * bx, y = left * ay + right * by, z = left * az + right * bz;
  return [Math.atan2(z, Math.sqrt(x * x + y * y)) * R2D, Math.atan2(y, x) * R2D];
}

// Python bisect semantics on sorted numeric arrays.
export function bisectLeft(a, x, lo = 0, hi = a.length) {
  while (lo < hi) { const m = (lo + hi) >>> 1; if (a[m] < x) lo = m + 1; else hi = m; }
  return lo;
}
export function bisectRight(a, x, lo = 0, hi = a.length) {
  while (lo < hi) { const m = (lo + hi) >>> 1; if (x < a[m]) hi = m; else lo = m + 1; }
  return lo;
}

export function positionAtDistance(cum, lats, lons, d) {
  if (!cum.length) throw new Error('A route needs at least one point');
  if (cum.length === 1 || cum[cum.length - 1] <= 0) return [lats[0], lons[0]];
  const dd = Math.max(0, Math.min(cum[cum.length - 1], d));
  const i = Math.min(Math.max(bisectLeft(cum, dd), 1), cum.length - 1);
  const seg = cum[i] - cum[i - 1];
  const fr = seg <= 0 ? 0 : (dd - cum[i - 1]) / seg;
  return interpolateGreatCircle(lats[i - 1], lons[i - 1], lats[i], lons[i], fr);
}

export function unwrapLongitudes(lons) {
  const out = new Float64Array(lons.length);
  let offset = 0, prev = null;
  for (let i = 0; i < lons.length; i++) {
    const lon = lons[i];
    if (prev !== null) {
      const delta = lon - prev;
      if (delta > 180) offset -= 360; else if (delta < -180) offset += 360;
    }
    out[i] = lon + offset;
    prev = lon;
  }
  return out;
}

export function projectRoute(lats, lons) {
  const ul = unwrapLongitudes(lons);
  const xs = new Float64Array(lats.length), ys = new Float64Array(lats.length);
  for (let i = 0; i < lats.length; i++) { const p = latlonToMeters(lats[i], ul[i]); xs[i] = p[0]; ys[i] = p[1]; }
  return [xs, ys];
}

export function cumulativeKm(lats, lons) {
  const out = new Float64Array(lats.length);
  for (let i = 1; i < lats.length; i++) out[i] = out[i - 1] + haversineKm(lats[i - 1], lons[i - 1], lats[i], lons[i]);
  return out;
}

// Python round(): half to even (used for world-copy offsets; exact halves never occur in practice).
export function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function median(sorted) {
  const n = sorted.length;
  if (!n) return NaN;
  const m = n >> 1;
  return n % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
