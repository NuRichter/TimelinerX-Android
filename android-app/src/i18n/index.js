// Internationalisation: 10 languages. Desktop translations are reused verbatim; Android-only
// strings live in android.data.js. tr(key) falls back to English, then to the key itself.
import { DESKTOP } from './desktop.data.js';
import { ANDROID } from './android.data.js';

export const LANGUAGES = {
  en: 'English', id: 'Bahasa Indonesia', es: 'Español', fr: 'Français', de: 'Deutsch',
  pt: 'Português (Brasil)', ru: 'Русский', ar: 'العربية', zh: '中文（简体）', ja: '日本語',
};
const RTL = new Set(['ar']);
let active = 'en';

export function setLanguage(l) { active = LANGUAGES[l] ? l : 'en'; }
export function language() { return active; }
export function isRtl(l) { return RTL.has(l || active); }

export function guessLanguage(navLangs = []) {
  for (const n of navLangs) { const b = String(n).toLowerCase().split('-')[0]; if (b === 'in') return 'id'; if (LANGUAGES[b]) return b; }
  return 'en';
}

function lookup(key, l) {
  return ANDROID[l]?.[key] ?? DESKTOP[l]?.[key] ?? ANDROID.en?.[key] ?? DESKTOP.en?.[key];
}

export function tr(key, a, b) {
  // tr(key) | tr(key, fmt) | tr(key, lang) | tr(key, lang, fmt)
  let l = active, fmt = null;
  if (typeof a === 'string') { l = a; fmt = b || null; } else if (a) fmt = a;
  let s = lookup(key, l);
  if (s === undefined) return key;
  if (fmt) s = s.replace(/\{(\w+)\}/g, (m, k) => (fmt[k] !== undefined ? String(fmt[k]) : m));
  return s;
}
export const t = tr;

export function monthName(m, l, { short = false, genitive = false } = {}) {
  if (short) return tr(`month.short.${m}`, l || active);
  if (genitive) { const g = DESKTOP[l || active]?.[`month.gen.${m}`]; if (g) return g; }
  return tr(`month.${m}`, l || active);
}

// parts: {y, m, d}
export function formatDate(p, l, { withDay = true, short = false } = {}) {
  l = l || active;
  if (withDay) {
    return tr(short ? 'video.date.short_day' : 'video.date.day', l, { day: p.d, month: monthName(p.m, l, { short, genitive: !short }), year: p.y, m: p.m });
  }
  return tr('video.date.month', l, { month: monthName(p.m, l), year: p.y, m: p.m });
}

const SEP = { en: [',', '.'], id: ['.', ','], es: ['.', ','], fr: ['\u202f', ','], de: ['.', ','], ru: ['\u00a0', ','], ja: [',', '.'], zh: [',', '.'], ar: ['\u066c', '\u066b'], pt: ['.', ','] };

export function formatNumber(x, decimals = 0, l) {
  const [group, dec] = SEP[l || active] || SEP.en;
  const neg = x < 0;
  const s = Math.abs(x).toFixed(decimals);
  const [ip, fp] = s.split('.');
  const g = ip.replace(/\B(?=(\d{3})+(?!\d))/g, '\x00');
  return (neg ? '-' : '') + g.replaceAll('\x00', group) + (fp ? dec + fp : '');
}

export const KM_TO_MILES = 0.621371192237334;
export function formatDistance(km, unit = 'km', l, decimals = 1) {
  const v = unit === 'mi' ? km * KM_TO_MILES : km;
  return `${formatNumber(v, decimals, l)}\u00a0${tr(unit === 'mi' ? 'unit.mi' : 'unit.km', l || active)}`;
}
