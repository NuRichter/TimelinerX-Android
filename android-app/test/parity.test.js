// Parity: the Android engine must reproduce the desktop (Python) engine on every fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { importTimeline } from '../src/engine/importer.js';
import { buildJourney } from '../src/engine/journey.js';
import { planFrames, recommendDuration, jerkReport } from '../src/engine/planner.js';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const REF = new URL('./ref/parity_ref.json', import.meta.url).pathname;
const ref = existsSync(REF) ? JSON.parse(readFileSync(REF, 'utf8')) : {};

function maxRelErr(a, b, scale) {
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / scale(i));
  return m;
}

for (const [name, r] of Object.entries(ref)) {
  test(`parity ${name}`, async () => {
    const bytes = new Uint8Array(readFileSync(FIX + name));
    let tl;
    try { tl = await importTimeline({ bytes }); } catch (e) {
      assert.ok(r.import_error, `JS import failed but Python succeeded: ${e.message}`);
      return;
    }
    if (r.import_error) { console.log(`  ${name}: Python rejects (${r.import_error}); JS salvaged ${tl.semantic.n} points`); return; }
    assert.equal(tl.semantic.n, r.sem_n, 'semantic count');
    assert.equal(tl.raw.n, r.raw_n, 'raw count');
    for (let i = 0; i < r.sem_n; i++) {
      assert.ok(Math.abs(tl.semantic.t[i] - r.sem_t[i]) < 1e-3, `t[${i}] ${tl.semantic.t[i]} vs ${r.sem_t[i]}`);
      assert.equal(tl.semantic.lat[i], r.sem_lat[i]);
      assert.equal(tl.semantic.lon[i], r.sem_lon[i]);
      assert.equal(tl.semantic.mode[i], r.sem_mode[i], `mode[${i}]`);
      assert.equal(tl.semantic.kind[i], r.sem_kind[i]);
      assert.equal(tl.semantic.off[i], r.sem_off[i]);
    }
    assert.deepEqual(tl.diagnostics.skipped, r.diag.skipped);
    assert.equal(tl.diagnostics.direction_reversed, r.diag.reversed);
    assert.equal(tl.diagnostics.duplicates_removed, r.diag.dups);
    for (const src of ['semantic', 'detailed']) {
      const jr = r['journey_' + src];
      let j;
      try { j = buildJourney(tl, { route_source: src, outlier_filter: 'conservative', trip_detection: 'balanced' }); } catch (e) {
        assert.ok(jr.error, `journey failed: ${e.message}`); continue;
      }
      assert.equal(j.lats.length, jr.n, `${src} n`);
      assert.ok(Math.abs(j.totalKm - jr.total_km) < 1e-6 * Math.max(1, jr.total_km), `${src} total_km`);
      assert.deepEqual(j.legs.map((l) => [+l[0].toFixed(6), +l[1].toFixed(6), l[2]]), jr.legs.map((l) => [+l[0].toFixed(6), +l[1].toFixed(6), l[2]]));
      assert.deepEqual(Array.from(j.hopMode), jr.hop_mode);
      assert.deepEqual([...j.arcs.keys()].sort((a, b) => a - b), jr.arcs);
      assert.equal(j.outliersRemoved, jr.outliers);
      assert.equal(j.stats.days, jr.days);
      for (const key of Object.keys(jr).filter((k) => k.startsWith('plan_'))) {
        const pr = jr[key];
        const portrait = key === 'plan_distance_portrait';
        const cfg = portrait ? { mode: 'active', pacing: 'distance' } : { mode: key.slice(5) };
        const p = planFrames(j, cfg, portrait ? { width: 360, height: 640, fps: 30, durationS: 15 } : { width: 640, height: 360, fps: 24, durationS: 20 });
        assert.equal(p.cx.length, pr.cx.length);
        const e1 = maxRelErr(p.cx, pr.cx, (i) => pr.sy[i]);
        const e2 = maxRelErr(p.cy, pr.cy, (i) => pr.sy[i]);
        const e3 = maxRelErr(p.span, pr.sy, (i) => pr.sy[i]);
        const e4 = maxRelErr(p.md, pr.md, () => Math.max(1e-9, j.totalKm));
        assert.ok(e1 < 1e-6 && e2 < 1e-6 && e3 < 1e-6 && e4 < 1e-6, `${name} ${key}: err cx ${e1} cy ${e2} span ${e3} md ${e4}`);
        if (pr.phase) assert.deepEqual(Array.from(p.phase), pr.phase);
      }
      if (jr.recommend) {
        const rd = recommendDuration(j, {}, 1920, 1080);
        assert.ok(Math.abs(rd.comfortable_s - jr.recommend.comfortable_s) < 1e-4 * jr.recommend.comfortable_s, 'recommend');
      }
    }
  });
}

test('camera is smooth (jerk bounded) on the standard route', async () => {
  const tl = await importTimeline({ bytes: new Uint8Array(readFileSync(FIX + 'standard-route.json')) });
  const j = buildJourney(tl, { route_source: 'semantic' });
  const p = planFrames(j, { mode: 'active' }, { width: 1920, height: 1080, fps: 30, durationS: 40 });
  const jr = jerkReport(p);
  assert.ok(jr.max_accel_zoom < 0.02, JSON.stringify(jr));
});
