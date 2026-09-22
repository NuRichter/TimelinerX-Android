// Platform layer: the Capacitor native plugin on Android, graceful browser fallbacks elsewhere
// (so the whole app also runs, and is tested, in a normal browser).
import { Capacitor, CapacitorHttp, registerPlugin } from '@capacitor/core';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform();
const Tlx = isNative ? registerPlugin('TlxNative') : null;

export function fileSrc(path) { return isNative ? Capacitor.convertFileSrc(path) : path; }

function b64(bytes) {
  let s = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Streams the MP4 into the app cache on the device, then copies it into Movies/TimelinerX.
export class NativeSink {
  constructor(name, title) { this.name = name; this.title = title; this.id = null; this.chain = Promise.resolve(); }
  async open() { const r = await Tlx.sinkOpen({ name: this.name }); this.id = r.id; }
  write(data, position) {
    const payload = { id: this.id, position, data: b64(data) };
    const p = this.chain.then(() => Tlx.sinkWrite(payload));
    this.chain = p;
    return p;
  }
  async close() {
    await this.chain;
    const r = await Tlx.sinkClose({ id: this.id, title: this.title, saveToGallery: true });
    return { path: r.path, uri: r.uri, bytes: r.size, url: fileSrc(r.path) };
  }
  async abort() { try { await this.chain; } catch { /* ignore */ } if (this.id) await Tlx.sinkAbort({ id: this.id }).catch(() => {}); }
}

// Tile fetch through the native HTTP stack (used only if the WebView fetch fails, e.g. CORS).
export async function nativeFetchBlob(url) {
  if (!isNative) return null;
  const r = await CapacitorHttp.get({ url, responseType: 'blob', headers: { 'User-Agent': 'TimelinerX-Android' } });
  if (r.status < 200 || r.status >= 300) throw new Error('HTTP ' + r.status);
  const data = typeof r.data === 'string' ? unb64(r.data) : new Uint8Array(r.data);
  return new Blob([data], { type: 'image/png' });
}

export async function keepAwake(on) {
  if (isNative) return Tlx.keepAwake({ on }).catch(() => {});
  try {
    if (on && navigator.wakeLock) keepAwake._lock = await navigator.wakeLock.request('screen');
    else if (!on && keepAwake._lock) { await keepAwake._lock.release(); keepAwake._lock = null; }
  } catch { /* not supported */ }
}

export async function deviceInfo() {
  if (isNative) { try { return await Tlx.getInfo(); } catch { /* fall through */ } }
  return { sdk: 0, model: /Android/.test(navigator.userAgent) ? 'Android (browser)' : 'Browser', totalMemMB: (navigator.deviceMemory || 4) * 1024, lowRam: (navigator.deviceMemory || 4) <= 2 };
}

export async function shareVideo(item) {
  if (isNative) return Tlx.share({ uri: item.uri, path: item.path, mime: 'video/mp4', title: item.title || 'TimelinerX' });
  if (item.blob && navigator.canShare?.({ files: [new File([item.blob], item.fileName, { type: 'video/mp4' })] })) {
    return navigator.share({ files: [new File([item.blob], item.fileName, { type: 'video/mp4' })], title: item.title });
  }
  return downloadBlob(item.blob, item.fileName);
}

export async function shareFile(blob, name, mime) {
  if (isNative) { const data = b64(new Uint8Array(await blob.arrayBuffer())); return Tlx.shareFile({ name, data, mime }); }
  return downloadBlob(blob, name);
}

export function downloadBlob(blob, name) {
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
}

export async function openVideo(item) {
  if (isNative) return Tlx.openMedia({ uri: item.uri, path: item.uri ? undefined : item.path, mime: 'video/mp4' });
  if (item.blob) window.open(URL.createObjectURL(item.blob), '_blank');
}

export async function mediaExists(uri) {
  if (!isNative || !uri) return true;
  try { return (await Tlx.mediaExists({ uri })).exists; } catch { return true; }
}

export async function deleteMedia(uri) {
  if (!isNative || !uri) return false;
  return (await Tlx.deleteMedia({ uri })).deleted;
}

export async function deleteCacheFile(path) { if (isNative && path) await Tlx.deleteFile({ path }).catch(() => {}); }
export async function clearExports() { if (isNative) await Tlx.clearExports().catch(() => {}); }

export function openUrl(url) {
  if (isNative) return Tlx.openUrl({ url }).catch(() => window.open(url, '_blank'));
  window.open(url, '_blank', 'noopener');
}

// Timeline files opened with / shared to TimelinerX.
export async function onIncomingFile(handler) {
  if (!isNative) return;
  const deliver = async (f) => {
    if (!f) return;
    if (f.error) { handler({ error: f.error }); return; }
    handler({ name: f.name, size: f.size, path: f.path, url: fileSrc(f.path) });
  };
  Tlx.addListener('incomingFile', async () => { const r = await Tlx.consumeIncoming(); deliver(r.file); });
  const r = await Tlx.consumeIncoming().catch(() => null);
  if (r?.file) deliver(r.file);
}

export async function onBackButton(handler) {
  if (!isNative) return;
  const { App } = await import('@capacitor/app');
  App.addListener('backButton', handler);
}
export async function exitApp() { if (isNative) { const { App } = await import('@capacitor/app'); App.exitApp(); } }

export async function setupChrome() {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#0b1020' });
  } catch { /* optional */ }
  try { const { SplashScreen } = await import('@capacitor/splash-screen'); await SplashScreen.hide({ fadeOutDuration: 300 }); } catch { /* optional */ }
}
