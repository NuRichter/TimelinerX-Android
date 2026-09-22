// TimelinerX for Android: entry point.
import { render } from 'preact';
import { html } from 'htm/preact';
import './styles/app.css';
import { App } from './ui/app.js';
import { init } from './app/actions.js';
import { setupChrome } from './platform/native.js';

async function boot() {
  try { await init(); } catch (e) { console.error('init failed', e); }
  render(html`<${App} />`, document.getElementById('root'));
  setupChrome();
  document.getElementById('boot')?.remove();
}
boot();
