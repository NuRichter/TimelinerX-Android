// Timeline import: format detection, streaming extraction, Takeout ZIP intake.
// Works on anything that yields Uint8Array chunks (File.stream(), fetch() bodies, Node buffers).
import { Unzip, UnzipInflate } from 'fflate';
import { ElementScanner, ImportError } from './scanner.js';
import { TimelineExtractor, newDiagnostics, detectFormat } from './extractor.js';

export { ImportError };
const MAX_ZIP_ENTRIES = 20000;
const MAX_ZIP_RATIO = 250;

function makeDecoder(head) {
  if (head[0] === 0xff && head[1] === 0xfe) return { dec: new TextDecoder('utf-16le'), warn: 'utf16' };
  if (head[0] === 0xfe && head[1] === 0xff) return { dec: new TextDecoder('utf-16be'), warn: 'utf16' };
  return { dec: new TextDecoder('utf-8'), warn: head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 'bom' : null };
}

// Feed a sequence of byte chunks for one JSON document into the extractor.
async function feedJsonChunks(chunks, extractor, diag, onBytes) {
  let scanner = null, decoder = null;
  for await (const chunk of chunks) {
    if (!decoder) {
      const d = makeDecoder(chunk);
      decoder = d.dec;
      if (d.warn === 'utf16') diag.warnings.push('utf16');
      if (d.warn === 'bom') diag.warnings.push('bom');
      scanner = new ElementScanner((c, el) => extractor.consume(c, el));
    }
    scanner.push(decoder.decode(chunk, { stream: true }));
    if (onBytes) await onBytes(chunk.length);
  }
  if (!scanner) throw new ImportError('empty', 'The file is empty.');
  scanner.push(decoder.decode());
  const { truncated } = scanner.end();
  if (truncated) { diag.truncated = true; diag.warnings.push('truncated'); }
  for (const k of scanner.nonArrayKnown) diag.warnings.push('not_array:' + k);
  for (const c of scanner.containersSeen) if (!diag.containers.includes(c)) diag.containers.push(c);
}

async function* blobChunks(blob, start = 0, end = blob.size) {
  // File.stream() is fine on Android WebView, but slicing keeps each chunk bounded and lets us yield.
  const step = 2 * 1024 * 1024;
  for (let at = start; at < end; at += step) {
    const buf = await blob.slice(at, Math.min(end, at + step)).arrayBuffer();
    yield new Uint8Array(buf);
  }
}

async function* streamChunks(readable) {
  const reader = readable.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value && value.length) yield value;
    }
  } finally { reader.releaseLock?.(); }
}

// ------------------------------------------------------------------ ZIP
function u16(b, o) { return b[o] | (b[o + 1] << 8); }
function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }

async function zipDirectory(blob) {
  const tailLen = Math.min(blob.size, 65536 + 22);
  const tail = new Uint8Array(await blob.slice(blob.size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (u32(tail, i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ImportError('bad_zip', 'The ZIP file is damaged (no central directory).');
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOff = u32(tail, eocd + 16);
  if (cdOff === 0xffffffff || count === 0xffff) {
    // ZIP64: locate the ZIP64 end record
    const loc = eocd - 20;
    if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
      const z64 = Number(new DataView(tail.buffer).getBigUint64(loc + 8, true));
      const rec = new Uint8Array(await blob.slice(z64, z64 + 56).arrayBuffer());
      const dv = new DataView(rec.buffer);
      count = Number(dv.getBigUint64(32, true));
      cdSize = Number(dv.getBigUint64(40, true));
      cdOff = Number(dv.getBigUint64(48, true));
    }
  }
  if (count > MAX_ZIP_ENTRIES) throw new ImportError('too_large', `The ZIP has ${count} entries.`);
  const cd = new Uint8Array(await blob.slice(cdOff, cdOff + cdSize).arrayBuffer());
  const entries = [];
  const td = new TextDecoder('utf-8');
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const csize = u32(cd, p + 20), usize = u32(cd, p + 24);
    const nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
    const name = td.decode(cd.subarray(p + 46, p + 46 + nlen)).replaceAll('\\', '/');
    entries.push({ name, csize, usize });
    p += 46 + nlen + xlen + clen;
  }
  return entries;
}

function chooseZipEntries(entries, diag) {
  const cands = [];
  for (const e of entries) {
    const n = e.name;
    if (n.endsWith('/') || !n.toLowerCase().endsWith('.json')) continue;
    if (n.startsWith('/') || n.split('/').includes('..')) { diag.warnings.push('unsafe_zip_entry'); continue; }
    if (e.csize > 0 && e.usize / e.csize > MAX_ZIP_RATIO) {
      throw new ImportError('too_large', `ZIP entry ${n} looks like a decompression bomb.`);
    }
    cands.push(n);
  }
  const lower = cands.map((n) => [n.toLowerCase(), n]);
  const primary = lower.filter(([l]) => l.endsWith('timeline.json') || l.endsWith('records.json') || l.endsWith('location-history.json')).map((x) => x[1]);
  const semantic = lower.filter(([l]) => l.includes('semantic location history')).map((x) => x[1]);
  const chosen = primary.length ? primary : semantic.length ? semantic : cands;
  if (!chosen.length) throw new ImportError('no_json_in_zip', 'The ZIP contains no JSON files.');
  return new Set(chosen);
}

async function importZip(blob, extractor, diag, onProgress) {
  const entries = await zipDirectory(blob);
  const wanted = chooseZipEntries(entries, diag);
  diag.zip_entries = [...wanted].slice(0, 20);
  // Stream the archive once; each wanted entry gets its own scanner fed by fflate's inflater.
  const queue = [];
  let pendingErr = null;
  const unzip = new Unzip((file) => {
    if (!wanted.has(file.name.replaceAll('\\', '/'))) return;
    const st = { scanner: null, decoder: null, file };
    file.ondata = (err, data, final) => {
      if (err) { pendingErr = err; return; }
      try {
        if (!st.decoder) {
          const d = makeDecoder(data);
          st.decoder = d.dec;
          st.scanner = new ElementScanner((c, el) => extractor.consume(c, el));
        }
        if (data.length) st.scanner.push(st.decoder.decode(data, { stream: true }));
        if (final) {
          st.scanner.push(st.decoder.decode());
          const r = st.scanner.end();
          if (r.truncated) { diag.truncated = true; diag.warnings.push('truncated'); }
          for (const c of st.scanner.containersSeen) if (!diag.containers.includes(c)) diag.containers.push(c);
        }
      } catch (e) { pendingErr = e; }
    };
    queue.push(file);
    file.start();
  });
  unzip.register(UnzipInflate);
  let done = 0;
  for await (const chunk of blobChunks(blob)) {
    unzip.push(chunk, false);
    if (pendingErr) break;
    done += chunk.length;
    if (onProgress) await onProgress(done / blob.size);
  }
  if (!pendingErr) unzip.push(new Uint8Array(0), true);
  if (pendingErr && !(pendingErr instanceof ImportError)) {
    throw new ImportError('bad_zip', 'Could not read the ZIP: ' + (pendingErr.message || pendingErr));
  }
  if (pendingErr) throw pendingErr;
}

// ------------------------------------------------------------------ public API
// source: Blob/File | { stream: ReadableStream, size } | { json: object } | { bytes: Uint8Array }
export async function importTimeline(source, { onProgress, name = '' } = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
  const diag = newDiagnostics();
  const ex = new TimelineExtractor(diag);
  let yieldCounter = 0;
  const tick = async (frac) => {
    if (onProgress) onProgress(Math.min(0.99, frac));
    if (++yieldCounter % 4 === 0) await new Promise((r) => setTimeout(r, 0));
  };

  if (source && source.json !== undefined) {
    feedObject(source.json, ex, diag);
  } else if (source && source.bytes instanceof Uint8Array) {
    diag.source_bytes = source.bytes.length;
    const b = source.bytes;
    if (b[0] === 0x50 && b[1] === 0x4b) await importZip(new Blob([b]), ex, diag, tick);
    else await feedJsonChunks([b], ex, diag);
  } else if (source && typeof source.slice === 'function' && typeof source.size === 'number') {
    diag.source_bytes = source.size;
    const head = new Uint8Array(await source.slice(0, 4).arrayBuffer());
    if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 3 && head[3] === 4) {
      await importZip(source, ex, diag, tick);
    } else {
      let done = 0;
      await feedJsonChunks(blobChunks(source), ex, diag, async (n) => { done += n; await tick(done / source.size); });
    }
  } else if (source && source.stream) {
    diag.source_bytes = source.size || 0;
    let done = 0;
    await feedJsonChunks(streamChunks(source.stream), ex, diag, async (n) => {
      done += n; await tick(source.size ? done / source.size : 0.5);
    });
  } else {
    throw new ImportError('no_source', 'Nothing to import.');
  }

  const [semantic, raw] = ex.finalize();
  diag.detected_format = detectFormat(diag.containers);
  diag.parse_seconds = ((typeof performance !== 'undefined' ? performance : Date).now() - t0) / 1000;
  if (diag.detected_format === 'unknown') {
    throw new ImportError('unsupported', 'This JSON does not contain Timeline data (no semanticSegments, rawSignals, timelineObjects or locations).',
      'On Android: Settings, Location, Timeline, Export Timeline data. On iPhone: Google Maps, Your Timeline, Export.');
  }
  if (semantic.n === 0 && raw.n === 0) {
    throw new ImportError('no_data', 'The file was read, but no usable points were found.');
  }
  if (onProgress) onProgress(1);
  return { semantic, raw, diagnostics: diag, name };
}

function feedObject(data, ex, diag) {
  if (Array.isArray(data)) {
    if (!diag.containers.includes('$root')) diag.containers.push('$root');
    for (const el of data) ex.consume('$root', el);
  } else if (data && typeof data === 'object') {
    for (const key of ['semanticSegments', 'rawSignals', 'locations', 'timelineObjects']) {
      const v = data[key];
      if (Array.isArray(v)) { for (const el of v) ex.consume(key, el); if (!diag.containers.includes(key)) diag.containers.push(key); }
      else if (v != null) diag.warnings.push('not_array:' + key);
    }
  } else {
    throw new ImportError('not_json', 'Timeline JSON must start with an object or array.');
  }
}

export function timelineSummary(tl) {
  const cols = tl.semantic.n ? tl.semantic : tl.raw;
  let minDay = Infinity, maxDay = -Infinity;
  const perDay = new Map();
  for (let i = 0; i < cols.n; i++) {
    const d = Math.floor((cols.t[i] + cols.off[i] * 60) / 86400);
    if (d < minDay) minDay = d;
    if (d > maxDay) maxDay = d;
    perDay.set(d, (perDay.get(d) || 0) + 1);
  }
  return { points: tl.semantic.n + tl.raw.n, semantic: tl.semantic.n, raw: tl.raw.n, minDay, maxDay, perDay };
}
