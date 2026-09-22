// Project model: every user-visible setting. Field names follow the desktop .nrproj schema
// (timelinerx-project, schema 1), so projects move between Android and desktop.
import { defaultTrail, defaultTitle } from '../render/renderer.js';
import { dayNumber } from '../engine/journey.js';

export const RENDER_ENGINE_VERSION = 'tlx-2.0.0';
export const APP_VERSION = '1.0.0';
export const ASPECTS = { '16:9': [16, 9], '9:16': [9, 16], '1:1': [1, 1] };
export const RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'];
export const FPS_CHOICES = [24, 30, 60];
export const QUALITY = ['draft', 'standard', 'high', 'cinematic'];
export const TITLE_LAYOUTS = ['corner', 'centered', 'minimal', 'lower_third', 'none'];
export const MAP_SOURCES = ['auto', 'world', 'carto', 'carto-voyager', 'plain', 'xyz'];

export function defaultProject(lang = 'en', unit = 'km') {
  return {
    name: '',
    timeline: { name: '', points: 0 },
    period: { start: null, end: null },
    journey: { route_source: 'semantic', outlier_filter: 'conservative', trip_detection: 'balanced' },
    camera: {
      mode: 'active', composition: 'thirds', local_framing: 'balanced', pacing: 'visual_zoom', compression: 'balanced',
      smoothing: 1.0, anticipation: 1.0, intro_s: 1.2, outro_transition_s: 1.2, outro_hold_s: 1.2, keyframes: [],
    },
    visual: { theme: 'neon_dark_blue', map_provider: 'auto', trail: defaultTrail(), vignette: true, grain: true, labels: true, offline: false },
    title: { ...defaultTitle(), language: lang, unit },
    video: { resolution: '1080p', aspect: '16:9', fps: 30, duration_s: 30, quality: 'high', codec: 'h264' },
    audio: { enabled: false, name: '', volume: 1.0, fade_out_s: 2.0 },
    render_engine_version: RENDER_ENGINE_VERSION,
  };
}

export function resolveDimensions(resolution, aspect) {
  const [aw, ah] = ASPECTS[aspect] || ASPECTS['16:9'];
  const short = parseInt(resolution, 10) || 1080;
  let w, h;
  if (aw >= ah) { h = short; w = Math.floor((short * aw) / ah); } else { w = short; h = Math.floor((short * ah) / aw); }
  return [w - (w % 2), h - (h % 2)];
}

export function cameraConfig(p) {
  const c = p.camera;
  return {
    mode: c.mode, composition: c.composition, local_framing: c.local_framing, pacing: c.pacing, compression: c.compression,
    trip_detection: p.journey.trip_detection, smoothing: c.smoothing, anticipation: c.anticipation, intro_s: c.intro_s,
    outro_transition_s: c.outro_transition_s, outro_hold_s: c.outro_hold_s, keyframes: c.keyframes || [],
    overview_bottom_reserve: p.title.ending_title ? 0.24 : 0,
  };
}

export function journeyConfig(p) {
  return { start: p.period.start, end: p.period.end, ...p.journey };
}

// Merge a stored / imported project over the defaults (unknown keys are dropped).
export function mergeProject(base, patch) {
  const out = structuredClone(base);
  const walk = (o, src) => {
    for (const k of Object.keys(o)) {
      if (!(k in (src || {}))) continue;
      const v = src[k];
      if (o[k] && typeof o[k] === 'object' && !Array.isArray(o[k]) && v && typeof v === 'object' && !Array.isArray(v)) walk(o[k], v);
      else if (v !== undefined) o[k] = v;
    }
  };
  walk(out, patch || {});
  const legacyMode = { steady: 'balanced', dynamic: 'active' };
  const legacyPace = { off: 'natural', gentle: 'balanced', strong: 'faster', stronger: 'fastest' };
  out.camera.mode = legacyMode[out.camera.mode] || out.camera.mode;
  out.camera.compression = legacyPace[out.camera.compression] || out.camera.compression;
  return out;
}

// Desktop-compatible .nrproj (the Timeline itself is never embedded).
export function toNrproj(p) {
  const res = { '720p': '720p', '1080p': '1080p', '1440p': '1440p', '2160p': '2160p' }[p.video.resolution] || '1080p';
  return {
    format: 'timelinerx-project', schema_version: 1, app_version: APP_VERSION + '-android',
    name: p.name || 'Untitled journey',
    timeline: { path: p.timeline.name || '', sha256: '', size: 0 },
    period: { ...p.period },
    journey: { ...p.journey },
    camera: { ...p.camera },
    visual: {
      theme: p.visual.theme, map_provider: p.visual.map_provider === 'world' || p.visual.map_provider === 'auto' ? 'plain' : p.visual.map_provider === 'xyz' ? 'plain' : p.visual.map_provider,
      trail: { ...p.visual.trail }, vignette: p.visual.vignette, grain: p.visual.grain, offline: false,
    },
    title: { ...p.title },
    video: { resolution: res, aspect: p.video.aspect, width: null, height: null, fps: p.video.fps, duration_s: p.video.duration_s, quality: p.video.quality, codec: p.video.codec, encoder: 'auto', two_pass: false, hdr: false, motion_blur: false },
    audio: { enabled: false, path: null, volume: p.audio.volume, beat_sync: false, ducking: false, duck_db: -8.0, fade_out_s: p.audio.fade_out_s },
    output_dir: null,
    render_engine_version: RENDER_ENGINE_VERSION,
  };
}

export function fromNrproj(d, base) {
  if (!d || (d.format !== 'timelinerx-project' && d.format !== 'nurichter-project')) throw new Error('Not a TimelinerX project file.');
  const p = mergeProject(base, d);
  if (!RESOLUTIONS.includes(p.video.resolution)) p.video.resolution = p.video.resolution === '4K' || p.video.resolution === '8K' ? '2160p' : '1080p';
  if (p.visual.map_provider === 'carto-light' || p.visual.map_provider === 'carto-dark') p.visual.map_provider = 'carto';
  if (typeof p.visual.map_provider === 'string' && p.visual.map_provider.startsWith('mbtiles:')) p.visual.map_provider = 'world';
  return p;
}

export function periodDays(p) { return [dayNumber(p.period.start), dayNumber(p.period.end)]; }
