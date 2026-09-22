// GPS teleport-excursion filter (port of timeline/outliers.py; upstream "conservative" filter from
// Google Timeline Visualizer (c) 2025 mahlernim, MIT): a short run of points that jumps >= 500 km
// away at > 1300 km/h and returns within 200 km of where it left inside 12 h is removed.
import { haversineKm } from './geo.js';

const WINDOW_S = 12 * 3600;
const RETURN_KM = 200.0;
const MIN_JUMP_KM = 500.0;
const MIN_SPEED_KMH = 1300.0;
const MAX_RUN = 3;

function speed(t0, t1, km) { const dt = t1 - t0; return dt <= 0 ? Infinity : km / (dt / 3600); }

function isExcursion(t, lat, lon, before, start, end, after) {
  const w = t[after] - t[before];
  if (w < 0 || w > WINDOW_S) return false;
  if (haversineKm(lat[before], lon[before], lat[after], lon[after]) > RETURN_KM) return false;
  const ingress = haversineKm(lat[before], lon[before], lat[start], lon[start]);
  const egress = haversineKm(lat[end], lon[end], lat[after], lon[after]);
  if (ingress < MIN_JUMP_KM || egress < MIN_JUMP_KM) return false;
  if (speed(t[before], t[start], ingress) <= MIN_SPEED_KMH) return false;
  if (speed(t[end], t[after], egress) <= MIN_SPEED_KMH) return false;
  for (let i = start; i <= end; i++) {
    if (haversineKm(lat[start], lon[start], lat[i], lon[i]) > RETURN_KM) return false;
    if (haversineKm(lat[before], lon[before], lat[i], lon[i]) < MIN_JUMP_KM
      || haversineKm(lat[i], lon[i], lat[after], lon[after]) < MIN_JUMP_KM) return false;
  }
  return true;
}

export function findExcursions(t, lat, lon) {
  const n = t.length;
  if (n < 3) return [];
  const removed = [];
  let lastKept = 0, i = 1;
  while (i < n - 1) {
    let runEnd = null;
    for (let end = Math.min(i + MAX_RUN - 1, n - 2); end >= i; end--) {
      if (isExcursion(t, lat, lon, lastKept, i, end, end + 1)) { runEnd = end; break; }
    }
    if (runEnd === null) { lastKept = i; i++; }
    else { for (let k = i; k <= runEnd; k++) removed.push(k); i = runEnd + 1; }
  }
  return removed;
}

export function filterExcursions(t, lat, lon) {
  const removed = new Set(findExcursions(t, lat, lon));
  const kept = [];
  for (let i = 0; i < t.length; i++) if (!removed.has(i)) kept.push(i);
  return [kept, removed.size];
}
