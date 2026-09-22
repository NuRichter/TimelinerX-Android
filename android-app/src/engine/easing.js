// Easing curves, splines and zero-phase filters used by the camera system (port of core/easing.py).

export const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);
export const linear = (t) => clamp01(t);
export function smoothstep(t) { t = clamp01(t); return t * t * (3 - 2 * t); }
export function smootherstep(t) { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); }
export function easeInOutCubic(t) { t = clamp01(t); return t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2; }
export function easeOutCubic(t) { t = clamp01(t); return 1 - (1 - t) ** 3; }
export function easeInOutSine(t) { t = clamp01(t); return -(Math.cos(Math.PI * t) - 1) / 2; }
export function easeOutBackDamped(t, overshoot = 0.6) {
  t = clamp01(t); const c1 = overshoot, c3 = c1 + 1;
  return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
}
export const EASINGS = {
  linear, smoothstep, smootherstep,
  'ease-in-out-cubic': easeInOutCubic, 'ease-out-cubic': easeOutCubic,
  'ease-in-out-sine': easeInOutSine, 'ease-out-back': easeOutBackDamped,
};
export const lerp = (a, b, t) => a + (b - a) * t;
export const logLerp = (a, b, t) => Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * t);

export function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export function catmullRomSample(values, position) {
  const n = values.length;
  if (n === 0) throw new Error('empty spline');
  if (n === 1) return values[0];
  position = Math.max(0, Math.min(n - 1, position));
  const i = Math.min(Math.floor(position), n - 2);
  const t = position - i;
  return catmullRom(values[Math.max(i - 1, 0)], values[i], values[i + 1], values[Math.min(i + 2, n - 1)], t);
}

// Zero-phase Gaussian low-pass with edge clamping (numpy convolve 'valid' on an edge-padded signal).
export function gaussianSmooth(values, sigma) {
  const n = values.length;
  const out = new Float64Array(n);
  if (n === 0) return out;
  if (!(sigma > 0.05)) { out.set(values); return out; }
  const radius = Math.max(1, Math.trunc(3 * sigma));
  const k = new Float64Array(2 * radius + 1);
  let ks = 0;
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k[i + radius] = v; ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const first = values[0], last = values[n - 1];
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = -radius; j <= radius; j++) {
      const idx = i + j;
      acc += k[j + radius] * (idx < 0 ? first : idx >= n ? last : values[idx]);
    }
    out[i] = acc;
  }
  return out;
}

export function secondDerivative(v) {
  const out = [];
  for (let i = 1; i < v.length - 1; i++) out.push(v[i - 1] - 2 * v[i] + v[i + 1]);
  return out;
}

export function spikeRatio(values) {
  const d2 = secondDerivative(values).map(Math.abs);
  if (!d2.length) return 0;
  const s = [...d2].sort((a, b) => a - b);
  const median = s[s.length >> 1];
  const p99 = s[Math.min(s.length - 1, Math.floor(s.length * 0.99))];
  return Math.max(...d2) / Math.max(median, p99 * 1e-3, 1e-12);
}

// van Wijk & Nuij (2003) smooth and efficient zooming and panning. c = [cx, cy, span].
export function zoomPanInterpolator(c0, c1, rho = 1.41421356) {
  const [ux0, uy0] = c0; const [ux1, uy1] = c1;
  const w0 = Math.max(c0[2], 1e-9), w1 = Math.max(c1[2], 1e-9);
  const dx = ux1 - ux0, dy = uy1 - uy0;
  const d2 = dx * dx + dy * dy;
  const rho2 = rho * rho, rho4 = rho2 * rho2;
  if (d2 < 1e-12 * Math.max(w0, w1) ** 2) {
    const S = Math.log(w1 / w0) / rho;
    return (t) => [ux0 + t * dx, uy0 + t * dy, w0 * Math.exp(rho * t * S)];
  }
  const d1 = Math.sqrt(d2);
  const b0 = (w1 * w1 - w0 * w0 + rho4 * d2) / (2 * w0 * rho2 * d1);
  const b1 = (w1 * w1 - w0 * w0 - rho4 * d2) / (2 * w1 * rho2 * d1);
  const r0 = Math.log(Math.sqrt(b0 * b0 + 1) - b0);
  const r1 = Math.log(Math.sqrt(b1 * b1 + 1) - b1);
  const S = (r1 - r0) / rho;
  const coshR0 = Math.cosh(r0), sinhR0 = Math.sinh(r0);
  return (t) => {
    const s = t * S;
    const u = (w0 / (rho2 * d1)) * (coshR0 * Math.tanh(rho * s + r0) - sinhR0);
    return [ux0 + u * dx, uy0 + u * dy, (w0 * coshR0) / Math.cosh(rho * s + r0)];
  };
}

// numpy.interp for sorted xp (clamped at the ends).
export function interp(x, xp, fp) {
  const n = xp.length;
  if (x <= xp[0]) return fp[0];
  if (x >= xp[n - 1]) return fp[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >>> 1; if (xp[m] <= x) lo = m; else hi = m; }
  const w = xp[hi] - xp[lo];
  return w <= 0 ? fp[hi] : fp[lo] + (fp[hi] - fp[lo]) * ((x - xp[lo]) / w);
}
