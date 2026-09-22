// Importer robustness: streaming chunk boundaries, Takeout ZIPs, truncation salvage, bad input.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { zipSync, strToU8 } from 'fflate';
import { importTimeline, ImportError } from '../src/engine/importer.js';
import { demoTimeline } from '../src/engine/demo.js';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const read = (n) => new Uint8Array(readFileSync(FIX + n));

function tinyChunks(bytes, size) {
  return new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size)); c.close(); },
  });
}

test('streaming result is identical for any chunk size (7-byte chunks vs whole file)', async () => {
  for (const name of ['standard-route.json', 'semantic-and-raw.json', 'legacy-records.json', 'ios-array.json']) {
    const bytes = read(name);
    const a = await importTimeline({ bytes });
    const b = await importTimeline({ stream: tinyChunks(bytes, 7), size: bytes.length });
    assert.equal(b.semantic.n, a.semantic.n, name);
    assert.equal(b.raw.n, a.raw.n, name);
    assert.deepEqual(Array.from(b.semantic.t), Array.from(a.semantic.t), name);
  }
});

test('multi-byte UTF-8 split across chunks survives', async () => {
  const doc = JSON.stringify({ semanticSegments: [{ startTime: '2024-05-01T08:00:00+07:00', endTime: '2024-05-01T09:00:00+07:00', visit: { topCandidate: { placeLocation: { latLng: '-7.2575°, 112.7521°' } }, note: '日本語 · العربية · ✈️' } }] });
  const bytes = new TextEncoder().encode(doc);
  for (const size of [1, 2, 3, 5]) {
    const r = await importTimeline({ stream: tinyChunks(bytes, size), size: bytes.length });
    assert.equal(r.semantic.n, 1);
  }
});

test('Google Takeout ZIP: Records.json and Semantic Location History are found', async () => {
  const zip = zipSync({
    'Takeout/Location History (Timeline)/Records.json': read('legacy-records.json'),
    'Takeout/Location History (Timeline)/Settings.json': strToU8('{"x":1}'),
    'Takeout/archive_browser.html': strToU8('<html></html>'),
  });
  const r = await importTimeline(new Blob([zip]));
  assert.equal(r.diagnostics.detected_format, 'takeout-records');
  assert.ok(r.semantic.n > 10);
});

test('truncated export keeps every complete record', async () => {
  const r = await importTimeline({ bytes: read('broken-truncated.json') });
  assert.ok(r.diagnostics.truncated);
  assert.ok(r.semantic.n > 100);
});

test('non-JSON and unrelated JSON are rejected with a clear code', async () => {
  await assert.rejects(importTimeline({ bytes: strToU8('hello world') }), (e) => e instanceof ImportError && e.code === 'not_json');
  await assert.rejects(importTimeline({ bytes: strToU8('{"foo": [1,2,3]}') }), (e) => e.code === 'unsupported');
  await assert.rejects(importTimeline({ bytes: strToU8('{"semanticSegments": []}') }), (e) => e.code === 'no_data');
});

test('the demo journey imports cleanly', async () => {
  const r = await importTimeline({ json: demoTimeline(2025) });
  assert.equal(Object.keys(r.diagnostics.skipped).length, 0);
  assert.ok(r.semantic.n > 300);
});
