// Every UI language covers every Android string with the same placeholders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANDROID } from '../src/i18n/android.data.js';
import { DESKTOP } from '../src/i18n/desktop.data.js';
import { tr, formatNumber, formatDistance, setLanguage } from '../src/i18n/index.js';

const LANGS = ['en', 'id', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'zh', 'ja'];
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('android strings: 10 languages, complete, same placeholders', () => {
  for (const l of LANGS) {
    for (const [k, v] of Object.entries(ANDROID.en)) {
      assert.ok(ANDROID[l][k], `${l} missing ${k}`);
      assert.equal(ph(ANDROID[l][k]), ph(v), `${l} ${k}`);
    }
  }
});

test('video strings exist in every language (month names, units, templates)', () => {
  for (const l of LANGS) for (const k of ['month.1', 'month.short.12', 'unit.km', 'video.ending_template', 'video.date.month', 'video.default_title']) assert.ok(DESKTOP[l][k], `${l} ${k}`);
});

test('number and distance formatting follow the language', () => {
  assert.equal(formatNumber(6520.04, 1, 'en'), '6,520.0');
  assert.equal(formatNumber(6520.04, 1, 'id'), '6.520,0');
  assert.equal(formatDistance(1234.5, 'km', 'de'), '1.234,5\u00a0km');
  setLanguage('id');
  assert.equal(tr('app.nav.home'), 'Beranda');
  setLanguage('en');
});
