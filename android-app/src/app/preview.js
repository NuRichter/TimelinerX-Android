// Real-time preview: the exact export renderer at a capped resolution, played back live.
// Tiles stream in asynchronously; a frame is redrawn when a tile it needs arrives.
import { getTheme } from '../render/grading.js';
import { makeProvider, MapCompositor } from '../render/tiles.js';
import { FrameRenderer } from '../render/renderer.js';

export function previewDims(aspect, longEdge = 960) {
  if (aspect === '9:16') return [Math.round((longEdge * 9) / 16 / 2) * 2, longEdge];
  if (aspect === '1:1') return [Math.round(longEdge * 0.75 / 2) * 2, Math.round(longEdge * 0.75 / 2) * 2];
  return [longEdge, Math.round((longEdge * 9) / 16 / 2) * 2];
}

export class PreviewEngine {
  constructor(canvas, { onTime, onState } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onTime = onTime; this.onState = onState;
    this.plan = null; this.journey = null; this.comp = null; this.renderer = null;
    this.frame = 0; this.playing = false; this.raf = 0; this.dirty = true;
    this.compKey = ''; this.rendKey = '';
    this._last = 0; this._acc = 0;
    this._loop = this._loop.bind(this);
  }

  setPlan(plan, journey) {
    this.plan = plan; this.journey = journey;
    this.canvas.width = plan.width; this.canvas.height = plan.height;
    this.frame = Math.min(this.frame, plan.frameCount - 1);
    this.renderer = null; this.rendKey = '';
    this.dirty = true;
  }

  async setLook({ theme: themeId, map, labels = true, lang = 'en', settings = {} }) {
    const key = JSON.stringify([themeId, map, labels, lang, settings.cartoKey || '', settings.xyzTemplate || '']);
    if (key === this.compKey && this.comp) return;
    this.compKey = key;
    const theme = getTheme(themeId);
    let provider = await makeProvider(map, theme, settings);
    this.missingKey = !!provider.missingKey;
    if (provider.missingKey) provider = await makeProvider('world', theme, settings);
    if (key !== this.compKey) return;
    this.comp?.dispose();
    this.theme = theme;
    this.comp = new MapCompositor(provider, theme, { lang, labels, lru: 260 });
    this.comp.onTile = () => { this.dirty = true; if (!this.playing) this._kick(); };
    this.attribution = provider.attribution;
    this.renderer = null; this.rendKey = '';
    this.dirty = true;
  }

  setOverlays({ trail, title, vignette, grain }) {
    const key = JSON.stringify([trail, title, vignette, grain]);
    if (key === this.rendKey && this.renderer) return;
    this.rendKey = key;
    this.overlayOpts = { trail, title, vignette, grain };
    this.renderer = null;
    this.dirty = true;
  }

  _ensureRenderer() {
    if (this.renderer || !this.plan || !this.comp || !this.overlayOpts) return !!this.renderer;
    const o = this.overlayOpts;
    this.renderer = new FrameRenderer({
      journey: this.journey, plan: this.plan, theme: this.theme, compositor: this.comp, trail: o.trail, title: o.title,
      attribution: this.attribution, vignette: o.vignette, grain: o.grain,
    });
    return true;
  }

  drawNow() {
    if (!this._ensureRenderer()) return;
    const f = Math.max(0, Math.min(this.plan.frameCount - 1, Math.round(this.frame)));
    const st = this.renderer.state(f);
    this.comp.ensureView(st.cx, st.cy, st.span * this.plan.aspect, st.span, this.plan.width).catch(() => {});
    if (this.playing) {
      const ahead = this.renderer.state(Math.min(this.plan.frameCount - 1, f + Math.round(this.plan.fps * 0.6)));
      this.comp.ensureView(ahead.cx, ahead.cy, ahead.span * this.plan.aspect, ahead.span, this.plan.width).catch(() => {});
    }
    this.renderer.draw(this.ctx, f);
    this.dirty = false;
  }

  _kick() { if (!this.raf) this.raf = requestAnimationFrame(this._loop); }

  _loop(ts) {
    this.raf = 0;
    if (!this.plan) return;
    if (this.playing) {
      if (!this._last) this._last = ts;
      const dt = Math.min(0.25, (ts - this._last) / 1000);
      this._last = ts;
      this.frame += dt * this.plan.fps;
      if (this.frame >= this.plan.frameCount - 1) { this.frame = this.plan.frameCount - 1; this.dirty = true; this.drawNow(); this.pause(); this.onTime?.(this.frame / (this.plan.frameCount - 1)); return; }
      this.dirty = true;
      this.onTime?.(this.frame / Math.max(1, this.plan.frameCount - 1));
    }
    if (this.dirty) this.drawNow();
    if (this.playing || this.dirty) this._kick();
  }

  play() {
    if (!this.plan) return;
    if (this.frame >= this.plan.frameCount - 1) this.frame = 0;
    this.playing = true; this._last = 0;
    this.onState?.(true);
    this._kick();
  }
  pause() { this.playing = false; this.onState?.(false); }
  toggle() { if (this.playing) this.pause(); else this.play(); }
  seek(frac) {
    if (!this.plan) return;
    this.frame = Math.max(0, Math.min(1, frac)) * (this.plan.frameCount - 1);
    this.dirty = true;
    this._kick();
  }
  refresh() { this.dirty = true; this._kick(); }
  dispose() { cancelAnimationFrame(this.raf); this.raf = 0; this.playing = false; this.comp?.dispose(); this.comp = null; }
}
