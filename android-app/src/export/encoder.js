// Video export: frames from the renderer -> WebCodecs VideoEncoder (hardware MediaCodec on Android)
// -> MP4 (fast start, space for the index reserved up front, streamed to a sink so long 4K videos
// never have to fit in memory). Optional soundtrack: decoded, resampled, faded, AAC (or Opus).
import { Muxer, StreamTarget } from 'mp4-muxer';

export const QUALITY_BPP = { draft: 0.05, standard: 0.08, high: 0.12, cinematic: 0.18 };

const AVC_LEVELS = [ // [levelHex, maxMBps, maxFrameMBs]
  ['1f', 108000, 3600], ['20', 216000, 5120], ['28', 245760, 8192], ['2a', 522240, 8704], ['32', 589824, 22080],
  ['33', 983040, 36864], ['34', 2073600, 36864], ['3c', 4177920, 139264], ['3d', 8355840, 139264], ['3e', 16711680, 139264],
];

function avcLevel(w, h, fps) {
  const fs = Math.ceil(w / 16) * Math.ceil(h / 16);
  const mbps = fs * fps;
  for (const [hex, maxMbps, maxFs] of AVC_LEVELS) if (mbps <= maxMbps && fs <= maxFs && Math.sqrt(maxFs * 8) >= Math.max(w, h) / 16) return hex;
  return '3e';
}

export function bitrateFor(w, h, fps, quality = 'high') {
  return Math.round(Math.min(80e6, Math.max(1.2e6, w * h * fps * (QUALITY_BPP[quality] ?? 0.12))));
}

export async function pickVideoConfig({ width, height, fps, bitrate, codec = 'h264' }) {
  if (typeof VideoEncoder === 'undefined') return null;
  const tries = [];
  if (codec === 'hevc') {
    for (const c of ['hvc1.1.6.L153.B0', 'hvc1.1.6.L150.B0', 'hvc1.1.6.L123.B0']) tries.push(['hevc', c]);
  }
  const lv = avcLevel(width, height, fps);
  for (const prof of ['6400', '4d00', '42e0']) tries.push(['avc', `avc1.${prof}${lv}`]);
  for (const prof of ['6400', '4d00', '42e0']) tries.push(['avc', `avc1.${prof}33`], ['avc', `avc1.${prof}34`]);
  for (const accel of ['prefer-hardware', 'no-preference']) {
    for (const [kind, c] of tries) {
      const cfg = {
        codec: c, width, height, bitrate, framerate: fps, hardwareAcceleration: accel, latencyMode: 'quality', bitrateMode: 'variable',
        ...(kind === 'avc' ? { avc: { format: 'avc' } } : { hevc: { format: 'hevc' } }),
      };
      try {
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r.supported) return { config: r.config || cfg, kind, accel };
      } catch { /* try next */ }
    }
  }
  return null;
}

export async function encoderCapabilities() {
  const out = { webcodecs: typeof VideoEncoder !== 'undefined', sizes: {} };
  if (!out.webcodecs) return out;
  for (const [name, w, h] of [['720p', 1280, 720], ['1080p', 1920, 1080], ['1440p', 2560, 1440], ['2160p', 3840, 2160]]) {
    const r = await pickVideoConfig({ width: w, height: h, fps: 30, bitrate: bitrateFor(w, h, 30) });
    out.sizes[name] = r ? { ok: true, hw: r.accel === 'prefer-hardware', codec: r.config.codec } : { ok: false };
  }
  return out;
}

// ------------------------------------------------------------------ audio
export async function decodeAudioFile(blob) {
  const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
  const ctx = new AC();
  try { return await ctx.decodeAudioData(await blob.arrayBuffer()); } finally { ctx.close?.(); }
}

// Render the soundtrack to exactly `durationS` seconds at 48 kHz stereo with volume and fade-out.
export async function prepareSoundtrack(buffer, { durationS, volume = 1, fadeOutS = 2, sampleRate = 48000 }) {
  const length = Math.ceil(durationS * sampleRate);
  const oac = new OfflineAudioContext(2, length, sampleRate);
  const src = oac.createBufferSource();
  src.buffer = buffer;
  src.loop = buffer.duration < durationS;
  const g = oac.createGain();
  g.gain.setValueAtTime(volume, 0);
  const fo = Math.min(fadeOutS, durationS * 0.5);
  if (fo > 0) { g.gain.setValueAtTime(volume, Math.max(0, durationS - fo)); g.gain.linearRampToValueAtTime(0.0001, durationS); }
  src.connect(g).connect(oac.destination);
  src.start(0);
  return oac.startRendering();
}

async function pickAudioConfig(sampleRate, channels) {
  if (typeof AudioEncoder === 'undefined') return null;
  for (const [kind, codec] of [['aac', 'mp4a.40.2'], ['opus', 'opus']]) {
    const cfg = { codec, sampleRate, numberOfChannels: channels, bitrate: 192000 };
    try { const r = await AudioEncoder.isConfigSupported(cfg); if (r.supported) return { kind, config: r.config || cfg }; } catch { /* next */ }
  }
  return null;
}

async function encodeAudio(muxer, audioBuffer, ac) {
  let err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (e) => { err = e; } });
  enc.configure(ac.config);
  const sr = audioBuffer.sampleRate, ch = audioBuffer.numberOfChannels, n = audioBuffer.length;
  const frame = 1024 * 8;
  const planes = Array.from({ length: ch }, (_, c) => audioBuffer.getChannelData(c));
  for (let at = 0; at < n; at += frame) {
    const len = Math.min(frame, n - at);
    const data = new Float32Array(len * ch);
    for (let c = 0; c < ch; c++) data.set(planes[c].subarray(at, at + len), c * len);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: sr, numberOfFrames: len, numberOfChannels: ch, timestamp: Math.round((at / sr) * 1e6), data });
    enc.encode(ad);
    ad.close();
    if (enc.encodeQueueSize > 8) await new Promise((r) => setTimeout(r, 0));
  }
  await enc.flush();
  enc.close();
  if (err) throw err;
}

// ------------------------------------------------------------------ sinks
export class MemorySink {
  constructor() { this.parts = []; this.size = 0; }
  async open() {}
  write(data, position) { this.parts.push([position, data.slice()]); this.size = Math.max(this.size, position + data.length); }
  async flush() {}
  async close() {
    const out = new Uint8Array(this.size);
    for (const [pos, d] of this.parts) out.set(d, pos);
    this.parts = [];
    return { blob: new Blob([out], { type: 'video/mp4' }), bytes: out.length };
  }
  async abort() { this.parts = []; }
}

// ------------------------------------------------------------------ render + encode
export class RenderCancelled extends Error { constructor() { super('cancelled'); this.code = 'cancelled'; } }

export async function renderVideo({ renderer, canvas, fps, frames, bitrate, codec = 'h264', soundtrack = null, sink, onProgress, onFrame, signal }) {
  const W = canvas.width, H = canvas.height;
  const vc = await pickVideoConfig({ width: W, height: H, fps, bitrate, codec });
  if (!vc) throw Object.assign(new Error(`This device cannot encode ${W}×${H} video.`), { code: 'no_encoder' });
  let ac = null;
  if (soundtrack) ac = await pickAudioConfig(soundtrack.sampleRate, soundtrack.numberOfChannels);
  await sink.open();
  let writeErr = null;
  const pendingWrites = [];
  const target = new StreamTarget({
    onData: (data, position) => { try { const p = sink.write(data, position); if (p?.then) pendingWrites.push(p.catch((e) => { writeErr = e; })); } catch (e) { writeErr = e; } },
    chunked: true, chunkSize: 4 * 1024 * 1024,
  });
  const audioChunks = soundtrack && ac ? Math.ceil((soundtrack.duration * soundtrack.sampleRate) / 1024) + 64 : 0;
  const muxer = new Muxer({
    target,
    video: { codec: vc.kind, width: W, height: H, frameRate: fps },
    ...(ac ? { audio: { codec: ac.kind, numberOfChannels: soundtrack.numberOfChannels, sampleRate: soundtrack.sampleRate } } : {}),
    fastStart: { expectedVideoChunks: frames + 8, ...(ac ? { expectedAudioChunks: audioChunks } : {}) },
    firstTimestampBehavior: 'offset',
  });
  let encErr = null;
  const encoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
  encoder.configure(vc.config);
  const ctx = canvas.getContext('2d', { alpha: false });
  const t0 = performance.now();
  const gop = Math.max(1, Math.round(fps * 2));
  const tm = { prepare: 0, draw: 0, grab: 0, wait: 0 };
  let tA;
  try {
    for (let f = 0; f < frames; f++) {
      if (signal?.aborted) throw new RenderCancelled();
      if (encErr) throw encErr;
      if (writeErr) throw writeErr;
      tA = performance.now();
      await renderer.prepare(f, signal);
      tm.prepare += performance.now() - tA; tA = performance.now();
      renderer.draw(ctx, f);
      tm.draw += performance.now() - tA; tA = performance.now();
      const vf = new VideoFrame(canvas, { timestamp: Math.round((f * 1e6) / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(vf, { keyFrame: f % gop === 0 });
      vf.close();
      tm.grab += performance.now() - tA; tA = performance.now();
      while (encoder.encodeQueueSize > 3) await new Promise((r) => setTimeout(r, 1));
      if (pendingWrites.length > 4) await Promise.all(pendingWrites.splice(0));
      tm.wait += performance.now() - tA;
      const el = (performance.now() - t0) / 1000;
      onProgress?.({ frame: f + 1, frames, fps: (f + 1) / Math.max(1e-3, el), eta: ((frames - f - 1) * el) / (f + 1), elapsed: el });
      onFrame?.(f);
      if (f % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    await encoder.flush();
    if (encErr) throw encErr;
    encoder.close();
    if (ac) await encodeAudio(muxer, soundtrack, ac);
    muxer.finalize();
    await Promise.all(pendingWrites.splice(0));
    if (writeErr) throw writeErr;
    const res = await sink.close();
    return { ...res, codec: vc.config.codec, hardware: vc.accel === 'prefer-hardware', audio: ac?.kind || null, width: W, height: H, fps, frames, seconds: (performance.now() - t0) / 1000, timing: tm };
  } catch (e) {
    try { encoder.state !== 'closed' && encoder.close(); } catch { /* ignore */ }
    await sink.abort?.();
    throw e;
  }
}
