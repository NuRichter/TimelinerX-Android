// Frame Renderer: draws one video frame from a camera plan (port of rendering/frame_renderer.py).
// Layer order: graded map -> trail shadow -> travelled route -> gradient recent trail -> selective
// bloom (trail + marker only) -> marker (pulse ring, glow, core, or a plane on flights) ->
// typography (title-safe) -> date ribbon -> attribution -> vignette / grain.
// Everything is a pure function of (journey, plan, settings, frame index).
import { WORLD_SPAN, interpolateGreatCircle, latlonToMeters, pyRound, bisectLeft, bisectRight } from '../engine/geo.js';
import { smootherstep, smoothstep } from '../engine/easing.js';
import { Mode } from '../engine/modes.js';
import { localParts } from '../engine/journey.js';
import { cssColor, hexRgb } from './grading.js';
import { formatDate, formatDistance, formatNumber, isRtl, monthName, tr } from '../i18n/index.js';

const SAFE_MARGIN = 0.05;
const GRADIENT_CHUNKS = 18;
export const DEFAULT_ENDING_TEMPLATE = '{distance} · {trips} trips · {days} days';
export const FONT_DISPLAY = '"Outfit", "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", sans-serif';
export const FONT_UI = '"Instrument Sans", "Noto Sans", "Noto Sans CJK SC", "Noto Sans Arabic", sans-serif';

export function defaultTrail() { return { length: 1.0, width: 1.0, gradient: true, glow: true, shadow: true, pulse: true, show_full_route: true }; }
export function defaultTitle() {
  return {
    template: '{name} · {year}', name: '', layout: 'corner', show_date: true, date_format: 'month', show_distance: true,
    ending_title: true, ending_template: DEFAULT_ENDING_TEMPLATE, timeline_bar: true, count_up: true, unit: 'km', language: 'en',
  };
}

function makeCanvas(w, h) {
  if (typeof document !== 'undefined') { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  return new OffscreenCanvas(w, h);
}

export function resolveTitle(tpl, f) {
  let out = tpl;
  for (const [k, v] of Object.entries({ year: f.year, name: (f.name || '').trim(), start: f.start, end: f.end, distance: f.distance, trips: f.trips, days: f.days, duration: f.duration })) {
    out = out.replaceAll('{' + k + '}', v ?? '');
  }
  out = out.split(/\s+/).filter(Boolean).join(' ');
  return out.replace(/^[ ·\-—|,]+|[ ·\-—|,]+$/g, '');
}

export function buildOverlays(j, t) {
  const first = j.partsAtDistance(0), last = j.partsAtDistance(j.totalKm);
  const year = first.y === last.y ? String(first.y) : `${first.y}–${last.y}`;
  const days = last.day - first.day + 1;
  const lang = t.language;
  const fmt = {
    year, name: t.name, start: formatDate(first, lang, { short: true }), end: formatDate(last, lang, { short: true }),
    distance: formatDistance(j.totalKm, t.unit, lang), trips: formatNumber(j.tripCount, 0, lang),
    days: formatNumber(days, 0, lang), duration: tr('video.duration_days', lang, { n: days }),
  };
  const title = resolveTitle(t.template, fmt) || tr('video.default_title', lang);
  let endingTpl = t.ending_template;
  if (endingTpl.trim() === DEFAULT_ENDING_TEMPLATE) endingTpl = tr('video.ending_template', lang);
  const stats = resolveTitle(endingTpl, fmt);
  const statsAt = (k) => {
    k = Math.max(0, Math.min(1, k));
    return resolveTitle(endingTpl, {
      ...fmt, distance: formatDistance(j.totalKm * k, t.unit, lang, k < 1 ? 0 : 1),
      trips: formatNumber(Math.round(j.tripCount * k), 0, lang), days: formatNumber(Math.round(days * k), 0, lang),
    });
  };
  return { title, endingTitle: title, endingStats: stats, statsAt };
}

// Insert virtual samples into long hops (drawing only): ground hops follow the great circle,
// flight hops follow the arc the marker flies along.
export function densifyRoute(j, stepKm = 20) {
  const xs = [], ys = [], cum = [], modes = [];
  const { lats, lons, cum: c, hopMode: hm } = j;
  for (let k = 0; k < lats.length; k++) {
    const mk = k > 0 ? hm[k] : 0;
    if (k > 0) {
      const seg = c[k] - c[k - 1];
      const arc = j.arcs.get(k);
      if (arc) {
        const n = Math.max(16, Math.ceil(seg / (stepKm * 0.5)));
        for (let m = 1; m < n; m++) { const p = arc.at(m / n); xs.push(p[0]); ys.push(p[1]); cum.push(c[k - 1] + (seg * m) / n); modes.push(mk); }
      } else if (seg > stepKm * 1.5) {
        const n = Math.ceil(seg / stepKm);
        for (let m = 1; m < n; m++) {
          const [la, lo] = interpolateGreatCircle(lats[k - 1], lons[k - 1], lats[k], lons[k], m / n);
          let [x, y] = latlonToMeters(la, lo);
          x += WORLD_SPAN * pyRound((xs[xs.length - 1] - x) / WORLD_SPAN);
          xs.push(x); ys.push(y); cum.push(c[k - 1] + (seg * m) / n); modes.push(mk);
        }
      }
    }
    let x = j.xs[k];
    if (xs.length) x += WORLD_SPAN * pyRound((xs[xs.length - 1] - x) / WORLD_SPAN);
    xs.push(x); ys.push(j.ys[k]); cum.push(c[k]); modes.push(mk);
  }
  return { xs: Float64Array.from(xs), ys: Float64Array.from(ys), cum: Float64Array.from(cum), modes: Uint8Array.from(modes) };
}

const PLANE_TOP = [[1.0, 0.0], [0.9, 0.075], [0.42, 0.075], [0.08, 0.64], [-0.06, 0.64], [0.1, 0.075], [-0.55, 0.075], [-0.76, 0.31], [-0.89, 0.31], [-0.79, 0.035], [-0.93, 0.0]];
export const PLANE_OUTLINE = [...PLANE_TOP, ...PLANE_TOP.slice(1, -1).reverse().map(([x, y]) => [x, -y])];

function monthStarts(t0, t1, offMin) {
  const a = localParts(t0, offMin);
  let y = a.y, m = a.m;
  const out = [];
  for (;;) {
    m++; if (m > 12) { y++; m = 1; }
    const ts = Date.UTC(y, m - 1, 1) / 1000 - offMin * 60;
    if (ts > t1) return out;
    out.push([ts, y, m]);
  }
}

// deterministic PRNG for grain (mulberry32 + Box-Muller)
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

class PostFX {
  constructor(theme, W, H, { vignette = true, grain = true } = {}) {
    this.vig = null; this.grain = []; this.grainAmount = 0; this.W = W; this.H = H;
    const v = vignette ? theme.postParam('vignette') : null;
    if (v && (v.strength || 0) > 0) {
      // computed at reduced resolution and scaled up (the mask is very smooth)
      const ds = Math.max(1, Math.round(Math.min(W, H) / 360));
      const w = Math.ceil(W / ds), h = Math.ceil(H / ds);
      const c = makeCanvas(w, h);
      const ctx = c.getContext('2d');
      const img = ctx.createImageData(w, h);
      const radius = v.radius ?? 0.75, soft = v.softness ?? 0.55, str = v.strength;
      for (let yy = 0; yy < h; yy++) {
        const ny = ((yy + 0.5) * ds - H / 2) / (H / 2);
        for (let xx = 0; xx < w; xx++) {
          const nx = ((xx + 0.5) * ds - W / 2) / (W / 2);
          const r = Math.sqrt(nx * nx * 0.85 + ny * ny);
          let t = Math.max(0, Math.min(1, (r - radius) / Math.max(1e-3, soft)));
          t = t * t * (3 - 2 * t);
          img.data[(yy * w + xx) * 4 + 3] = Math.round(str * t * 255);
        }
      }
      ctx.putImageData(img, 0, 0);
      this.vig = c;
    }
    const g = grain ? theme.postParam('grain') : null;
    if (g && (g.amount || 0) > 0) {
      this.grainAmount = g.amount;
      const R = rng(20240501);
      const size = 256;
      for (let k = 0; k < 4; k++) {
        const c = makeCanvas(size, size);
        const ctx = c.getContext('2d');
        const img = ctx.createImageData(size, size);
        for (let i = 0; i < size * size; i++) {
          const u = Math.max(1e-12, R()), u2 = R();
          const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * u2);
          const v8 = Math.max(0, Math.min(255, 128 + n * 48));
          img.data[i * 4] = v8; img.data[i * 4 + 1] = v8; img.data[i * 4 + 2] = v8; img.data[i * 4 + 3] = 255;
        }
        ctx.putImageData(img, 0, 0);
        this.grain.push(c);
      }
      this._patterns = null;
    }
  }
  apply(ctx, f) {
    if (this.vig) {
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(this.vig, 0, 0, this.W, this.H);
      ctx.restore();
    }
    if (this.grain.length) {
      if (!this._patterns) this._patterns = this.grain.map((c) => ctx.createPattern(c, 'repeat'));
      const k = f % this.grain.length;
      const pat = this._patterns[k];
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = Math.min(1, this.grainAmount * 12);
      const ox = (f * 97) % 256, oy = (f * 61) % 256;
      ctx.translate(-ox, -oy);
      ctx.fillStyle = pat;
      ctx.fillRect(0, 0, this.W + 256, this.H + 256);
      ctx.restore();
    }
  }
}

export class FrameRenderer {
  constructor({ journey, plan, theme, compositor, trail, title, attribution = '', vignette = true, grain = true, overlays = null }) {
    this.j = journey; this.plan = plan; this.theme = theme; this.comp = compositor;
    this.trail = { ...defaultTrail(), ...trail };
    this.title = { ...defaultTitle(), ...title };
    this.attribution = attribution;
    this.W = plan.width; this.H = plan.height;
    this.scale = Math.min(this.W, this.H) / 1080;
    const d = densifyRoute(journey);
    this.xs = d.xs; this.ys = d.ys; this.cum = d.cum; this.modes = d.modes;
    this.flight = Uint8Array.from(d.modes, (m) => (m === Mode.FLIGHT ? 1 : 0));
    const total = journey.totalKm;
    this.recentKm = Math.max(Math.min(80, total * 0.5), total * 0.16) * Math.max(0.05, this.trail.length);
    this.post = new PostFX(theme, this.W, this.H, { vignette, grain });
    this.overlays = overlays || buildOverlays(journey, this.title);
    this.lang = this.title.language;
    this.rtl = isRtl(this.lang);
    this.pal = theme.palette;
    this.trailLayer = makeCanvas(this.W, this.H);
    this.tctx = this.trailLayer.getContext('2d');
    const ds = 5;
    this.bw = Math.max(8, Math.floor(this.W / ds)); this.bh = Math.max(8, Math.floor(this.H / ds));
    this.bloomA = makeCanvas(this.bw, this.bh); this.bloomB = makeCanvas(this.bw, this.bh);
    this._endW = 0;
    this._fonts();
  }

  _fonts() {
    const s = this.scale;
    const px = (v) => Math.max(9, Math.round(v * s));
    this.f = {
      title: [`700 ${px(46)}px ${FONT_DISPLAY}`, px(46)], sub: [`400 ${px(28)}px ${FONT_UI}`, px(28)],
      small: [`400 ${px(17)}px ${FONT_UI}`, px(17)], endTitle: [`700 ${px(72)}px ${FONT_DISPLAY}`, px(72)],
      endStats: [`400 ${px(34)}px ${FONT_UI}`, px(34)],
    };
  }

  state(t) {
    const p = this.plan, n = p.cx.length;
    t = Math.max(0, Math.min(n - 1, t));
    const i0 = Math.floor(t), i1 = Math.min(n - 1, i0 + 1), w = t - i0;
    const L = (a) => a[i0] + (a[i1] - a[i0]) * w;
    const span = w <= 1e-9 ? p.span[i0] : Math.exp(Math.log(p.span[i0]) + (Math.log(p.span[i1]) - Math.log(p.span[i0])) * w);
    return { t, cx: L(p.cx), cy: L(p.cy), span, mx: L(p.mx), my: L(p.my), d: L(p.md), outro: L(p.outro) };
  }

  async prepare(f, signal) {
    const st = this.state(f);
    await this.comp.ensureView(st.cx, st.cy, st.span * this.plan.aspect, st.span, this.W, signal);
  }

  xf(st) {
    const sy = st.span, sx = sy * this.plan.aspect;
    return { left: st.cx - sx / 2, top: st.cy + sy / 2, kx: this.W / sx, ky: this.H / sy };
  }

  // polyline points from dense index range [a, b) plus optional head, decimated in screen space
  _pts(a, b, xf, head, step) {
    const out = [];
    let lx = NaN, ly = NaN, acc = 0, bucket = -1;
    const push = (px, py, force) => {
      if (out.length) { acc += Math.hypot(px - lx, py - ly); }
      const bk = Math.floor(acc / step);
      if (force || bk !== bucket) { out.push(px, py); bucket = bk; }
      lx = px; ly = py;
    };
    for (let i = a; i < b; i++) push((this.xs[i] - xf.left) * xf.kx, (xf.top - this.ys[i]) * xf.ky, i === a);
    if (head) push(head[0], head[1], true);
    else if (b > a && out.length >= 2) {
      const px = (this.xs[b - 1] - xf.left) * xf.kx, py = (xf.top - this.ys[b - 1]) * xf.ky;
      if (out[out.length - 2] !== px || out[out.length - 1] !== py) out.push(px, py);
    }
    return out;
  }

  _stroke(ctx, pts, dy = 0) {
    if (pts.length < 4) return;
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1] + dy);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1] + dy);
    ctx.stroke();
  }

  draw(ctx, f) {
    const st = this.state(f);
    const bloom = this._scene(ctx, st);
    this._finish(ctx, f, st, bloom);
  }

  _scene(ctx, st) {
    const p = this.plan;
    const sy = st.span, sx = sy * p.aspect;
    this.comp.draw(ctx, st.cx, st.cy, sx, sy, this.W, this.H);
    this.comp.drawLabels?.(ctx, st.cx, st.cy, sx, sy, this.W, this.H, this.scale);
    const xf = this.xf(st);
    const d = st.d;
    const i = Math.min(Math.max(bisectRight(this.cum, d) - 1, 0), this.cum.length - 1);
    const head = [(st.mx - xf.left) * xf.kx, (xf.top - st.my) * xf.ky];
    const fade = 1 - smootherstep(st.outro);
    const pal = this.pal, s = this.scale;
    const w0 = 3.2 * s * this.trail.width, w1 = 6.5 * s * this.trail.width;
    ctx.save();
    ctx.lineJoin = 'round';
    if (this.trail.show_full_route && fade > 0.01) this._oldRoute(ctx, i, head, xf, cssColor(pal.trail_old, 0.34 * fade), w0);
    const r0 = Math.max(0, d - this.recentKm);
    const k0 = bisectLeft(this.cum, r0);
    const rp = this._pts(k0, i + 1, xf, head, 1.0 * Math.max(1, s));
    if (rp.length >= 4 && fade > 0.01) {
      if (this.trail.shadow) {
        ctx.strokeStyle = cssColor('#000000', 0.22 * fade);
        ctx.lineWidth = w1 + 3 * s;
        ctx.lineCap = 'round';
        this._stroke(ctx, rp, 1.6 * s);
      }
      this._recent(ctx, rp, w1, fade);
    }
    if (st.outro > 0) this._oldRoute(ctx, this.xs.length - 1, null, xf, cssColor(pal.route, 0.8 * smoothstep(st.outro)), w0 * 1.1);
    if (fade > 0.01) this._marker(ctx, head, st.t, fade, d);
    ctx.restore();
    return { rp, head, w1, fade };
  }

  _oldRoute(ctx, i, head, xf, color, width) {
    const n = i + 1;
    if (n < 1) return;
    const step = 1.25 * Math.max(1, this.scale);
    ctx.strokeStyle = color;
    let a = 0;
    while (a < n) {
      const isF = this.flight[a];
      let b = a + 1;
      while (b < n && this.flight[b] === isF) b++;
      const a0 = Math.max(0, a - 1);
      const last = b === n;
      const pts = this._pts(a0, b, xf, last ? head : null, step);
      if (pts.length >= 4) {
        ctx.lineWidth = width * (isF ? 0.8 : 1);
        ctx.lineCap = isF ? 'butt' : 'round';
        ctx.setLineDash(isF ? [2.4 * width * 0.8, 2.2 * width * 0.8] : []);
        this._stroke(ctx, pts);
      }
      a = b;
    }
    ctx.setLineDash([]);
  }

  _recent(ctx, rp, width, fade) {
    const pal = this.pal;
    const n = rp.length / 2;
    if (!this.trail.gradient || n < 3) {
      ctx.strokeStyle = cssColor(pal.route, fade); ctx.lineWidth = width; ctx.lineCap = 'round';
      this._stroke(ctx, rp);
      return;
    }
    // virtual resampling: uniform screen-space samples so long straight hops still get a smooth gradient
    const c = new Float64Array(n);
    for (let k = 1; k < n; k++) c[k] = c[k - 1] + Math.hypot(rp[2 * k] - rp[2 * k - 2], rp[2 * k + 1] - rp[2 * k - 1]);
    const total = c[n - 1];
    if (total <= 0.5) return;
    const m = Math.min(4000, Math.max(GRADIENT_CHUNKS + 1, Math.floor(total / (3 * Math.max(1, this.scale)))));
    const ux = new Float64Array(m), uy = new Float64Array(m);
    let seg = 0;
    for (let q = 0; q < m; q++) {
      const u = (total * q) / (m - 1);
      while (seg < n - 2 && c[seg + 1] < u) seg++;
      const w = c[seg + 1] - c[seg];
      const fr = w <= 0 ? 0 : (u - c[seg]) / w;
      ux[q] = rp[2 * seg] + (rp[2 * seg + 2] - rp[2 * seg]) * fr;
      uy[q] = rp[2 * seg + 1] + (rp[2 * seg + 3] - rp[2 * seg + 1]) * fr;
    }
    // Chunks on a transparent layer, newest first with destination-over, so overlapping joints keep
    // the newer chunk's alpha instead of accumulating (no dashed banding).
    const L = this.tctx;
    L.setTransform(1, 0, 0, 1, 0, 0);
    L.globalCompositeOperation = 'source-over';
    L.clearRect(0, 0, this.W, this.H);
    L.lineCap = 'round'; L.lineJoin = 'round';
    L.globalCompositeOperation = 'destination-over';
    const edges = [];
    for (let k = 0; k <= GRADIENT_CHUNKS; k++) edges.push(Math.trunc(((m - 1) * k) / GRADIENT_CHUNKS));
    for (let k = GRADIENT_CHUNKS - 1; k >= 0; k--) {
      const a = edges[k], b = Math.min(m, edges[k + 1] + 1);
      if (b - a < 2) continue;
      const t = (k + 1) / GRADIENT_CHUNKS;
      L.strokeStyle = cssColor(pal.route, (0.06 + 0.94 * t ** 1.6) * fade);
      L.lineWidth = width * (0.5 + 0.5 * t);
      L.beginPath();
      L.moveTo(ux[a], uy[a]);
      for (let q = a + 1; q < b; q++) L.lineTo(ux[q], uy[q]);
      L.stroke();
    }
    L.globalCompositeOperation = 'source-over';
    ctx.drawImage(this.trailLayer, 0, 0);
  }

  _bloom(ctx, rp, head, width, fade) {
    const ds = this.W / this.bw;
    const A = this.bloomA.getContext('2d'), B = this.bloomB.getContext('2d');
    A.setTransform(1, 0, 0, 1, 0, 0);
    A.clearRect(0, 0, this.bw, this.bh);
    A.strokeStyle = '#fff'; A.fillStyle = '#fff';
    A.lineCap = 'round'; A.lineJoin = 'round';
    A.lineWidth = Math.max(1, (width * 1.6) / ds);
    if (rp.length >= 4) {
      A.beginPath(); A.moveTo(rp[0] / ds, rp[1] / ds);
      for (let i = 2; i < rp.length; i += 2) A.lineTo(rp[i] / ds, rp[i + 1] / ds);
      A.stroke();
    }
    A.beginPath(); A.arc(head[0] / ds, head[1] / ds, (16 * this.scale) / ds, 0, Math.PI * 2); A.fill();
    // 3 box-blur passes of radius r at 1/5 scale ~ a gaussian of sigma sqrt((2r+1)^2 - 1) / 2
    const r = Math.max(2, Math.trunc(4 * this.scale));
    const sigma = Math.sqrt(3 * (((2 * r + 1) ** 2 - 1) / 12));
    B.setTransform(1, 0, 0, 1, 0, 0);
    B.globalCompositeOperation = 'source-over';
    B.clearRect(0, 0, this.bw, this.bh);
    B.filter = `blur(${sigma.toFixed(2)}px)`;
    B.drawImage(this.bloomA, 0, 0);
    B.filter = 'none';
    B.globalCompositeOperation = 'source-in';
    B.fillStyle = cssColor(this.pal.route_glow.slice(0, 7));
    B.fillRect(0, 0, this.bw, this.bh);
    B.globalCompositeOperation = 'source-over';
    const strength = (this.theme.glow.route ?? 0.6) * fade;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = Math.min(1, strength);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.bloomB, 0, 0, this.W, this.H);
    if (strength > 1) { ctx.globalAlpha = Math.min(1, strength - 1); ctx.drawImage(this.bloomB, 0, 0, this.W, this.H); }
    ctx.restore();
  }

  _finish(ctx, f, st, bloom) {
    if (this.trail.glow && bloom.fade > 0.01) this._bloom(ctx, bloom.rp, bloom.head, bloom.w1, bloom.fade);
    this.post.apply(ctx, f);
    this._typography(ctx, f, st.d);
  }

  _flightBlend(d) {
    const [i, fr] = this.j.hopFraction(d);
    if (!this.j.arcs.has(i)) return [0, 0];
    const w = smoothstep(Math.min(fr, 1 - fr) / 0.1);
    const [dx, dy] = this.j.directionAt(d);
    return [w, Math.atan2(-dy, dx)];
  }

  _marker(ctx, head, f, fade, d) {
    const pal = this.pal, s = this.scale;
    const [plane, heading] = this._flightBlend(d);
    if (plane > 0.001) {
      this._plane(ctx, head, heading, fade * plane);
      fade *= 1 - plane;
      if (fade <= 0.01) return;
    }
    const [x, y] = head;
    if (this.trail.pulse) {
      const period = 1.4;
      const ph = ((f / this.plan.fps) % period) / period;
      const rr = (14 + 26 * smoothstep(ph)) * s;
      ctx.strokeStyle = cssColor(pal.marker_ring, 0.55 * (1 - ph) * fade);
      ctx.lineWidth = 2.2 * s;
      ctx.beginPath(); ctx.arc(x, y, rr, 0, Math.PI * 2); ctx.stroke();
    }
    const g = ctx.createRadialGradient(x, y, 0, x, y, 26 * s);
    g.addColorStop(0, cssColor(pal.marker_ring, 0.55 * fade * Math.min(1, this.theme.glow.marker ?? 0.8)));
    g.addColorStop(1, cssColor(pal.marker_ring, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(x, y, 26 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cssColor(pal.marker_core, fade);
    ctx.strokeStyle = cssColor(pal.marker_ring, fade);
    ctx.lineWidth = 3 * s;
    ctx.beginPath(); ctx.arc(x, y, 8.5 * s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  }

  _plane(ctx, head, heading, alpha) {
    const pal = this.pal, s = this.scale, L = 27 * s;
    const ca = Math.cos(heading), sa = Math.sin(heading);
    const path = () => {
      ctx.beginPath();
      PLANE_OUTLINE.forEach(([x, y], k) => {
        const px = head[0] + (x * ca - y * sa) * L, py = head[1] + (x * sa + y * ca) * L;
        if (k === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      });
      ctx.closePath();
    };
    const g = ctx.createRadialGradient(head[0], head[1], 0, head[0], head[1], 30 * s);
    g.addColorStop(0, cssColor(pal.marker_ring, 0.45 * alpha));
    g.addColorStop(1, cssColor(pal.marker_ring, 0));
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(head[0], head[1], 30 * s, 0, Math.PI * 2); ctx.fill();
    ctx.save(); ctx.translate(0, 2 * s); path(); ctx.fillStyle = cssColor('#000000', 0.28 * alpha); ctx.fill(); ctx.restore();
    path();
    ctx.fillStyle = cssColor(pal.marker_core, alpha); ctx.fill();
    ctx.strokeStyle = cssColor(pal.marker_ring, alpha); ctx.lineWidth = 2.2 * s; ctx.lineJoin = 'round'; ctx.stroke();
  }

  // ------------------------------------------------------------ typography
  _metrics(ctx, font) {
    ctx.font = font[0];
    const m = ctx.measureText('Hg');
    const h = (m.fontBoundingBoxAscent ?? font[1] * 0.95) + (m.fontBoundingBoxDescent ?? font[1] * 0.3);
    return { h, w: (s) => (ctx.font = font[0], ctx.measureText(s).width) };
  }
  _elide(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid; else hi = mid - 1; }
    return text.slice(0, lo) + '…';
  }
  _text(ctx, font, text, x, y, w, h, align, color) {
    ctx.font = font[0];
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.direction = this.rtl ? 'rtl' : 'ltr';
    ctx.textAlign = align;
    const tx = align === 'center' ? x + w / 2 : align === 'right' ? x + w : x;
    ctx.fillText(this._elide(ctx, text, w), tx, y + h / 2);
  }
  _roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x, y, w, h, r);
    else { ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  }

  dateText(d) {
    const p = this.j.partsAtDistance(d);
    return formatDate(p, this.lang, { withDay: this.title.date_format === 'day' });
  }

  _typography(ctx, f, d) {
    const pal = this.pal, W = this.W, H = this.H, s = this.scale;
    const mx = W * SAFE_MARGIN, my = H * SAFE_MARGIN;
    const ob = this.plan.outro[f];
    const fade = 1 - smoothstep(ob * 1.5);
    const layout = this.title.layout;
    const subParts = [];
    if (this.title.show_date) subParts.push(this.dateText(d));
    if (this.title.show_distance) subParts.push(formatDistance(d, this.title.unit, this.lang));
    const subtitle = subParts.join('  •  ');
    const title = this.overlays.title;
    ctx.save();
    if (layout !== 'none' && fade > 0.01 && (title || subtitle)) {
      const mt = this._metrics(ctx, this.f.title), ms = this._metrics(ctx, this.f.sub);
      const tw = title ? mt.w(title) : 0, sw = subtitle ? ms.w(subtitle) : 0;
      const pad = 22 * s, gap = 6 * s;
      const boxW = Math.min(W - 2 * mx, Math.max(tw, sw) + 2 * pad + 2);
      const boxH = (title ? mt.h : 0) + (subtitle ? ms.h : 0) + 2 * pad + (title && subtitle ? gap : 0);
      let x = mx, y = my, align = 'left';
      if (layout === 'centered') { x = (W - boxW) / 2; align = 'center'; }
      else if (layout === 'lower_third') y = H - my - boxH - 26 * s;
      if (this.rtl && layout !== 'centered') { x = W - mx - boxW; align = 'right'; }
      ctx.globalAlpha = fade;
      if (layout !== 'minimal') {
        this._roundRect(ctx, x, y, boxW, boxH, 16 * s);
        ctx.fillStyle = cssColor(pal.card_bg); ctx.fill();
        ctx.strokeStyle = cssColor(pal.card_border); ctx.lineWidth = 1.2 * s; ctx.stroke();
        if (layout === 'lower_third') {
          this._roundRect(ctx, this.rtl ? x + boxW - 6 * s : x, y, 6 * s, boxH, 3 * s);
          ctx.fillStyle = cssColor(pal.route); ctx.fill();
        }
      }
      let ty = y + pad;
      const iw = boxW - 2 * pad;
      if (title) { this._text(ctx, this.f.title, title, x + pad, ty, iw, mt.h, align, cssColor(pal.text_primary)); ty += mt.h + gap; }
      if (subtitle) this._text(ctx, this.f.sub, subtitle, x + pad, ty, iw, ms.h, align, cssColor(pal.text_secondary));
      ctx.globalAlpha = 1;
    }
    // ending title card
    if (this.title.ending_title && ob > 0.35) {
      const a = smoothstep((ob - 0.35) / 0.65);
      ctx.globalAlpha = a;
      const me = this._metrics(ctx, this.f.endTitle), mst = this._metrics(ctx, this.f.endStats);
      const et = this.overlays.endingTitle || this.overlays.title;
      let stx = this.overlays.endingStats;
      if (this.title.count_up && this.overlays.statsAt) {
        this._endW = Math.max(this._endW, mst.w(stx));
        stx = this.overlays.statsAt(1 - (1 - Math.min(1, (ob - 0.35) / 0.55)) ** 3);
      }
      const pad = 30 * s;
      const bw = Math.min(W - 2 * mx, Math.max(me.w(et), mst.w(stx), this._endW) + 2 * pad + 2);
      const bh = me.h + mst.h + 2 * pad + 8 * s;
      const bx = (W - bw) / 2, by = H - my - bh;
      this._roundRect(ctx, bx, by, bw, bh, 20 * s);
      ctx.fillStyle = cssColor(pal.card_bg); ctx.fill();
      ctx.strokeStyle = cssColor(pal.card_border); ctx.lineWidth = 1.2 * s; ctx.stroke();
      this._text(ctx, this.f.endTitle, et, bx + pad, by + pad, bw - 2 * pad, me.h, 'center', cssColor(pal.text_primary));
      this._text(ctx, this.f.endStats, stx, bx + pad, by + pad + me.h + 8 * s, bw - 2 * pad, mst.h, 'center', cssColor(pal.text_secondary));
      ctx.globalAlpha = 1;
    }
    let attrH = 0;
    if (this.attribution) {
      const ma = this._metrics(ctx, this.f.small);
      const aw = ma.w(this.attribution), ah = ma.h;
      attrH = ah + 4 * s;
      const ax = W - W * 0.02 - aw, ay = H - H * 0.02 - ah;
      this._roundRect(ctx, ax - 6 * s, ay - 2 * s, aw + 12 * s, ah + 4 * s, 6 * s);
      ctx.fillStyle = cssColor(pal.card_bg, 0.75); ctx.fill();
      ctx.font = this.f.small[0]; ctx.fillStyle = cssColor(pal.attribution);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.direction = 'ltr';
      ctx.fillText(this.attribution, ax, ay + ah / 2);
    }
    if (this.title.timeline_bar && layout !== 'none' && fade > 0.01) this._timelineBar(ctx, d, fade, attrH);
    ctx.restore();
  }

  _timelineBar(ctx, d, alpha, attrH) {
    const pal = this.pal, s = this.scale, W = this.W, H = this.H;
    const j = this.j;
    const t0 = j.t[0], t1 = j.t[j.t.length - 1];
    if (t1 <= t0) return;
    const tn = j.timeAtDistance(d);
    const u = Math.max(0, Math.min(1, (tn - t0) / (t1 - t0)));
    const portrait = W < H;
    const x0 = W * SAFE_MARGIN, x1 = W * (portrait ? 1 - SAFE_MARGIN : 0.66);
    let y = H - H * SAFE_MARGIN * 0.62;
    if (portrait && attrH) y -= attrH + 10 * s;
    ctx.save();
    ctx.globalAlpha = alpha;
    this._roundRect(ctx, x0, y - 2.5 * s, x1 - x0, 5 * s, 2.5 * s);
    ctx.fillStyle = cssColor(pal.card_bg, 0.55); ctx.fill();
    this._roundRect(ctx, x0, y - 2.5 * s, Math.max(5 * s, (x1 - x0) * u), 5 * s, 2.5 * s);
    ctx.fillStyle = cssColor(pal.route, 0.95); ctx.fill();
    const months = monthStarts(t0, t1, j.off[0]);
    const yearly = months.length > 24;
    ctx.font = this.f.small[0];
    ctx.textAlign = 'center'; ctx.textBaseline = 'bottom'; ctx.direction = 'ltr';
    let lastX = -1e9;
    for (const [ts, yy, mm] of months) {
      if (yearly && mm !== 1) continue;
      const tx = x0 + ((x1 - x0) * (ts - t0)) / (t1 - t0);
      ctx.fillStyle = cssColor(pal.text_secondary, 0.8);
      ctx.fillRect(tx - 0.8 * s, y - 7 * s, 1.6 * s, 4.5 * s);
      const label = yearly ? String(yy) : monthName(mm, this.lang, { short: true });
      const lw = ctx.measureText(label).width;
      if (tx - lw / 2 > lastX + 8 * s && tx + lw / 2 < x1) {
        ctx.fillStyle = cssColor(pal.text_secondary, 0.9);
        ctx.fillText(label, tx, y - 9 * s);
        lastX = tx + lw / 2;
      }
    }
    const hx = x0 + (x1 - x0) * u;
    ctx.fillStyle = cssColor(pal.marker_ring, 0.35);
    ctx.beginPath(); ctx.arc(hx, y, 9 * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cssColor(pal.marker_core);
    ctx.beginPath(); ctx.arc(hx, y, 5 * s, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
}
export { hexRgb };
