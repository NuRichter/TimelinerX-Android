import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { getTheme, THEME_IDS } from '../src/render/grading.js';
const REF = new URL('./ref/grade_ref.json', import.meta.url).pathname;
test('theme grading matches the desktop numpy pipeline (±1 LSB)', { skip: !existsSync(REF) }, () => {
  const ref = JSON.parse(readFileSync(REF, 'utf8'));
  for (const id of THEME_IDS) {
    const th = getTheme(id);
    const px = ref.px; const exp = ref[id];
    let worst = 0, off = 0;
    for (let i = 0; i < px.length; i += 3) {
      const v = th.gradeRGB(px[i], px[i + 1], px[i + 2]);
      const got = [(v >> 16) & 255, (v >> 8) & 255, v & 255];
      for (let k = 0; k < 3; k++) { const d = Math.abs(got[k] - exp[i + k]); worst = Math.max(worst, d); if (d > 0) off++; }
    }
    assert.ok(worst <= 1, `${id}: worst diff ${worst}`);
    console.log(`  ${id}: max diff ${worst}, ${(100 * off / px.length).toFixed(2)}% of channels differ by 1`);
  }
});
