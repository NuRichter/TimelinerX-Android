// Visual Style Engine: layered colour grading as a node graph (port of rendering/styles.py).
// Map-grading nodes are pointwise, so each tile is graded once and cached; the frame cost is only
// compositing. Results match the desktop numpy implementation (float32 maths, same clipping points).
import { THEMES } from './themes.data.js';

const LR = 0.2126, LG = 0.7152, LB = 0.0722;

export function hexRgb(h) {
  h = h.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

// CSS rgba() from #rgb / #rrggbb / #rrggbbaa with an alpha multiplier.
export function cssColor(hex, alphaMul = 1) {
  const [r, g, b] = hexRgb(hex.slice(0, 7));
  const a = hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1;
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${Math.max(0, Math.min(1, a * alphaMul)).toFixed(4)})`;
}

function monotoneCurve(points) {
  const pts = points.map(([x, y]) => [Number(x), Number(y)]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const grid = new Float64Array(1024);
  for (let i = 0; i < 1024; i++) grid[i] = i / 1023;
  if (pts.length < 2) return grid;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const n = xs.length;
  const h = [], d = [];
  for (let i = 0; i < n - 1; i++) { h.push(xs[i + 1] - xs[i]); d.push((ys[i + 1] - ys[i]) / (h[i] === 0 ? 1e-9 : h[i])); }
  const m = new Float64Array(n);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : 2 / (1 / d[i - 1] + 1 / d[i]);
  const out = new Float64Array(1024);
  for (let g = 0; g < 1024; g++) {
    const x = grid[g];
    // searchsorted(xs, x) - 1, clipped to [0, n-2]
    let ss = 0; while (ss < n && xs[ss] < x) ss++;
    const idx = Math.max(0, Math.min(n - 2, ss - 1));
    const hh = h[idx] === 0 ? 1e-9 : h[idx];
    const t = Math.max(0, Math.min(1, (x - xs[idx]) / hh));
    const t2 = t * t, t3 = t2 * t;
    const v = (2 * t3 - 3 * t2 + 1) * ys[idx] + (t3 - 2 * t2 + t) * h[idx] * m[idx]
      + (-2 * t3 + 3 * t2) * ys[idx + 1] + (t3 - t2) * h[idx] * m[idx + 1];
    out[g] = Math.max(0, Math.min(1, v));
  }
  return out;
}

const f32 = Math.fround;
function lutIndex(v) { const c = v < 0 ? 0 : v > 1 ? 1 : v; const i = Math.trunc(f32(c * 1023)); return i < 0 ? 0 : i > 1023 ? 1023 : i; }

// Build a per-pixel grading function for a theme: (r,g,b in 0..1) -> [r,g,b] (unclipped).
function compile(grading) {
  const steps = grading.map((node) => {
    switch (node.node) {
      case 'normalize': {
        const contrast = node.contrast ?? 1, sat = node.saturation ?? 1, bright = node.brightness ?? 0, gamma = node.gamma ?? 1;
        return (c) => {
          if (gamma !== 1) for (let k = 0; k < 3; k++) c[k] = Math.pow(Math.max(0, Math.min(1, c[k])), 1 / gamma);
          const y = c[0] * LR + c[1] * LG + c[2] * LB;
          for (let k = 0; k < 3; k++) c[k] = (y + (c[k] - y) * sat - 0.5) * contrast + 0.5 + bright;
        };
      }
      case 'tone_curve': {
        const lut = monotoneCurve(node.points || [[0, 0], [1, 1]]);
        const ch = ['red', 'green', 'blue'].map((k) => (node[k] ? monotoneCurve(node[k]) : null));
        return (c) => {
          for (let k = 0; k < 3; k++) {
            let v = lut[lutIndex(c[k])];
            if (ch[k]) v = ch[k][lutIndex(v)];
            c[k] = v;
          }
        };
      }
      case 'color_balance': {
        const sh = node.shadows, mid = node.midtones, hi = node.highlights;
        const preserve = node.preserve_luminance ?? true;
        return (c) => {
          const y = Math.max(0, Math.min(1, c[0] * LR + c[1] * LG + c[2] * LB));
          let wsh = Math.max(0, Math.min(1, 1 - y * 3)); wsh *= Math.sqrt(wsh);
          let whi = Math.max(0, Math.min(1, (y - 0.66) * 3)); whi *= Math.sqrt(whi);
          const wmid = Math.max(0, Math.min(1, 1 - wsh - whi));
          for (let k = 0; k < 3; k++) {
            if (sh) c[k] += wsh * sh[k];
            if (mid) c[k] += wmid * mid[k];
            if (hi) c[k] += whi * hi[k];
          }
          if (preserve) {
            const y2 = c[0] * LR + c[1] * LG + c[2] * LB;
            for (let k = 0; k < 3; k++) c[k] += y - y2;
          }
        };
      }
      case 'duotone': {
        const dk = hexRgb(node.dark || '#000000'), lt = hexRgb(node.light || '#ffffff'), amt = node.amount ?? 1;
        return (c) => {
          const y = Math.max(0, Math.min(1, c[0] * LR + c[1] * LG + c[2] * LB));
          for (let k = 0; k < 3; k++) c[k] += (dk[k] + (lt[k] - dk[k]) * y - c[k]) * amt;
        };
      }
      case 'invert': {
        const amt = node.amount ?? 1;
        return (c) => { for (let k = 0; k < 3; k++) c[k] += (1 - c[k] - c[k]) * amt; };
      }
      default:
        throw new Error('Unknown grading node ' + node.node);
    }
  });
  return (r, g, b) => {
    const c = [r, g, b];
    for (const s of steps) s(c);
    return c;
  };
}

export class Theme {
  constructor(d) {
    Object.assign(this, d);
    this.glow = d.glow || { route: 0.6, marker: 0.8 };
    this._fn = compile(d.grading || []);
    this._cache = new Map();
  }
  postParam(name) { return (this.post || []).find((p) => p.node === name) || null; }
  gradeRGB(r8, g8, b8) {
    const key = (r8 << 16) | (g8 << 8) | b8;
    let v = this._cache.get(key);
    if (v === undefined) {
      const c = this._fn(r8 / 255, g8 / 255, b8 / 255);
      v = 0;
      for (let k = 0; k < 3; k++) v = (v << 8) | Math.floor(Math.max(0, Math.min(1, c[k])) * 255 + 0.5);
      if (this._cache.size > 200000) this._cache.clear();
      this._cache.set(key, v);
    }
    return v;
  }
  // Grade RGBA pixels in place (alpha untouched).
  gradePixels(px) {
    for (let i = 0; i < px.length; i += 4) {
      const v = this.gradeRGB(px[i], px[i + 1], px[i + 2]);
      px[i] = (v >> 16) & 255; px[i + 1] = (v >> 8) & 255; px[i + 2] = v & 255;
    }
  }
}

const _themes = new Map(THEMES.map((d) => [d.id, new Theme(d)]));
export const THEME_IDS = THEMES.map((d) => d.id);
export function getTheme(id) { return _themes.get(id) || _themes.get('dark'); }
export function allThemes() { return [..._themes.values()]; }
