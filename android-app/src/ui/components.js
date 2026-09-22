// Reusable UI controls.
import { html } from 'htm/preact';
import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './icons.js';
import { t } from '../i18n/index.js';

export const Card = ({ title, desc, children, cls = '' }) => html`
  <section class=${'card ' + cls}>
    ${title && html`<h2>${title}</h2>`}
    ${desc && html`<p class="desc">${desc}</p>`}
    ${children}
  </section>`;

export const Seg = ({ value, options, onChange }) => html`
  <div class="seg" role="tablist">
    ${options.map(([v, label]) => html`<button type="button" class=${v === value ? 'on' : ''} role="tab" aria-selected=${v === value} onClick=${() => onChange(v)}>${label}</button>`)}
  </div>`;

export const Chips = ({ value, options, onChange }) => html`
  <div class="chips">
    ${options.map(([v, label, disabled]) => html`<button type="button" disabled=${disabled} class=${'chip' + (v === value ? ' on' : '')} onClick=${() => onChange(v)}>${label}</button>`)}
  </div>`;

export const Options = ({ value, options, onChange, two = false }) => html`
  <div class=${'options' + (two ? ' two' : '')}>
    ${options.map(([v, title, desc]) => html`
      <button type="button" class=${'opt' + (v === value ? ' on' : '')} onClick=${() => onChange(v)} aria-pressed=${v === value}>
        <div class="t"><span class="dot"></span>${title}</div>
        ${desc && html`<div class="d">${desc}</div>`}
      </button>`)}
  </div>`;

export const Toggle = ({ label, desc, value, onChange }) => html`
  <div class="toggle" role="switch" aria-checked=${!!value} tabindex="0" onClick=${() => onChange(!value)} onKeyDown=${(e) => (e.key === ' ' || e.key === 'Enter') && onChange(!value)}>
    <div class="txt"><div>${label}</div>${desc && html`<div class="d">${desc}</div>`}</div>
    <div class=${'switch' + (value ? ' on' : '')}></div>
  </div>`;

export function Slider({ label, value, min, max, step = 1, onChange, format = (v) => v }) {
  const pct = ((value - min) / (max - min)) * 100;
  return html`
    <div class="slider">
      <div class="top"><span class="muted">${label}</span><b>${format(value)}</b></div>
      <input type="range" min=${min} max=${max} step=${step} value=${value} style=${`--p:${pct}%`}
        onInput=${(e) => onChange(Number(e.currentTarget.value))} aria-label=${label} />
    </div>`;
}

export const Field = ({ label, children, hint }) => html`
  <div class="field"><label>${label}</label>${children}${hint && html`<div class="tiny">${hint}</div>`}</div>`;

export const Stat = ({ k, v }) => html`<div class="stat"><div class="v">${v}</div><div class="k">${k}</div></div>`;

export function Sheet({ onClose, children }) {
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return html`
    <div class="scrim" onClick=${onClose}></div>
    <div class="sheet" role="dialog" aria-modal="true">
      <div class="grab"></div>
      ${children}
    </div>`;
}

export function FilePick({ accept, onFile, children, cls = 'btn', id }) {
  const ref = useRef();
  return html`
    <button type="button" class=${cls} id=${id} onClick=${() => ref.current.click()}>${children}</button>
    <input ref=${ref} type="file" accept=${accept} style="display:none"
      onChange=${(e) => { const f = e.currentTarget.files?.[0]; e.currentTarget.value = ''; if (f) onFile(f); }} />`;
}

export const Back = ({ onClick }) => html`<button type="button" class="iconbtn plain" aria-label=${t('app.common.back')} onClick=${onClick}>${Icon.back({ style: document.documentElement.dir === 'rtl' ? 'transform:scaleX(-1)' : '' })}</button>`;

export function Ring({ value }) {
  const r = 64, c = 2 * Math.PI * r;
  return html`
    <div class="ring">
      <svg viewBox="0 0 150 150">
        <defs><linearGradient id="rg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#33ddff"/><stop offset="1" stop-color="#1463e6"/></linearGradient></defs>
        <circle cx="75" cy="75" r=${r} stroke="rgba(255,255,255,.08)" stroke-width="10" fill="none"/>
        <circle cx="75" cy="75" r=${r} stroke="url(#rg)" stroke-width="10" fill="none" stroke-linecap="round"
          stroke-dasharray=${c} stroke-dashoffset=${c * (1 - Math.max(0, Math.min(1, value)))} style="transition:stroke-dashoffset .3s ease"/>
      </svg>
      <div class="pct">${Math.round(value * 100)}%</div>
    </div>`;
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}
export function fmtBytes(b) {
  if (!b) return '0 MB';
  if (b > 1e9) return (b / 1e9).toFixed(2) + ' GB';
  return (b / 1e6).toFixed(b > 1e8 ? 0 : 1) + ' MB';
}
