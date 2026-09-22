// App shell: screens, bottom navigation, sheets, toasts, Android back button.
import { html } from 'htm/preact';
import { useEffect } from 'preact/hooks';
import { Icon } from './icons.js';
import { Sheet } from './components.js';
import { Home, ImportOverlay, AnalysisSheet, TutorialSheet } from './home.js';
import { Studio } from './studio.js';
import { RenderScreen, Library, Settings, About, VideoSheet, AskSheet } from './screens.js';
import { route, sheet, toasts, renderJob, importState, go, langTick, settings } from '../app/state.js';
import { onBackButton, exitApp } from '../platform/native.js';
import { t } from '../i18n/index.js';

const NAV = [['home', 'home', 'app.nav.home'], ['studio', 'studio', 'app.nav.studio'], ['library', 'library', 'app.nav.library'], ['settings', 'settings', 'app.nav.settings']];

function Nav() {
  const r = route.value.name;
  return html`<nav class="nav"><div class="inner">
    ${NAV.map(([k, ic, label]) => html`<button class=${r === k ? 'on' : ''} aria-current=${r === k ? 'page' : null} onClick=${() => go(k)}>${Icon[ic]()}<span>${t(label)}</span></button>`)}
  </div></nav>`;
}

function Sheets() {
  const s = sheet.value;
  if (!s) return null;
  const close = () => { if (s.name === 'ask') s.resolve(null); else sheet.value = null; };
  let body = null;
  if (s.name === 'analysis') body = html`<${AnalysisSheet} />`;
  else if (s.name === 'tutorial') body = html`<${TutorialSheet} />`;
  else if (s.name === 'video') body = html`<${VideoSheet} item=${s.item} />`;
  else if (s.name === 'ask') body = html`<${AskSheet} ...${s} />`;
  return html`<${Sheet} onClose=${close}>${body}<//>`;
}

function Toasts() {
  return html`<div class="toasts">${toasts.value.map((x) => html`<div class=${'toast ' + x.kind}>${x.text}</div>`)}</div>`;
}

export function App() {
  langTick.value; // re-render everything when the language changes
  useEffect(() => {
    document.body.classList.toggle('reduced', !!settings.value.reducedMotion);
    onBackButton(() => {
      if (sheet.value) { if (sheet.value.name === 'ask') sheet.value.resolve(null); else sheet.value = null; return; }
      if (renderJob.value && !['done', 'error', 'cancelled'].includes(renderJob.value.stage)) return;
      if (renderJob.value) { renderJob.value = null; go('studio'); return; }
      if (importState.value?.error) { importState.value = null; return; }
      if (route.value.name === 'about') { go('settings'); return; }
      if (route.value.name !== 'home') { go('home'); return; }
      exitApp();
    });
  }, []);
  const r = route.value.name;
  const Screen = { home: Home, studio: Studio, library: Library, settings: Settings, about: About }[r] || Home;
  const rendering = r === 'render' && renderJob.value;
  return html`
    <div class="bgfx"></div>
    <div class="app">
      ${rendering ? html`<${RenderScreen} />` : html`<${Screen} /><${Nav} />`}
      <${ImportOverlay} />
      <${Sheets} />
      <${Toasts} />
    </div>`;
}
