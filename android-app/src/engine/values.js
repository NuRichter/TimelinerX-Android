// Parsing of individual coordinate and timestamp values (port of timeline/values.py).
// Coordinate rules follow Google Timeline Visualizer (MIT, mahlernim): Android "lat°, lon°",
// iOS "geo:lat,lon", {latLng}/{point} wrappers and E7 integers encoded in strings.
import { MAX_LAT } from './geo.js';

// -> [ [lat, lon] | null, reason | null ]
export function parseCoordinateDetailed(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    value = value.latLng || value.LatLng || value.point;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) return parseE7Pair(value);
  }
  if (typeof value !== 'string' || !value.trim()) return [null, 'missing_coordinate'];
  let s = value.trim();
  if (s.startsWith('geo:')) s = s.slice(4);
  s = s.split('?', 1)[0].replaceAll('°', '').replaceAll(' ', '');
  const parts = s.split(',');
  if (parts.length < 2) return [null, 'malformed_coordinate'];
  let lat = pyFloat(parts[0]), lon = pyFloat(parts[1]);
  if (lat === null || lon === null) return [null, 'malformed_coordinate'];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return [null, 'malformed_coordinate'];
  if (Math.abs(lat) > 1_000_000 || Math.abs(lon) > 1_000_000) { lat /= 10_000_000; lon /= 10_000_000; }
  if (!(lat >= -MAX_LAT && lat <= MAX_LAT && lon >= -180 && lon <= 180)) return [null, 'coordinate_out_of_range'];
  return [[lat, lon], null];
}

const FLOAT_RE = /^[+-]?(?:\d+(?:_\d+)*(?:\.(?:\d+(?:_\d+)*)?)?|\.\d+(?:_\d+)*)(?:[eE][+-]?\d+)?$|^[+-]?(?:inf|infinity|nan)$/i;
function pyFloat(s) {
  if (!FLOAT_RE.test(s)) return null;
  const v = Number(s.replaceAll('_', ''));
  if (Number.isNaN(v) && !/nan/i.test(s)) return null;
  if (/inf/i.test(s)) return s.startsWith('-') ? -Infinity : Infinity;
  return v;
}

function toInt(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : null;
  if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return parseInt(v, 10);
  return null;
}

export function parseE7Pair(obj, latKey = 'latitudeE7', lonKey = 'longitudeE7') {
  const latRaw = obj[latKey] ?? obj.latE7;
  const lonRaw = obj[lonKey] ?? obj.lngE7;
  if (latRaw == null || lonRaw == null || typeof latRaw === 'boolean' || typeof lonRaw === 'boolean') {
    return [null, 'missing_coordinate'];
  }
  const li = toInt(latRaw), lo = toInt(lonRaw);
  if (li === null || lo === null) return [null, 'malformed_coordinate'];
  let lat = li / 1e7, lon = lo / 1e7;
  // Old Takeout exports contain known int32 overflow values.
  if (lat > 90) lat -= 4294967296 / 1e7;
  if (lon > 180) lon -= 4294967296 / 1e7;
  if (!(lat >= -MAX_LAT && lat <= MAX_LAT && lon >= -180 && lon <= 180)) return [null, 'coordinate_out_of_range'];
  return [[lat, lon], null];
}

// Instant: [epochSeconds, offsetMinutes, tzMissing]
const ISO_EXT = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2})(?::?(\d{2})(?::?(\d{2})(?:[.,](\d{1,9}))?)?)?)?\s*(Z|z|[+-]\d{2}(?::?\d{2}(?::?\d{2}(?:\.\d+)?)?)?)?$/;
const ISO_BASIC = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})?(\d{2})?(?:[.,](\d{1,9}))?)?(Z|[+-]\d{2}(?::?\d{2})?)?$/;
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

export function parseInstant(value) {
  if (value == null || value === '' || typeof value === 'boolean') return null;
  if (typeof value === 'number') return fromEpochMs(value);
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (/^\d{11,}$/.test(s)) return fromEpochMs(Number(s));
  let m = ISO_EXT.exec(s) || ISO_BASIC.exec(s);
  if (m) return build(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
  // Lenient fallback for unusual spellings ("2024/05/01 08:00:00 +0700", "May 1, 2024 08:00").
  m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m) return build(m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8] && /^(utc|gmt)$/i.test(m[8]) ? 'Z' : m[8]);
  m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})(?:,? (\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})?$/i.exec(s);
  if (m && MONTHS[m[1].toLowerCase()]) {
    return build(m[3], String(MONTHS[m[1].toLowerCase()]), m[2], m[4], m[5], m[6], null, m[7] && /^(utc|gmt)$/i.test(m[7]) ? 'Z' : m[7]);
  }
  return null;
}

function build(Y, M, D, h, mi, se, frac, zone) {
  const y = +Y, mo = +M, d = +D, hh = h ? +h : 0, mm = mi ? +mi : 0, ss = se ? +se : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hh > 24 || mm > 59 || ss > 60) return null;
  if (d > daysInMonth(y, mo)) return null;
  const ms = frac ? Number(('0.' + frac)) : 0;
  let t = Date.UTC(y, mo - 1, d, hh, mm, ss) / 1000 + ms;
  if (!Number.isFinite(t)) return null;
  if (!zone) return [t, 0, true];
  if (zone === 'Z' || zone === 'z') return [t, 0, false];
  const zm = /^([+-])(\d{2})(?::?(\d{2}))?(?::?(\d{2}))?/.exec(zone);
  if (!zm) return null;
  const sign = zm[1] === '-' ? -1 : 1;
  const offSec = sign * ((+zm[2]) * 3600 + (zm[3] ? +zm[3] : 0) * 60 + (zm[4] ? +zm[4] : 0));
  if (Math.abs(offSec) >= 86400) return null;
  return [t - offSec, Math.floor(offSec / 60), false];
}

function daysInMonth(y, m) {
  return [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function fromEpochMs(ms) {
  const v = Number(ms) / 1000;
  if (!Number.isFinite(v) || !(v > -62135596800 && v < 253402300799)) return null;
  return [v, 0, false];
}
