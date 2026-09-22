// Synthetic demo journey (no personal data): Surabaya by train across Java, a drive to Borobudur,
// flights to Bali and Perth, then home again. Emitted as an on-device Timeline export so it goes
// through the exact same import pipeline as a real file.

function rnd(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pt = (lat, lon) => `${lat.toFixed(7)}°, ${lon.toFixed(7)}°`;
function iso(ms, offH) {
  const d = new Date(ms + offH * 3600e3);
  const p = (n) => String(n).padStart(2, '0');
  const sign = offH >= 0 ? '+' : '-';
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:00.000${sign}${p(Math.abs(offH))}:00`;
}

const PLACES = {
  sby: [-7.2575, 112.7521], sbyAir: [-7.3798, 112.7870], jog: [-7.7956, 110.3695], boro: [-7.6079, 110.2038],
  yia: [-7.9007, 110.0573], dps: [-8.7482, 115.1670], kuta: [-8.7180, 115.1690], ubud: [-8.5069, 115.2625],
  ulu: [-8.8291, 115.0849], per: [-31.9403, 115.9669], perth: [-31.9523, 115.8613], freo: [-32.0569, 115.7439],
};
const RAIL = [[-7.2575, 112.7521], [-7.4478, 112.4386], [-7.5460, 112.2330], [-7.6298, 111.5239], [-7.4052, 111.4430], [-7.5561, 110.8316], [-7.7050, 110.6000], [-7.7956, 110.3695]];

export function demoTimeline(year = new Date().getFullYear() - 1) {
  const R = rnd(20240501);
  const segs = [];
  let t = Date.UTC(year, 6, 1, 1, 0); // 1 July, 08:00 WIB
  const visit = (p, hours, off) => {
    segs.push({ startTime: iso(t, off), endTime: iso(t + hours * 3600e3, off), visit: { topCandidate: { placeLocation: { latLng: pt(p[0], p[1]) } } } });
    t += hours * 3600e3;
  };
  const move = (way, hours, type, off, withPath = true) => {
    const a = way[0], b = way[way.length - 1];
    const t0 = t, t1 = t + hours * 3600e3;
    const seg = { startTime: iso(t0, off), endTime: iso(t1, off), activity: { start: { latLng: pt(a[0], a[1]) }, end: { latLng: pt(b[0], b[1]) }, topCandidate: { type } } };
    segs.push(seg);
    if (withPath) {
      const pts = [];
      const legs = way.length - 1;
      const per = Math.max(3, Math.round(hours * 10 / legs));
      for (let l = 0; l < legs; l++) {
        for (let k = 0; k < per; k++) {
          const f = k / per;
          const lat = way[l][0] + (way[l + 1][0] - way[l][0]) * f + (R() - 0.5) * 0.004;
          const lon = way[l][1] + (way[l + 1][1] - way[l][1]) * f + (R() - 0.5) * 0.004;
          pts.push([lat, lon]);
        }
      }
      pts.push(b);
      // path points ride inside the activity segment so the drawn route keeps the road / rail shape
      seg.timelinePath = pts.map((p, i) => ({ point: pt(p[0], p[1]), time: iso(t0 + ((t1 - t0) * i) / (pts.length - 1), off) }));
    }
    t = t1;
  };
  const local = (c, off, loops = 3, scale = 0.03, type = 'IN_PASSENGER_VEHICLE') => {
    for (let k = 0; k < loops; k++) {
      const ang = R() * Math.PI * 2;
      const dst = [c[0] + Math.sin(ang) * scale * (0.5 + R()), c[1] + Math.cos(ang) * scale * 1.2 * (0.5 + R())];
      const mid = [(c[0] + dst[0]) / 2 + (R() - 0.5) * scale * 0.5, (c[1] + dst[1]) / 2 + (R() - 0.5) * scale * 0.5];
      move([c, mid, dst], 0.6 + R() * 0.5, type, off);
      visit(dst, 1.5 + R() * 2, off);
      move([dst, mid, c], 0.6 + R() * 0.5, type, off);
      visit(c, 1 + R(), off);
    }
  };
  const night = (p, off) => { const hrs = 24 - (((t / 3600e3) + off) % 24) + 8; visit(p, hrs, off); };

  local(PLACES.sby, 7, 3); night(PLACES.sby, 7);
  move(RAIL, 5, 'IN_TRAIN', 7); visit(PLACES.jog, 3, 7); local(PLACES.jog, 7, 2, 0.02, 'MOTORCYCLING'); night(PLACES.jog, 7);
  move([PLACES.jog, [-7.70, 110.29], PLACES.boro], 1.2, 'IN_PASSENGER_VEHICLE', 7); visit(PLACES.boro, 3, 7);
  move([PLACES.boro, [-7.70, 110.29], PLACES.jog], 1.2, 'IN_PASSENGER_VEHICLE', 7); night(PLACES.jog, 7);
  move([PLACES.jog, [-7.85, 110.2], PLACES.yia], 1, 'IN_PASSENGER_VEHICLE', 7); visit(PLACES.yia, 1.5, 7);
  move([PLACES.yia, PLACES.dps], 1.3, 'FLYING', 7, false); visit(PLACES.dps, 0.8, 8);
  move([PLACES.dps, PLACES.kuta], 0.4, 'IN_PASSENGER_VEHICLE', 8); night(PLACES.kuta, 8);
  move([PLACES.kuta, [-8.62, 115.22], PLACES.ubud], 1.4, 'MOTORCYCLING', 8); visit(PLACES.ubud, 5, 8); local(PLACES.ubud, 8, 1, 0.015, 'WALKING');
  move([PLACES.ubud, [-8.62, 115.22], PLACES.kuta], 1.4, 'MOTORCYCLING', 8); night(PLACES.kuta, 8);
  move([PLACES.kuta, [-8.78, 115.12], PLACES.ulu], 1, 'MOTORCYCLING', 8); visit(PLACES.ulu, 4, 8);
  move([PLACES.ulu, PLACES.dps], 0.9, 'IN_PASSENGER_VEHICLE', 8); visit(PLACES.dps, 2, 8);
  move([PLACES.dps, PLACES.per], 3.6, 'FLYING', 8, false); visit(PLACES.per, 1, 8);
  move([PLACES.per, PLACES.perth], 0.5, 'IN_PASSENGER_VEHICLE', 8); local(PLACES.perth, 8, 2, 0.03, 'WALKING'); night(PLACES.perth, 8);
  move([PLACES.perth, [-31.99, 115.8], PLACES.freo], 0.6, 'IN_TRAIN', 8); visit(PLACES.freo, 5, 8);
  move([PLACES.freo, [-31.99, 115.8], PLACES.perth], 0.6, 'IN_TRAIN', 8); night(PLACES.perth, 8);
  move([PLACES.perth, PLACES.per], 0.5, 'IN_PASSENGER_VEHICLE', 8); visit(PLACES.per, 2, 8);
  move([PLACES.per, PLACES.sbyAir], 4.4, 'FLYING', 8, false); visit(PLACES.sbyAir, 0.7, 7);
  move([PLACES.sbyAir, [-7.31, 112.76], PLACES.sby], 0.7, 'IN_PASSENGER_VEHICLE', 7); night(PLACES.sby, 7);
  local(PLACES.sby, 7, 2);
  return { semanticSegments: segs };
}
