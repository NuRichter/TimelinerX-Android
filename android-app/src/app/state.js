// Global app state (Preact signals).
import { signal, computed } from '@preact/signals';
import { defaultProject } from './project.js';

export const route = signal({ name: 'home' });      // home | studio | library | settings | about
export const sheet = signal(null);                  // modal sheet: {name, ...}
export const toasts = signal([]);
export const settings = signal({
  language: 'en', unit: 'km', cartoKey: '', xyzTemplate: '', xyzAttribution: '', reducedMotion: false, onboarded: false,
});
export const project = signal(defaultProject());
export const timeline = signal(null);              // {name, summary, diagnostics} | null
export const importState = signal(null);           // {name, progress, error?}
export const journeyInfo = signal(null);           // {stats, legs, tripCount, totalKm} for the current period
export const journeyError = signal(null);
export const estimate = signal(null);              // {comfortable_s, brisk_s}
export const renderJob = signal(null);             // render progress / result
export const library = signal([]);
export const device = signal({ caps: null, info: null });
export const langTick = signal(0);                  // bumps when the UI language changes

export const hasTimeline = computed(() => !!timeline.value);

// Optional CARTO key baked in at build time (VITE_CARTO_KEY). Anyone with the APK can extract it,
// so public builds should leave it empty and let people enter their own key in Settings.
export const BUILD_CARTO_KEY = (import.meta.env?.VITE_CARTO_KEY || '').trim();
export const effectiveSettings = computed(() => ({ ...settings.value, cartoKey: settings.value.cartoKey || BUILD_CARTO_KEY }));

let toastId = 0;
export function toast(text, kind = 'info', ms = 3200) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => { toasts.value = toasts.value.filter((t) => t.id !== id); }, ms);
}

export function go(name, extra = {}) { route.value = { name, ...extra }; window.scrollTo?.(0, 0); }

export function updateProject(fn) {
  const p = structuredClone(project.value);
  fn(p);
  project.value = p;
}
