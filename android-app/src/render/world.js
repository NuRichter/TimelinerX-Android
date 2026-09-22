// Offline World basemap: Natural Earth land, lakes, borders and city names rasterised on the device.
// Tiles are drawn in a neutral light or dark flavour and then graded by the theme exactly like
// downloaded raster tiles, so every theme looks the same on both map sources. Zero network.

const Q = 1 << 25;
const LANGS = ['en', 'id', 'es', 'fr', 'de', 'pt', 'ru', 'ar', 'zh', 'ja'];

export const WORLD_FLAVORS = {
  light: { water: '#cfd8dc', land: '#f7f6f2', lake: '#cfd8dc', border: '#a9a9ad', label: '#4d4d52', halo: '#f7f6f2', dot: '#6b6b70', capital: '#2b2b30' },
  dark: { water: '#0b0d11', land: '#272b33', lake: '#0b0d11', border: '#4b505b', label: '#a8adb8', halo: '#101216', dot: '#8b909b', capital: '#d4d8e0' },
};

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

class Layer {
  constructor(kind, minz, maxz, role) { Object.assign(this, { kind, minz, maxz, role }); this.features = []; this.grid = null; }
  index() {
    const G = 64;
    this.grid = Array.from({ length: G * G }, () => []);
    this.features.forEach((f, i) => {
      const gx0 = Math.max(0, Math.floor(f.b[0] * G)), gx1 = Math.min(G - 1, Math.floor(f.b[2] * G));
      const gy0 = Math.max(0, Math.floor(f.b[1] * G)), gy1 = Math.min(G - 1, Math.floor(f.b[3] * G));
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) this.grid[gy * G + gx].push(i);
    });
  }
  query(x0, y0, x1, y1) {
    const G = 64;
    const out = new Set();
    const gx0 = Math.max(0, Math.floor(x0 * G)), gx1 = Math.min(G - 1, Math.floor(x1 * G));
    const gy0 = Math.max(0, Math.floor(y0 * G)), gy1 = Math.min(G - 1, Math.floor(y1 * G));
    for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) for (const i of this.grid[gy * G + gx]) out.add(i);
    const res = [];
    for (const i of out) { const b = this.features[i].b; if (b[2] >= x0 && b[0] <= x1 && b[3] >= y0 && b[1] <= y1) res.push(this.features[i]); }
    return res;
  }
}

function decodeFeature(f) {
  if (f.pts) return f.pts;
  const bytes = f.bytes;
  const total = f.counts.reduce((a, b) => a + b, 0);
  const pts = new Float64Array(total * 2);
  let p = 0, o = 0;
  for (const n of f.counts) {
    let x = 0, y = 0;
    for (let k = 0; k < n; k++) {
      for (let axis = 0; axis < 2; axis++) {
        let shift = 0, result = 0, b;
        do { b = bytes[p++]; result += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
        const v = result % 2 === 1 ? -(result + 1) / 2 : result / 2;
        if (axis === 0) x += v; else y += v;
      }
      pts[o++] = x / Q; pts[o++] = y / Q;
    }
  }
  f.pts = pts;
  f.bytes = null;
  return pts;
}

export class WorldData {
  static async load(base = './world/') {
    const [bin, places] = await Promise.all([
      fetch(base + 'world.bin').then((r) => { if (!r.ok) throw new Error('world.bin ' + r.status); return r.arrayBuffer(); }),
      fetch(base + 'places.json').then((r) => (r.ok ? r.json() : [])),
    ]);
    return new WorldData(bin, places);
  }
  constructor(buf, places) {
    const dv = new DataView(buf);
    const u8 = new Uint8Array(buf);
    if (String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) !== 'TLXW') throw new Error('Bad world data');
    let p = 8;
    const nl = dv.getUint32(p, true); p += 4;
    this.layers = [];
    for (let l = 0; l < nl; l++) {
      const layer = new Layer(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));
      const nf = dv.getUint32(p + 4, true); p += 8;
      for (let k = 0; k < nf; k++) {
        const b = [dv.getFloat32(p, true), dv.getFloat32(p + 4, true), dv.getFloat32(p + 8, true), dv.getFloat32(p + 12, true)];
        const nr = dv.getUint16(p + 16, true), len = dv.getUint32(p + 18, true); p += 22;
        const counts = [];
        for (let r = 0; r < nr; r++) { counts.push(dv.getUint32(p, true)); p += 4; }
        layer.features.push({ b, counts, bytes: u8.subarray(p, p + len), pts: null });
        p += len;
      }
      layer.index();
      this.layers.push(layer);
    }
    // places: [x, y, minZoom, scalerank, capital, name, {lang: name} | 0]
    this.places = places;
    this._labelSets = new Map();
    this._measure = makeCanvas(8, 8).getContext('2d');
  }

  placeName(pl, lang) { return (pl[6] && pl[6][lang]) || pl[5]; }

  labelFont(pl, px = 12) { return pl[4] ? `600 ${Math.round(px * 1.08)}px "Instrument Sans", "Noto Sans", sans-serif` : `400 ${Math.round(px)}px "Instrument Sans", "Noto Sans", sans-serif`; }

  // Global, deterministic label placement per zoom level (greedy by importance, no overlaps).
  labels(z, lang, px = 12) {
    const key = z + ':' + lang + ':' + Math.round(px);
    let set = this._labelSets.get(key);
    if (set) return set;
    const scale = 256 * 2 ** z;
    const cell = 128;
    const grid = new Map();
    set = [];
    const ctx = this._measure;
    for (const pl of this.places) {
      if (pl[2] > z + 0.25) continue;
      const name = this.placeName(pl, lang);
      ctx.font = this.labelFont(pl, px);
      const w = ctx.measureText(name).width;
      const wx = pl[0] * scale, wy = pl[1] * scale;
      const hh = px * 0.75;
      const box = [wx - 5, wy - hh, wx + px * 0.6 + w + 3, wy + hh];
      const gx0 = Math.floor(box[0] / cell), gx1 = Math.floor(box[2] / cell), gy0 = Math.floor(box[1] / cell), gy1 = Math.floor(box[3] / cell);
      let hit = false;
      for (let gy = gy0; gy <= gy1 && !hit; gy++) for (let gx = gx0; gx <= gx1 && !hit; gx++) {
        for (const o of grid.get(gx + ',' + gy) || []) {
          if (o[0] < box[2] + 6 && o[2] + 6 > box[0] && o[1] < box[3] + 4 && o[3] + 4 > box[1]) { hit = true; break; }
        }
      }
      if (hit) continue;
      for (let gy = gy0; gy <= gy1; gy++) for (let gx = gx0; gx <= gx1; gx++) {
        const k = gx + ',' + gy; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(box);
      }
      set.push({ pl, name, box, w });
    }
    this._labelSets.set(key, set);
    return set;
  }

  // Draw one 256 px tile (z, x, y) in the given flavour; returns a canvas.
  renderTile(z, x, y, flavor = 'light', lang = 'en', size = 256) {
    const col = WORLD_FLAVORS[flavor] || WORLD_FLAVORS.light;
    const c = makeCanvas(size, size);
    const ctx = c.getContext('2d');
    const n = 2 ** z;
    const x0 = x / n, y0 = y / n, x1 = (x + 1) / n, y1 = (y + 1) / n;
    const k = size * n;
    ctx.fillStyle = col.water;
    ctx.fillRect(0, 0, size, size);
    const pad = 2 / k;
    const drawPolys = (role, fill) => {
      ctx.beginPath();
      let any = false;
      for (const layer of this.layers) {
        if (layer.kind !== 1 || layer.role !== role || z < layer.minz || z > layer.maxz) continue;
        for (const f of layer.query(x0 - pad, y0 - pad, x1 + pad, y1 + pad)) {
          const pts = decodeFeature(f);
          let o = 0;
          for (const cnt of f.counts) {
            for (let i = 0; i < cnt; i++, o += 2) {
              const px = (pts[o] - x0) * k, py = (pts[o + 1] - y0) * k;
              if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.closePath();
            any = true;
          }
        }
      }
      if (any) { ctx.fillStyle = fill; ctx.fill('evenodd'); }
    };
    drawPolys(1, col.land);
    drawPolys(2, col.lake);
    // borders
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.strokeStyle = col.border;
    ctx.lineWidth = z <= 3 ? 0.6 : z <= 6 ? 0.9 : 1.2;
    ctx.setLineDash(z >= 5 ? [4, 3] : []);
    ctx.beginPath();
    for (const layer of this.layers) {
      if (layer.kind !== 2 || z < layer.minz || z > layer.maxz) continue;
      for (const f of layer.query(x0 - pad, y0 - pad, x1 + pad, y1 + pad)) {
        const pts = decodeFeature(f);
        let o = 0;
        for (const cnt of f.counts) {
          for (let i = 0; i < cnt; i++, o += 2) {
            const px = (pts[o] - x0) * k, py = (pts[o + 1] - y0) * k;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
          }
        }
      }
    }
    ctx.stroke();
    ctx.setLineDash([]);
    return c;
  }
}
