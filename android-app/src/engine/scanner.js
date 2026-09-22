// Incremental JSON element scanner for large Timeline exports (port of timeline/streaming.py idea).
// Timeline exports are one big JSON document whose bulk sits in a few top-level arrays
// (semanticSegments, rawSignals, legacy locations / timelineObjects, or a bare root array on iOS).
// The scanner walks decoded text chunk by chunk, jumps between structural characters, and hands
// each element of those arrays to JSON.parse on its own, so memory stays bounded by the largest
// single element instead of the whole file. Truncated files keep every complete element.
import { MALFORMED } from './extractor.js';

export const KNOWN_CONTAINERS = ['semanticSegments', 'rawSignals', 'locations', 'timelineObjects'];
const STRUCT = /["{}[\]]/g;

export class ImportError extends Error {
  constructor(code, message, hint = '') { super(message); this.code = code; this.hint = hint; }
}

function strEnd(s, from) {
  // index of the closing quote of a string whose content starts at or before `from`
  let j = from;
  for (;;) {
    j = s.indexOf('"', j);
    if (j < 0) return -1;
    let k = j - 1, bs = 0;
    while (k >= 0 && s.charCodeAt(k) === 92) { bs++; k--; }
    if ((bs & 1) === 0) return j;
    j++;
  }
}

const WS = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 0xfeff;

export class ElementScanner {
  constructor(onElement, { knownOnly = true } = {}) {
    this.onElement = onElement;          // (container, value | MALFORMED)
    this.knownOnly = knownOnly;
    this.buf = '';
    this.pos = 0;
    this.state = 'start';                // start | key | colon | value | arr | done
    this.rootKind = null;
    this.container = null;
    this.key = null;
    this.tok = null;                     // in-progress value scan {start, i, depth, inStr, kind, emit}
    this.containersSeen = [];
    this.nonArrayKnown = [];
    this.elements = 0;
  }

  push(text) {
    if (this.state === 'done') return;
    this.buf += text;
    this._run(false);
    this._compact();
  }

  end() {
    if (this.state !== 'done') this._run(true);
    const truncated = this.state !== 'done' && this.state !== 'start' ? true : false;
    if (this.state === 'start') throw new ImportError('not_json', 'The file is empty or is not JSON.');
    return { truncated, rootKind: this.rootKind };
  }

  _compact() {
    const keep = this.tok ? this.tok.start : this.pos;
    if (keep > 65536 || keep === this.buf.length) {
      this.buf = this.buf.slice(keep);
      this.pos -= keep;
      if (this.tok) { this.tok.i -= keep; this.tok.start -= keep; }
    }
  }

  _skipWs(extra = -1) {
    const s = this.buf;
    let i = this.pos;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (WS(c) || c === extra) i++; else break;
    }
    this.pos = i;
    return i < s.length ? s.charCodeAt(i) : -1;
  }

  _begin(emit) {
    const c = this.buf.charCodeAt(this.pos);
    const kind = c === 123 || c === 91 ? 'nest' : c === 34 ? 'str' : 'prim';
    this.tok = { start: this.pos, i: kind === 'str' ? this.pos + 1 : this.pos, depth: 0, inStr: false, kind, emit };
  }

  // Continue the in-progress value scan. Returns end index (exclusive) or -1 when more text is needed.
  _scan(final) {
    const t = this.tok, s = this.buf, n = s.length;
    if (t.kind === 'str') {
      const j = strEnd(s, t.i);
      if (j < 0) { t.i = n; return -1; }
      return j + 1;
    }
    if (t.kind === 'prim') {
      let i = t.i;
      while (i < n) {
        const c = s.charCodeAt(i);
        if (c === 44 || c === 93 || c === 125 || WS(c)) return i;
        i++;
      }
      t.i = n;
      return final ? n : -1;
    }
    let i = t.i;
    while (i < n) {
      if (t.inStr) {
        const j = strEnd(s, i);
        if (j < 0) { t.i = n; return -1; }
        t.inStr = false;
        i = j + 1;
        continue;
      }
      STRUCT.lastIndex = i;
      const m = STRUCT.exec(s);
      if (!m) { t.i = n; return -1; }
      i = m.index;
      const c = s.charCodeAt(i);
      if (c === 34) { t.inStr = true; i++; continue; }
      if (c === 123 || c === 91) t.depth++;
      else if (--t.depth === 0) return i + 1;
      i++;
    }
    t.i = n;
    return -1;
  }

  _run(final) {
    for (;;) {
      if (this.tok) {
        const end = this._scan(final);
        if (end < 0) return;
        const tok = this.tok;
        this.tok = null;
        this.pos = end;
        if (tok.emit === 'element') {
          let v;
          try { v = JSON.parse(this.buf.slice(tok.start, end)); } catch { v = MALFORMED; }
          this.elements++;
          this.onElement(this.container, v);
        } else if (tok.emit === 'key') {
          try { this.key = JSON.parse(this.buf.slice(tok.start, end)); } catch { this.key = ''; }
          this.state = 'colon';
        } else if (tok.emit === 'skip') {
          if (KNOWN_CONTAINERS.includes(this.key)) this.nonArrayKnown.push(this.key);
          this.state = 'key';
        }
        continue;
      }
      const c = this._skipWs(this.state === 'arr' || this.state === 'key' ? 44 : -1);
      if (c < 0) return;
      switch (this.state) {
        case 'start':
          if (c === 123) { this.rootKind = 'object'; this.state = 'key'; this.pos++; }
          else if (c === 91) {
            this.rootKind = 'array'; this.container = '$root'; this.containersSeen.push('$root');
            this.state = 'arr'; this.pos++;
          } else {
            throw new ImportError('not_json', "This file is not JSON (it does not start with '{' or '[').",
              'Export Timeline from Google Maps or your phone settings as JSON, or pick a Takeout .zip.');
          }
          break;
        case 'key':
          if (c === 125) { this.state = 'done'; this.pos++; return; }
          if (c === 34) { this._begin('key'); break; }
          throw new ImportError('bad_json', 'The JSON structure is damaged near the top level.');
        case 'colon':
          if (c !== 58) throw new ImportError('bad_json', 'The JSON structure is damaged near the top level.');
          this.pos++;
          this.state = 'value';
          break;
        case 'value':
          if (c === 91 && KNOWN_CONTAINERS.includes(this.key)) {
            this.container = this.key;
            if (!this.containersSeen.includes(this.key)) this.containersSeen.push(this.key);
            this.state = 'arr';
            this.pos++;
          } else {
            this._begin('skip');
          }
          break;
        case 'arr':
          if (c === 93) {
            this.pos++;
            if (this.rootKind === 'array') { this.state = 'done'; return; }
            this.state = 'key';
            this.container = null;
            break;
          }
          this._begin('element');
          break;
        default:
          return;
      }
    }
  }
}
