// Fast drop-in replacement for makefun-site 1.0.0.
//
// run(input) returns exactly the output tree makefun-site's build returns for
// the same input, byte for byte, but computed with single-pass parsers, cached
// slugs/dates, chunk-wise inline rendering and an array-based template
// renderer instead of a generic plugin pipeline. No dependencies, Node 22
// stdlib only. Nothing is kept between calls: every cache below is rebuilt
// per case.

// ---------------------------------------------------------------- utilities

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Object.hasOwn(o, k);

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_ALL = /[&<>"']/g;

/** `text` with & < > " and ' escaped; the common no-specials case is free. */
function esc(text) {
  if (!ESC_TEST.test(text)) return text;
  return text.replace(ESC_ALL, (c) => ESC_MAP[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// Per-case caches (reset at the top of every run() call).
let slugCache = new Map();
let dateCache = new Map();

/** The slug of `text`, exactly as the reference defines it, memoised per case. */
function slugify(text) {
  let hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  const out = slugifyRaw(text);
  slugCache.set(text, out);
  return out;
}

function slugifyRaw(text) {
  // Fast path: pure ASCII is unchanged by NFKD and holds no combining marks.
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  let out = '';
  let gap = false;
  if (ascii) {
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      let keep = -1;
      if (c >= 65 && c <= 90) keep = c + 32;
      else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
      if (keep === -1) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += String.fromCharCode(keep);
    }
  } else {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    for (const ch of plain) {
      let keep = null;
      if (ch.length === 1) {
        const c = ch.charCodeAt(0);
        if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
        else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = ch;
      }
      if (keep === null) { gap = out.length > 0; continue; }
      if (gap) { out += '-'; gap = false; }
      out += keep;
    }
  }
  if (out.length > 64) {
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
  }
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, memoised per case. */
function longDate(date) {
  let hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  dateCache.set(date, out);
  return out;
}

function isWsCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f ||
    c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The number of whitespace-separated words in `text` (runs of non-whitespace). */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // The whitespace that actually occurs is space and the C0 whitespace;
    // the full \s set is only consulted for non-ASCII code units.
    const ws = c === 32 || (c >= 9 && c <= 13) || (c > 127 && isWsCode(c));
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

// ------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) { // '"'
    const len = raw.length;
    if (len < 2 || raw.charCodeAt(len - 1) !== 34) return { error: 'a quoted string is not closed' };
    // Fast path: no backslash and no inner quote.
    if (raw.indexOf('\\', 1) === -1 && raw.indexOf('"', 1) === len - 1) return { value: raw.slice(1, -1) };
    let out = '';
    for (let i = 1; i < len - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === len - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' }; // '['
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        const y = Number(raw.slice(0, 4));
        const mo = Number(raw.slice(5, 7));
        const d = Number(raw.slice(8, 10));
        ok = y >= 1970 && y <= 2099 && mo >= 1 && mo <= 12 && d >= 1 && d <= daysIn(y, mo);
      }
      return ok ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      const tags = new Array(parts.length);
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) {
          return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
        tags[i] = t;
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        ok = (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45;
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      let prevDash = true; // also rejects a leading '-'
      for (let i = 0; i < raw.length && ok; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) ok = false;
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else ok = false;
      }
      if (prevDash && raw.length > 0) ok = false; // trailing '-'
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimRightSpaceTab(s) {
  let end = s.length;
  while (end > 0) {
    const c = s.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return end === s.length ? s : s.slice(0, end);
}

/** Parse one front-matter line into `data`; returns an error string or null. */
function fmLine(line, lineNo, data) {
  if (isBlankLine(line) || line.charCodeAt(0) === 35) return null; // blank or '#'
  const len = line.length;
  let j = 0;
  while (j < len) {
    const c = line.charCodeAt(j);
    if ((c >= 97 && c <= 122) || c === 95) j++;
    else break;
  }
  if (j === 0 || line[j] !== ':') return `line ${lineNo} is not "key: value"`;
  const key = line.slice(0, j);
  let raw;
  if (j + 1 === len) raw = '';
  else if (line[j + 1] === ' ') raw = line.slice(j + 2);
  else return `line ${lineNo} is not "key: value"`;
  raw = trimRightSpaceTab(raw);
  if (!FM_KEYS.has(key)) return `unknown key "${key}"`;
  if (hasOwn(data, key)) return `key "${key}" is given twice`;
  if (raw === '') return `key "${key}" has no value`;
  const v = valueOf(key, raw);
  if ('error' in v) return v.error;
  data[key] = v.value;
  return null;
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstLine = firstNl === -1 ? text : text.slice(0, firstNl);
  if (firstLine !== '---') return { error: 'no front matter' };
  // Find the closing line first (the reference checks closure before lines).
  let closeStart = -1;
  let bodyStart = -1;
  let scan = firstNl === -1 ? text.length : firstNl + 1;
  while (scan <= text.length) {
    const nl = text.indexOf('\n', scan);
    const end = nl === -1 ? text.length : nl;
    if (end - scan === 3 && text.charCodeAt(scan) === 45 && text.charCodeAt(scan + 1) === 45 && text.charCodeAt(scan + 2) === 45) {
      closeStart = scan;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    scan = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineNo = 1;
  let p = firstNl + 1;
  while (p < closeStart) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 || nl > closeStart ? closeStart : nl;
    lineNo++;
    const err = fmLine(text.slice(p, end), lineNo, data);
    if (err !== null) return { error: err };
    p = end + 1;
  }
  if (!hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** First index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** First single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

const WS_ONE = /\s/;

/** Whether s[a..b) holds none of the inline specials \ ` * [ (so it renders flat). */
function rangeIsPlain(s, a, b) {
  for (let i = a; i < b; i++) {
    const c = s.charCodeAt(i);
    if (c === 92 || c === 96 || c === 42 || c === 91) return false;
  }
  return true;
}

/** Render `s` inline, appending pieces to `out`; `link(target)` resolves hrefs. */
function renderInline(s, link, out) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    // Advance over a plain chunk up to the next parse-significant character.
    let nxt = n;
    const a = s.indexOf('\\', i); if (a !== -1 && a < nxt) nxt = a;
    const b = s.indexOf('`', i); if (b !== -1 && b < nxt) nxt = b;
    const c = s.indexOf('*', i); if (c !== -1 && c < nxt) nxt = c;
    const d = s.indexOf('[', i); if (d !== -1 && d < nxt) nxt = d;
    if (nxt > i) {
      out.push(esc(s.slice(i, nxt)));
      i = nxt;
      continue;
    }
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        const e = s[i + 1];
        out.push(e === '>' ? '&gt;' : e);
        i += 2;
      } else {
        out.push('\\');
        i++;
      }
      continue;
    }
    if (ch === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out.push('<code>', esc(s.slice(i + 1, j)), '</code>');
        i = j + 1;
      } else {
        out.push('`');
        i++;
      }
      continue;
    }
    if (ch === '*') {
      if (s[i + 1] === '*') {
        // Fast path: the first `**` after a plain run is the closer.
        const fj = s.indexOf('**', i + 2);
        if (fj > i + 2 && rangeIsPlain(s, i + 2, fj)) {
          out.push('<strong>', esc(s.slice(i + 2, fj)), '</strong>');
          i = fj + 2;
          continue;
        }
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          out.push('<strong>');
          renderInline(s.slice(i + 2, j), link, out);
          out.push('</strong>');
          i = j + 2;
        } else {
          out.push('**');
          i += 2;
        }
      } else {
        // Fast path: the next `*` is a single, unescaped closer over plain text.
        const fj = s.indexOf('*', i + 1);
        if (fj > i + 1 && s[fj + 1] !== '*' && rangeIsPlain(s, i + 1, fj)) {
          out.push('<em>', esc(s.slice(i + 1, fj)), '</em>');
          i = fj + 1;
          continue;
        }
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out.push('<em>');
          renderInline(s.slice(i + 1, j), link, out);
          out.push('</em>');
          i = j + 1;
        } else {
          out.push('*');
          i++;
        }
      }
      continue;
    }
    // ch === '['
    const k = findUnescaped(s, ']', i + 1);
    const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = m === -1 ? '' : s.slice(k + 2, m);
    if (target !== '' && !WS_ONE.test(target)) {
      out.push('<a href="', esc(link(target)), '">');
      if (rangeIsPlain(s, i + 1, k)) out.push(esc(s.slice(i + 1, k)));
      else renderInline(s.slice(i + 1, k), link, out);
      out.push('</a>');
      i = m + 1;
    } else {
      out.push('[');
      i++;
    }
  }
}

function inlineToString(s, link) {
  const out = [];
  renderInline(s, link, out);
  return out.join('');
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** Fence-open info: the language string (maybe '') or null when not a fence. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  let k = j;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return line.slice(3, j);
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, text }, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let h = 0;
  while (line.charCodeAt(h) === 35) h++;
  if (h > 6) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  let p = h;
  while (p < line.length) {
    const cc = line.charCodeAt(p);
    if (cc !== 32 && cc !== 9) break;
    p++;
  }
  const text = trimRightSpaceTab(line.slice(p));
  return text === '' ? null : { depth: h, text };
}

function isHR(line) {
  const head = line.charCodeAt(0);
  if (head !== 45 && head !== 42) return false;
  if (line.charCodeAt(1) !== head || line.charCodeAt(2) !== head) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let d = 0;
  while (d < line.length) {
    const c = line.charCodeAt(d);
    if (c < 48 || c > 57) break;
    d++;
  }
  if (d >= 1 && d <= 9 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) {
    return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
  }
  return null;
}

function isContinued(line) {
  let sp = 0;
  while (line.charCodeAt(sp) === 32) sp++;
  return sp >= 2 && sp < line.length && !WS_ONE.test(line[sp]);
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

/** Render a body: { html, toc, excerpt } in one pass over its lines. */
function renderMarkdown(src, link) {
  const lines = src.split('\n');
  const n = lines.length;
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      i++;
      out.push(fence === '' ? '<pre><code>' : `<pre><code class="language-${esc(fence)}">`);
      while (i < n && !isFenceClose(lines[i])) {
        out.push(esc(lines[i]), '\n');
        i++;
      }
      i++;
      out.push('</code></pre>\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inlineToString(heading.text, link);
      out.push(`<h${heading.depth} id="${id}">`, html, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHR(line)) {
      out.push('<hr>\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) { // '>'
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        const stripped = l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1);
        const t = trimLine(stripped);
        if (t !== '') kept.push(t);
        i++;
      }
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>\n');
      else {
        out.push('<blockquote>\n<p>');
        renderInline(kept.join('\n'), link, out);
        out.push('</p>\n</blockquote>\n');
      }
      continue;
    }
    const bullet = bulletOf(line);
    const ordered = bullet === null ? orderedOf(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < n) {
        const l = lines[i];
        const text = isOrdered ? (orderedOf(l)?.text ?? null) : bulletOf(l);
        if (text !== null && text !== undefined) {
          items.push([trimLine(text)]);
          i++;
        } else if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">\n` : `<${tag}>\n`);
      for (const item of items) {
        out.push('<li>');
        renderInline(item.join('\n'), link, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) {
      parts.push(trimLine(lines[i]));
      i++;
    }
    if (excerpt === null) {
      const html = inlineToString(parts.join('\n'), link);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      renderInline(parts.join('\n'), link, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// --------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function spaceTabOnly(src, a, b) {
  for (let i = a; i < b; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function tokenizeTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = spaceTabOnly(src, lineStart, open) && spaceTabOnly(src, end, lineEnd);
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** lookup for the common one- and two-segment paths (page.title, loop.index…). */
function lookupShort(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[path[0]];
  if (path.length === 1) return v;
  if (v === null || typeof v !== 'object' || !hasOwn(v, path[1])) return undefined;
  return v[path[1]];
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * The free root names a template reads (its own paths' first segments, plus
 * its includes', minus names bound by its own loops), or null when its
 * include graph is cyclic and its output must never be cached. A template's
 * rendered output depends only on the values these roots resolve to (and the
 * include depth), which is what makes the include cache in renderNodes
 * sound: identical resolved roots at an identical depth render identically.
 */
function freeRootsOf(name, templates) {
  const roots = new Set();
  const visiting = new Set([name]);
  let cyclic = false;
  const walk = (nodes, bound) => {
    for (const node of nodes) {
      if (cyclic) return;
      switch (node.kind) {
        case 'var':
        case 'raw':
        case 'if': {
          if (!bound.has(node.path[0])) roots.add(node.path[0]);
          if (node.kind === 'if') {
            walk(node.then, bound);
            if (node.else !== null) walk(node.else, bound);
          }
          break;
        }
        case 'for': {
          if (!bound.has(node.path[0])) roots.add(node.path[0]);
          const inner = new Set(bound);
          inner.add(node.name);
          inner.add('loop');
          walk(node.body, inner);
          break;
        }
        case 'include': {
          const t = templates.get(node.name);
          if (t !== undefined) {
            if (visiting.has(node.name)) { cyclic = true; return; }
            visiting.add(node.name);
            walk(t, bound);
            visiting.delete(node.name);
          }
          break;
        }
      }
    }
  };
  walk(templates.get(name), new Set());
  return cyclic ? null : [...roots];
}

/** The value a root name resolves to in the scope chain (first segment only). */
function lookupRoot(scope, name) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, name)) s = s.parent;
  return s === null ? undefined : s.vars[name];
}

/** A cache key from the values `roots` resolve to in `scope`, at `depth`. */
function includeKey(ctx, scope, roots, depth) {
  let key = depth + '|';
  for (const name of roots) {
    const v = lookupRoot(scope, name);
    if (v === undefined) key += 'u,';
    else if (v === null) key += 'n,';
    else if (typeof v === 'object') {
      let id = ctx.ids.get(v);
      if (id === undefined) {
        id = ctx.nextId++;
        ctx.ids.set(v, id);
      }
      key += `o${id},`;
    } else if (typeof v === 'string') key += `s${v.length}:${v},`;
    else key += `p${v},`;
  }
  return key;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const node = nodes[idx];
    switch (node.kind) {
      case 'text':
        out.push(node.text);
        break;
      case 'var': {
        const v = node.path.length <= 2 ? lookupShort(scope, node.path) : lookup(scope, node.path);
        out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        break;
      }
      case 'raw': {
        const v = node.path.length <= 2 ? lookupShort(scope, node.path) : lookup(scope, node.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(node.path.length <= 2 ? lookupShort(scope, node.path) : lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = node.path.length <= 2 ? lookupShort(scope, node.path) : lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[node.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(node.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const cache = ctx.includeCache.get(node.name);
        if (cache === undefined) {
          renderNodes(t, scope, ctx, depth + 1, out);
          break;
        }
        const key = includeKey(ctx, scope, cache.roots, depth);
        const hit = cache.map.get(key);
        if (hit !== undefined) {
          out.push(hit);
          break;
        }
        const inner = [];
        renderNodes(t, scope, ctx, depth + 1, inner);
        const text = inner.join('');
        cache.map.set(key, text);
        out.push(text);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------- build

const RESERVED = ['posts', 'tags', 'page'];
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function isScheme(target) {
  const c = target.charCodeAt(0);
  if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122))) return false;
  let i = 1;
  while (i < target.length) {
    const cc = target.charCodeAt(i);
    if ((cc >= 65 && cc <= 90) || (cc >= 97 && cc <= 122) || (cc >= 48 && cc <= 57) || cc === 43 || cc === 45 || cc === 46) i++;
    else break;
  }
  return target[i] === ':';
}

const linkOf = (s) => (s === null ? null : {
  title: s.data.title,
  url: s.url,
  date: s.data.date ?? '',
  date_long: s.data.date === undefined ? '' : longDate(s.data.date),
});

function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** makefun-site 1.0.0's answer for one case's input, computed faster. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();
  const report = [];
  const broken = new Set();
  const output = {};

  // Templates, parsed in code-unit order of name; failures are reported.
  const templates = new Map();
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources in code-unit path order; .md is a source, anything else static.
  const files = input.files.slice().sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    } else {
      statics.push({ path: f.path, content: f.content });
    }
  }

  // Front matter and the refusal checks, in the reference's order.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: slug unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, links resolved against pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const link = (target) => {
      if (isScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dir, rel);
      if (path !== null) {
        const page = bySource.get(path);
        if (page !== undefined) return `${page.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${srcPath} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const list = s.data.tags ?? [];
    const out = [];
    for (const name of list) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: pages, index pages, tag pages, then static files.
  for (const s of kept) s.card = cardOf(s);
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.card);
  const includeCache = new Map();
  for (const name of templates.keys()) {
    const roots = freeRootsOf(name, templates);
    if (roots !== null) includeCache.set(name, { roots, map: new Map() });
  }
  const ctx = { templates, includeCache, ids: new WeakMap(), nextId: 1 };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) {
    const page = {
      ...s.card,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
    output[`${s.outDir}/index.html`] = render(s.layout, { page });
  }
  const per = input.site.per_page;
  const pageCount = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pageCount; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.card),
      pager: {
        number: k,
        total: pageCount,
        url: indexUrl(k),
        newer_url: k === 1 ? '' : indexUrl(k - 1),
        older_url: k === pageCount ? '' : indexUrl(k + 1),
      },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.card) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every reported line and broken link, sorted, then counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageTotal = kept.reduce((acc, s) => acc + (s.post ? 0 : 1), 0);
  lines.push(`built ${pageTotal} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
