// Map tile providers, the persistent tile cache and the Map Compositor (port of maps/tiles.py and
// maps/compositor.py). Zoom levels are cross-faded (lower zoom opaque, next zoom blended in as the
// fractional zoom rises) so tile resolution never pops between frames. Tiles are graded once by
// the theme's node graph and kept in an LRU.
import { MAX_EXTENT, WORLD_SPAN, latlonToMeters, metersToLatlon } from '../engine/geo.js';
import { smoothstep } from '../engine/easing.js';
import { cssColor, hexRgb } from './grading.js';
import { WorldData } from './world.js';

export const CARTO_STYLES = { light: 'light_all', dark: 'dark_all', voyager: 'rastertiles/voyager' };
export const CARTO_ATTRIBUTION = '© OpenStreetMap contributors © CARTO';
export const WORLD_ATTRIBUTION = 'Natural Earth';
const USER_AGENT_HINT = 'TimelinerX-Android';
const MIN_ZOOM = 1;
const XFADE_START = 0.25;
const XFADE_WIDTH = 0.5;

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

export function idealZoom(spanX, widthPx, tileSize = 256, bias = 0) {
  return Math.log2(Math.max(1e-9, (WORLD_SPAN * widthPx) / (tileSize * Math.max(spanX, 1)))) + bias;
}

export function zoomLayers(spanX, widthPx, maxZoom, tileSize = 256, bias = 0) {
  let zf = idealZoom(spanX, widthPx, tileSize, bias);
  zf = Math.max(MIN_ZOOM, Math.min(maxZoom, zf));
  const z0 = Math.floor(zf);
  const layers = [[z0, 1]];
  if (z0 + 1 <= maxZoom) {
    const a = smoothstep((zf - z0 - XFADE_START) / XFADE_WIDTH);
    if (a > 0.001) layers.push([z0 + 1, a]);
  }
  return layers;
}

export function tilesForViewport(cx, cy, spanX, spanY, zoom) {
  const n = 2 ** zoom;
  const size = WORLD_SPAN / n;
  const x0 = Math.floor((cx - spanX / 2 + MAX_EXTENT) / size), x1 = Math.floor((cx + spanX / 2 + MAX_EXTENT) / size);
  const y0 = Math.floor((MAX_EXTENT - (cy + spanY / 2)) / size), y1 = Math.floor((MAX_EXTENT - (cy - spanY / 2)) / size);
  const out = [];
  for (let ty = Math.max(0, y0); ty <= Math.min(n - 1, y1); ty++) {
    for (let tx = x0; tx <= x1; tx++) out.push([zoom, ((tx % n) + n) % n, ty]);
  }
  return out;
}

// ------------------------------------------------------------------ providers
async function sha8(s) {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return [...new Uint8Array(d)].slice(0, 5).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return (h >>> 0).toString(16); }
}

export class RasterProvider {
  // kind: 'carto' | 'xyz'
  constructor({ id, name, template, maxZoom = 19, attribution = '', key = '', requiresKey = false, subdomains = 'abcd' }) {
    Object.assign(this, { id, name, template, maxZoom, attribution, key: (key || '').trim(), requiresKey, subdomains });
    this.tileSize = 256;
    this.baseFlavor = 'raster';
    this.cacheId = id;
  }
  get missingKey() { return this.requiresKey && !this.key; }
  async init() { if (this.requiresKey) this.cacheId = `${this.id}@${this.key ? 'k' + (await sha8(this.key)) : 'nokey'}`; }
  url(z, x, y) {
    const s = this.subdomains[(x + y) % this.subdomains.length] || 'a';
    let u = this.template.replace('{z}', z).replace('{x}', x).replace('{y}', y).replace('{s}', s).replace('{r}', '');
    if (this.key) u += (u.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(this.key);
    return u;
  }
  cacheKey(z, x, y) { return `https://tiles.timelinerx.local/${encodeURIComponent(this.cacheId)}/${z}/${x}/${y}`; }
}

export function makeCarto(flavor, key) {
  return new RasterProvider({
    id: `carto-${flavor}`, name: `CARTO ${flavor}`, template: `https://basemaps.cartocdn.com/${CARTO_STYLES[flavor]}/{z}/{x}/{y}.png`,
    maxZoom: 19, attribution: CARTO_ATTRIBUTION, key, requiresKey: true,
  });
}

export function makeXYZ(template, attribution) {
  return new RasterProvider({ id: 'xyz-' + template.replace(/[^a-z0-9]/gi, '').slice(0, 40), name: 'Custom', template, maxZoom: 19, attribution: attribution || '' });
}

let _world = null;
export async function loadWorld(base = './world/') { if (!_world) _world = WorldData.load(base); return _world; }

export class WorldProvider {
  constructor(flavor, base = './world/') {
    this.id = 'world'; this.name = 'Offline World'; this.maxZoom = 13; this.tileSize = 256;
    this.flavor = flavor; this.base = base; this.attribution = WORLD_ATTRIBUTION; this.baseFlavor = 'vector';
    this.data = null; this.missingKey = false;
  }
  async init() { this.data = await loadWorld(this.base); }
}

export class PlainProvider {
  constructor() { this.id = 'plain'; this.name = 'Plain'; this.maxZoom = 22; this.tileSize = 256; this.attribution = ''; this.missingKey = false; this.plain = true; }
  async init() {}
}

// ------------------------------------------------------------------ raw tile store
// Cache Storage keeps downloaded tiles across sessions (never deleted implicitly).
const CACHE_NAME = 'tlx-tiles-v1';
let _cachePromise = null;
function tileCache() {
  if (typeof caches === 'undefined') return Promise.resolve(null);
  if (!_cachePromise) _cachePromise = caches.open(CACHE_NAME).catch(() => null);
  return _cachePromise;
}
export async function clearTileCache() { if (typeof caches !== 'undefined') { await caches.delete(CACHE_NAME); _cachePromise = null; } }
export async function tileCacheStats() {
  const c = await tileCache();
  if (!c) return { count: 0 };
  const keys = await c.keys();
  return { count: keys.length };
}

class RateLimiter {
  constructor(rps, concurrency) { this.gap = 1000 / rps; this.next = 0; this.active = 0; this.max = concurrency; this.waiters = []; }
  async acquire() {
    while (this.active >= this.max) await new Promise((r) => this.waiters.push(r));
    this.active++;
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gap;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }
  release() { this.active--; const w = this.waiters.shift(); if (w) w(); }
}

// Pluggable network fetcher: browser fetch first; on CORS/network failure the native HTTP bridge.
let nativeFetchBytes = null;
export function setNativeFetch(fn) { nativeFetchBytes = fn; }

async function fetchBytes(url, signal) {
  try {
    const r = await fetch(url, { mode: 'cors', credentials: 'omit', signal });
    if (!r.ok) return { ok: false, status: r.status, error: 'HTTP ' + r.status };
    return { ok: true, blob: await r.blob() };
  } catch (e) {
    if (signal?.aborted) throw e;
    if (nativeFetchBytes) {
      try { const blob = await nativeFetchBytes(url); if (blob) return { ok: true, blob }; } catch (e2) { return { ok: false, error: String(e2?.message || e2) }; }
    }
    return { ok: false, error: String(e?.message || e) };
  }
}

// ------------------------------------------------------------------ compositor
export class MapCompositor {
  constructor(provider, theme, { lang = 'en', offline = false, lru = 320, labels = true } = {}) {
    this.provider = provider;
    this.theme = theme;
    this.lang = lang;
    this.offline = offline;
    this.plain = !!provider.plain;
    this.maxZoom = provider.maxZoom;
    this.tileSize = provider.tileSize;
    this.lru = new Map();
    this.cap = lru;
    this.pending = new Map();
    this.failed = new Map();
    this.missing = new Set();
    this.limiter = new RateLimiter(8, 4);
    this.onTile = null;
    this.labels = !!provider.data && labels;
    this.labelAlpha = 1;
    const bg = theme.palette.background;
    this.bg = cssColor(bg.slice(0, 7));
    this._flavor = theme.base === 'dark' ? 'dark' : 'light';
  }

  key(z, x, y) { return z + '/' + x + '/' + y; }

  keysForView(cx, cy, spanX, spanY, widthPx) {
    if (this.plain) return [];
    const out = [];
    for (const [z] of zoomLayers(spanX, widthPx, this.maxZoom, this.tileSize)) {
      for (const k of tilesForViewport(cx, cy, spanX * 1.02, spanY * 1.02, z)) out.push(k);
    }
    return out;
  }

  keysForPlan(plan, widthPx, stride = 1) {
    const need = new Map();
    const n = plan.cx.length;
    for (let f = 0; f < n; f += Math.max(1, stride)) this._addView(need, plan, f, widthPx);
    this._addView(need, plan, n - 1, widthPx);
    return [...need.values()];
  }
  _addView(need, plan, f, widthPx) {
    const sx = plan.span[f] * plan.aspect;
    for (const k of this.keysForView(plan.cx[f], plan.cy[f], sx, plan.span[f], widthPx)) need.set(this.key(...k), k);
  }

  has(z, x, y) { return this.lru.has(this.key(z, x, y)); }

  // Raw encoded tile (Blob) for raster providers: Cache Storage first, then the network.
  async _rawTile(z, x, y, signal) {
    const p = this.provider;
    const cache = await tileCache();
    const ck = p.cacheKey(z, x, y);
    if (cache) {
      const hit = await cache.match(ck);
      if (hit) return { blob: await hit.blob(), src: 'cache' };
    }
    if (this.offline) return { error: 'offline' };
    if (p.missingKey) return { error: 'no_key' };
    let res = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await this.limiter.acquire();
      try { res = await fetchBytes(p.url(z, x, y), signal); } finally { this.limiter.release(); }
      if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) break;
      await new Promise((r) => setTimeout(r, 400 * 2 ** (attempt + 1)));
    }
    if (!res.ok) return { error: res.error || 'failed' };
    if (cache) { try { await cache.put(ck, new Response(res.blob, { headers: { 'content-type': res.blob.type || 'image/png' } })); } catch { /* quota */ } }
    return { blob: res.blob, src: 'network' };
  }

  async _produce(z, x, y, signal) {
    const size = this.tileSize;
    let src;
    if (this.provider.data) {
      src = this.provider.data.renderTile(z, x, y, this._flavor, this.lang, size);
    } else {
      const raw = await this._rawTile(z, x, y, signal);
      if (!raw.blob) { this.failed.set(this.key(z, x, y), raw.error); return null; }
      try { src = await createImageBitmap(raw.blob); } catch { this.failed.set(this.key(z, x, y), 'corrupt'); return null; }
    }
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, size, size);
    src.close?.();
    const img = ctx.getImageData(0, 0, size, size);
    this.theme.gradePixels(img.data);
    ctx.putImageData(img, 0, 0);
    let out = c;
    if (typeof createImageBitmap !== 'undefined') { try { out = await createImageBitmap(c); } catch { out = c; } }
    return out;
  }

  ensureTile(z, x, y, signal) {
    const k = this.key(z, x, y);
    if (this.lru.has(k)) { const v = this.lru.get(k); this.lru.delete(k); this.lru.set(k, v); return Promise.resolve(v); }
    if (this.pending.has(k)) return this.pending.get(k);
    const pr = this._produce(z, x, y, signal).then((img) => {
      this.pending.delete(k);
      if (img) {
        this.lru.set(k, img);
        this.failed.delete(k);
        while (this.lru.size > this.cap) { const [ok, ov] = this.lru.entries().next().value; this.lru.delete(ok); ov.close?.(); }
        this.onTile?.(k);
      }
      return img;
    }, (e) => { this.pending.delete(k); this.failed.set(k, String(e?.message || e)); return null; });
    this.pending.set(k, pr);
    return pr;
  }

  async ensureView(cx, cy, spanX, spanY, widthPx, signal) {
    const keys = this.keysForView(cx, cy, spanX, spanY, widthPx);
    if (keys.length > this.cap * 0.7) this.cap = Math.ceil(keys.length * 1.6);
    await Promise.all(keys.map((k) => this.ensureTile(...k, signal)));
  }

  // Download every tile a plan will show (raw bytes into the cache). Returns a report.
  async prefetchPlan(plan, widthPx, { onProgress, signal, stride } = {}) {
    const rep = { requested: 0, fromCache: 0, downloaded: 0, failed: new Map() };
    if (this.plain || this.provider.data) return rep;
    const keys = this.keysForPlan(plan, widthPx, stride ?? Math.max(1, Math.round(plan.fps / 6)));
    rep.requested = keys.length;
    let done = 0;
    const cache = await tileCache();
    const queue = [...keys];
    const worker = async () => {
      while (queue.length) {
        if (signal?.aborted) return;
        const [z, x, y] = queue.shift();
        let hit = false;
        if (cache) hit = !!(await cache.match(this.provider.cacheKey(z, x, y)));
        if (hit) rep.fromCache++;
        else {
          const r = await this._rawTile(z, x, y, signal);
          if (r.blob) rep.downloaded++; else rep.failed.set(this.key(z, x, y), r.error);
        }
        done++;
        onProgress?.(done, keys.length);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return rep;
  }

  draw(ctx, cx, cy, spanX, spanY, W, H) {
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, W, H);
    if (this.plain) { this.drawGraticule(ctx, cx, cy, spanX, spanY, W, H); ctx.restore(); return; }
    const left = cx - spanX / 2, top = cy + spanY / 2;
    const sx = W / spanX, sy = H / spanY;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    for (const [z, opacity] of zoomLayers(spanX, W, this.maxZoom, this.tileSize)) {
      const n = 2 ** z;
      const size = WORLD_SPAN / n;
      const x0 = Math.floor((left + MAX_EXTENT) / size), x1 = Math.floor((left + spanX + MAX_EXTENT) / size);
      const y0 = Math.max(0, Math.floor((MAX_EXTENT - top) / size)), y1 = Math.min(n - 1, Math.floor((MAX_EXTENT - (top - spanY)) / size));
      ctx.globalAlpha = opacity;
      for (let ty = y0; ty <= y1; ty++) {
        for (let tx = x0; tx <= x1; tx++) {
          const k = this.key(z, ((tx % n) + n) % n, ty);
          const img = this.lru.get(k);
          const rx = (-MAX_EXTENT + tx * size - left) * sx, ry = (top - (MAX_EXTENT - ty * size)) * sy;
          const w = size * sx + 1, h = size * sy + 1;
          if (img) ctx.drawImage(img, rx - 0.5, ry - 0.5, w, h);
          else if (opacity >= 1) { this.missing.add(k); }
        }
      }
    }
    ctx.restore();
  }

  drawGraticule(ctx, cx, cy, spanX, spanY, W, H) {
    const g = this.theme.palette.grid;
    ctx.strokeStyle = cssColor(g.length === 9 ? g : g + '18');
    ctx.lineWidth = Math.max(1, Math.min(W, H) / 900);
    const [latTop, lonLeft] = metersToLatlon(cx - spanX / 2, cy + spanY / 2);
    const [latBot, lonRight] = metersToLatlon(cx + spanX / 2, cy - spanY / 2);
    const spanDeg = Math.max(1e-6, lonRight - lonLeft);
    const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30];
    const step = steps.find((s) => spanDeg / s <= 12) || 30;
    const left = cx - spanX / 2, top = cy + spanY / 2;
    ctx.beginPath();
    for (let lon = Math.floor(lonLeft / step) * step; lon <= lonRight + step; lon += step) {
      const x = (latlonToMeters(0, lon)[0] - left) * W / spanX;
      ctx.moveTo(x, 0); ctx.lineTo(x, H);
    }
    for (let lat = Math.floor(latBot / step) * step; lat <= latTop + step; lat += step) {
      if (lat > -85 && lat < 85) { const y = (top - latlonToMeters(lat, 0)[1]) * H / spanY; ctx.moveTo(0, y); ctx.lineTo(W, y); }
    }
    ctx.stroke();
  }

  // Place names for the Offline World map: screen-space, constant size, cross-faded between zoom
  // levels with the same weights as the tiles, so labels never double up or pop.
  drawLabels(ctx, cx, cy, spanX, spanY, W, H, scale) {
    const data = this.provider.data;
    if (!data || !this.labels) return;
    let zf = idealZoom(spanX, W, this.tileSize);
    zf = Math.max(MIN_ZOOM, Math.min(this.maxZoom, zf));
    const z0 = Math.floor(zf);
    if (z0 < 3) return;
    const a = smoothstep((zf - z0 - XFADE_START) / XFADE_WIDTH);
    const px = Math.max(10, 14 * scale);
    const worldPx = px / 1.19;
    const s0 = data.labels(z0, this.lang, worldPx), s1 = a > 0.001 ? data.labels(z0 + 1, this.lang, worldPx) : [];
    const alpha = new Map();
    for (const L of s0) alpha.set(L.pl, [L, 1 - a]);
    for (const L of s1) { const e = alpha.get(L.pl); if (e) e[1] += a; else alpha.set(L.pl, [L, a]); }
    const left = cx - spanX / 2, top = cy + spanY / 2, kx = W / spanX, ky = H / spanY;
    const pal = this.theme.palette;
    const halo = cssColor(pal.background.slice(0, 7), 0.85);
    ctx.save();
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.direction = 'ltr';
    ctx.lineJoin = 'round';
    for (const [pl, [L, al]] of alpha) {
      if (al < 0.02) continue;
      let wx = pl[0] * WORLD_SPAN - MAX_EXTENT;
      wx += WORLD_SPAN * Math.round((cx - wx) / WORLD_SPAN);
      const sx = (wx - left) * kx, sy = (top - (MAX_EXTENT - pl[1] * WORLD_SPAN)) * ky;
      if (sx < -20 || sx > W + 10 || sy < -20 || sy > H + 20) continue;
      const cap = pl[4] === 1;
      ctx.globalAlpha = Math.min(1, al) * this.labelAlpha;
      ctx.fillStyle = cssColor(cap ? pal.text_primary : pal.text_secondary, cap ? 0.9 : 0.75);
      ctx.beginPath(); ctx.arc(sx, sy, (cap ? 3.2 : 2.4) * Math.max(1, scale), 0, Math.PI * 2); ctx.fill();
      ctx.font = data.labelFont(pl, px);
      ctx.lineWidth = Math.max(2.5, 3.2 * scale);
      ctx.strokeStyle = halo;
      const tx = sx + px * 0.6;
      ctx.strokeText(L.name, tx, sy);
      ctx.fillText(L.name, tx, sy);
    }
    ctx.restore();
  }

  dispose() { for (const v of this.lru.values()) v.close?.(); this.lru.clear(); }
}

// Resolve a provider from settings. spec: 'auto' | 'carto' | 'carto-light' | 'carto-dark' | 'carto-voyager' | 'world' | 'plain' | 'xyz'
export async function makeProvider(spec, theme, settings = {}) {
  const key = settings.cartoKey || '';
  let p;
  const flavor = theme.base === 'dark' ? 'dark' : 'light';
  if (spec === 'auto') spec = key ? 'carto' : 'world';
  if (spec === 'carto') p = makeCarto(flavor, key);
  else if (spec.startsWith('carto-')) p = makeCarto(spec.slice(6), key);
  else if (spec === 'plain') p = new PlainProvider();
  else if (spec === 'xyz' && settings.xyzTemplate) p = makeXYZ(settings.xyzTemplate, settings.xyzAttribution);
  else p = new WorldProvider(flavor, settings.worldBase || './world/');
  await p.init();
  return p;
}
export { hexRgb, USER_AGENT_HINT };
export const fetchTileBytes = fetchBytes;
