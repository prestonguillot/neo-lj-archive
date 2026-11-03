import { parseFragment } from 'parse5';

/**
 * Search, in the static archive (DESIGN.md §7.4).
 *
 * The build writes every entry's and comment's visible text into search/data.js,
 * and search/search.js scans it in the browser. No index, no library, no server:
 * the whole journal is ~2 MB of text, which a browser scans in milliseconds.
 *
 * FILE:// SHAPES ALL OF THIS — measured, not assumed (§7.4). Chromium and WebKit
 * refuse fetch(), XHR, ES modules, and file-backed Workers from a file:// page;
 * Firefox allows them. A classic <script src> works in all three. So the data is a
 * script that assigns a global, and the engine is a classic script. Never
 * type="module", never fetch().
 */

/** One searchable thing. Short keys: this ships once per record, ~8,000 times. */
export interface SearchRecord {
  /** 'e' entry, 'c' comment. */
  readonly k: 'e' | 'c';
  /** Link target, relative to the site root (e.g. entries/266.html#c5). */
  readonly u: string;
  /** YYYY-MM-DD. */
  readonly d: string;
  /** The entry's display title — for a comment, the entry it was left on. */
  readonly t: string;
  /** Comment author; absent for entries, empty for anonymous. */
  readonly w?: string;
  /** Comment subject, when it had one. */
  readonly s?: string;
  /** Entry metadata the page shows: mood, music, location, tags. */
  readonly m?: string;
  /** The body as the reader sees it, whitespace collapsed. */
  readonly x: string;
}

/**
 * Elements that end a word. Without this, "first line<br>second" indexes as
 * "linesecond" and neither word can be found.
 */
const BREAKS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'figcaption',
  'figure',
  'footer',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'table',
  'td',
  'th',
  'tr',
  'ul',
]);

interface Node {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
}

/**
 * The text a reader sees in RENDERED body HTML — the output of renderBody, never
 * the raw LJ body. Indexing the raw body would match `lj user="alice"` attribute
 * text and miss every transform the renderer makes (cut labels, lost-image
 * markers), so a hit could point at text that isn't on the page.
 */
export function textOf(html: string, skipClasses?: ReadonlySet<string>): string {
  const out: string[] = [];
  const walk = (n: Node): void => {
    if (n.nodeName === '#text') {
      out.push(n.value ?? '');
      return;
    }
    if (n.nodeName === 'script' || n.nodeName === 'style') return;
    if (skipClasses !== undefined) {
      const cls = n.attrs?.find((a) => a.name === 'class')?.value.split(/\s+/) ?? [];
      if (cls.some((c) => skipClasses.has(c))) return;
    }
    const br = BREAKS.has(n.nodeName);
    if (br) out.push(' ');
    for (const c of n.childNodes ?? []) walk(c);
    if (n.content) walk(n.content);
    if (br) out.push(' ');
  };
  walk(parseFragment(html) as unknown as Node);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/**
 * search/data.js. A script assigning a global, because that is the only way to
 * hand data to a file:// page that every browser engine allows (see top).
 */
export function searchDataJs(records: readonly SearchRecord[]): string {
  return `window.NEO_SEARCH = ${JSON.stringify(records)};\n`;
}

/**
 * search/search.js — the engine and the page wiring, shipped verbatim.
 *
 * Unit tests evaluate THIS string (search.test.ts), so what's tested is the exact
 * bytes the browser runs, not a TypeScript twin that could drift from it.
 *
 * Results are built with DOM nodes and textContent, never innerHTML: the indexed
 * text is the journal's own words, and a 2004 entry that SAYS "<b>" must show
 * "<b>", not bold the snippet — or run a handler someone typed into a comment.
 *
 * String.raw so regex escapes reach the browser intact. No backticks or dollar-
 * brace inside — this is a template literal.
 */
export const SEARCH_JS = String.raw`(function () {
  'use strict';

  // Curly quotes and dashes fold to their keyboard forms: LJ's editor and a
  // decade of phones typed both, and a search for don't must find don’t.
  var FOLD = {
    '‘': "'", '’': "'", '‛': "'", '′': "'",
    '“': '"', '”': '"', '–': '-', '—': '-'
  };
  var FOLD_RE = /[‘’‛′“”–—]/g;
  var MARKS_RE = /[̀-ͯ]/g;

  // Case, accents, and curly quotes don't matter.
  function norm(s) {
    return s.normalize('NFKD').replace(MARKS_RE, '').toLowerCase()
      .replace(FOLD_RE, function (c) { return FOLD[c]; });
  }

  // norm(), one character at a time, remembering where each folded character
  // came from — so a highlight lands on the reader's original text even where
  // folding changed its length (an accent dropped, a ligature split).
  function fold(s) {
    var out = '', map = [];
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      var code = s.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) c = s.slice(i, i + 2);
      var f = norm(c);
      for (var j = 0; j < f.length; j++) { out += f[j]; map.push(i); }
      i += c.length - 1;
    }
    map.push(s.length);
    return { s: out, map: map };
  }

  // Words and "quoted phrases". Every one must appear (AND, not OR).
  function terms(q) {
    var out = [], seen = {}, re = /"([^"]*)"|(\S+)/g, m;
    var nq = norm(q);
    while ((m = re.exec(nq)) !== null) {
      var t = (m[1] !== undefined ? m[1] : m[2]).replace(/\s+/g, ' ').trim();
      if (t !== '' && !seen[t]) { seen[t] = true; out.push(t); }
    }
    return out;
  }

  function count(hay, t) {
    var n = 0, i = hay.indexOf(t);
    while (i !== -1 && n < 10) { n++; i = hay.indexOf(t, i + t.length); }
    return n;
  }

  function prepare(r) {
    if (r._h !== undefined) return;
    // A comment is NOT matched by the title of the entry it sits under: a search
    // for "trip" should find what was said about a trip, not every reply on an
    // entry that happened to be titled that.
    var head = r.k === 'e' ? r.t : (r.s || '');
    r._t = norm(head);
    r._h = norm([head, r.m || '', r.w || '', r.x].join('\n'));
  }

  // scope: 'all' | 'entries' | 'comments'. sort: 'relevance' | 'newest' | 'oldest'.
  function search(records, q, scope, sort) {
    var ts = terms(q);
    if (ts.length === 0) return [];
    var hits = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (scope === 'entries' && r.k !== 'e') continue;
      if (scope === 'comments' && r.k !== 'c') continue;
      prepare(r);
      var score = 0, ok = true;
      for (var j = 0; j < ts.length; j++) {
        var n = count(r._h, ts[j]);
        if (n === 0) { ok = false; break; }
        score += n + (r._t.indexOf(ts[j]) !== -1 ? 10 : 0);
      }
      if (ok) hits.push({ r: r, score: score, i: i });
    }
    var byDate = function (a, b) {
      return a.r.d < b.r.d ? -1 : a.r.d > b.r.d ? 1 : a.i - b.i;
    };
    hits.sort(sort === 'newest' ? function (a, b) { return byDate(b, a); }
      : sort === 'oldest' ? byDate
      : function (a, b) { return b.score - a.score || byDate(a, b); });
    return hits;
  }

  // A window of the body around the first match, as segments to render, with
  // every occurrence of every term inside it marked.
  function snippet(text, ts, width) {
    width = width || 240;
    var f = fold(text), first = -1, k, p;
    for (k = 0; k < ts.length; k++) {
      p = f.s.indexOf(ts[k]);
      if (p !== -1 && (first === -1 || p < first)) first = p;
    }
    var start = 0;
    if (first !== -1) {
      start = Math.max(0, f.map[first] - Math.floor(width / 4));
      if (start > 0) { var sp = text.indexOf(' ', start); if (sp !== -1 && sp < f.map[first]) start = sp + 1; }
    }
    var end = Math.min(text.length, start + width);
    if (end < text.length) { var e2 = text.lastIndexOf(' ', end); if (e2 > start) end = e2; }

    var ranges = [];
    for (k = 0; k < ts.length; k++) {
      p = f.s.indexOf(ts[k]);
      while (p !== -1) {
        var a = f.map[p], b = f.map[p + ts[k].length];
        if (a >= start && b <= end) ranges.push([a, b]);
        p = f.s.indexOf(ts[k], p + ts[k].length);
      }
    }
    ranges.sort(function (x, y) { return x[0] - y[0]; });
    var merged = [];
    for (k = 0; k < ranges.length; k++) {
      var last = merged[merged.length - 1];
      if (last && ranges[k][0] <= last[1]) last[1] = Math.max(last[1], ranges[k][1]);
      else merged.push([ranges[k][0], ranges[k][1]]);
    }
    var segs = [], at = start;
    if (start > 0) segs.push({ text: '…', mark: false });
    for (k = 0; k < merged.length; k++) {
      if (merged[k][0] > at) segs.push({ text: text.slice(at, merged[k][0]), mark: false });
      segs.push({ text: text.slice(merged[k][0], merged[k][1]), mark: true });
      at = merged[k][1];
    }
    if (at < end) segs.push({ text: text.slice(at, end), mark: false });
    if (end < text.length) segs.push({ text: '…', mark: false });
    return segs;
  }

  // ---- by meaning (optional: only when the build shipped bert.js, model.js,
  // vectors.js — DESIGN.md §7.4) ---------------------------------------------
  function decode(b64) {
    var s = atob(b64), u = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }
  // The model and vectors are decoded on the FIRST meaning query, not at page
  // load: ~35 MB of base64 shouldn't stand between the reader and the box.
  function meaningIndex(w) {
    if (!w.NeoBert || !w.NEO_MODEL || !w.NEO_VECTORS) return null;
    var M = w.NEO_MODEL, V = w.NEO_VECTORS, vb = decode(V.b64), n = V.n;
    return {
      model: w.NeoBert.load({ meta: M.meta, bytes: decode(M.b64), vocab: M.vocab }),
      n: n, dim: V.dim,
      owner: new Int32Array(vb.buffer, 0, n),
      scale: new Float32Array(vb.buffer, n * 4, n),
      q: new Int8Array(vb.buffer, n * 8, n * V.dim)
    };
  }
  var MSTOP = { a: 1, an: 1, and: 1, at: 1, the: 1, my: 1, to: 1, of: 1, 'for': 1, 'with': 1, 'in': 1, on: 1, i: 1, me: 1, is: 1, was: 1, be: 1, being: 1, going: 1, getting: 1 };
  // Hybrid: closeness in meaning (best passage), discounted for very short
  // records — a three-word comment shouldn't win on a vague match — plus a small
  // bonus for each query word the text really contains. Measured on a real
  // journal: about twice keyword search's precision at 10, and better than
  // meaning alone for every model tried.
  function meaning(records, q, scope, sort, index, vector) {
    if (norm(q).trim() === '') return [];
    var v = vector || index.model.embed(q), dim = index.dim;
    var best = new Float32Array(records.length).fill(-1);
    for (var c = 0; c < index.n; c++) {
      var s = 0, o = c * dim;
      for (var j = 0; j < dim; j++) s += v[j] * index.q[o + j];
      s *= index.scale[c];
      var w = index.owner[c];
      if (s > best[w]) best[w] = s;
    }
    var qt = norm(q).replace(/[^a-z0-9' ]/g, ' ').split(/\s+/).filter(function (t) { return t && !MSTOP[t]; });
    var hits = [];
    for (var i = 0; i < records.length; i++) {
      var r = records[i];
      if (scope === 'entries' && r.k !== 'e') continue;
      if (scope === 'comments' && r.k !== 'c') continue;
      prepare(r);
      var words = r.x.split(/\s+/).length, cov = 0;
      for (var k = 0; k < qt.length; k++) if (r._h.indexOf(qt[k]) !== -1) cov++;
      hits.push({ r: r, i: i, score: best[i] * Math.min(1, Math.sqrt(words / 25)) + 0.12 * (qt.length ? cov / qt.length : 0) });
    }
    hits.sort(function (a, b) { return b.score - a.score || a.i - b.i; });
    hits = hits.slice(0, 100);
    var byDate = function (a, b) { return a.r.d < b.r.d ? -1 : a.r.d > b.r.d ? 1 : a.i - b.i; };
    if (sort === 'newest') hits.sort(function (a, b) { return byDate(b, a); });
    else if (sort === 'oldest') hits.sort(byDate);
    return hits;
  }

  var api = { norm: norm, fold: fold, terms: terms, search: search, snippet: snippet, meaning: meaning, meaningIndex: meaningIndex };
  if (typeof window !== 'undefined') window.NeoSearch = api;
  if (typeof document === 'undefined') return;

  // --- the page ------------------------------------------------------------
  var PAGE = 50;
  var ROOT = '../';

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function start() {
    var data = window.NEO_SEARCH || [];
    var form = document.getElementById('search');
    var q = document.getElementById('q');
    var sortSel = document.getElementById('sort');
    var status = document.getElementById('status');
    var list = document.getElementById('results');
    var more = document.getElementById('more');
    if (!form || !q || !list) return;
    form.hidden = false;
    var nojs = document.getElementById('nojs');
    if (nojs) nojs.hidden = true;

    var hits = [], shown = 0, ts = [], timer = null;
    var meaningBox = document.getElementById('meaning'), index;
    var byMeaning = function () { return !!meaningBox && meaningBox.checked; };

    function scope() {
      var c = form.querySelector('input[name="in"]:checked');
      return c ? c.value : 'all';
    }

    function readHash() {
      var p = new URLSearchParams(location.hash.slice(1));
      q.value = p.get('q') || '';
      var sc = form.querySelector('input[name="in"][value="' + (p.get('in') || 'all') + '"]');
      if (sc) sc.checked = true;
      if (sortSel && p.get('sort')) sortSel.value = p.get('sort');
      if (meaningBox) meaningBox.checked = p.get('exact') !== '1';
    }

    function writeHash() {
      var p = new URLSearchParams();
      if (q.value) p.set('q', q.value);
      if (scope() !== 'all') p.set('in', scope());
      if (sortSel && sortSel.value !== 'relevance') p.set('sort', sortSel.value);
      if (meaningBox && !meaningBox.checked) p.set('exact', '1');
      var h = p.toString();
      try { history.replaceState(null, '', h ? '#' + h : location.pathname); }
      catch (e) { location.hash = h; }
    }

    function item(h) {
      var r = h.r, li = el('li', 'hit hit-' + r.k);
      var a = el('a');
      a.href = ROOT + r.u;
      var head = el('span', 'hit-head');
      head.appendChild(el('span', 'd', r.d));
      if (r.k === 'e') {
        head.appendChild(el('b', null, r.t));
      } else {
        head.appendChild(el('span', 'who', r.w ? r.w : 'anonymous'));
        head.appendChild(document.createTextNode(' on '));
        head.appendChild(el('b', null, r.t));
        if (r.s) head.appendChild(el('span', 'subj', ' — ' + r.s));
      }
      a.appendChild(head);
      var p = el('span', 'snippet');
      var segs = snippet(r.x, ts);
      for (var i = 0; i < segs.length; i++) {
        p.appendChild(segs[i].mark ? el('mark', null, segs[i].text) : document.createTextNode(segs[i].text));
      }
      a.appendChild(p);
      li.appendChild(a);
      return li;
    }

    function showMore() {
      var stop = Math.min(hits.length, shown + PAGE);
      var frag = document.createDocumentFragment();
      for (; shown < stop; shown++) frag.appendChild(item(hits[shown]));
      list.appendChild(frag);
      if (more) more.hidden = shown >= hits.length;
    }

    function run() {
      ts = terms(q.value);
      if (byMeaning() && ts.length > 0) {
        if (index === undefined) {
          status.textContent = 'Loading search by meaning\u2026';
          index = meaningIndex(window);
        }
      }
      hits = byMeaning() && index
        ? meaning(data, q.value, scope(), sortSel ? sortSel.value : 'relevance', index)
        : search(data, q.value, scope(), sortSel ? sortSel.value : 'relevance');
      // By meaning, a result isn't there because of "my" or "the" — highlight only
      // the words that carry the query.
      if (byMeaning() && index) ts = ts.filter(function (t) { return !MSTOP[t]; });
      shown = 0;
      list.textContent = '';
      if (ts.length === 0) {
        status.textContent = data.length + ' entries and comments, searchable.';
        if (more) more.hidden = true;
        return;
      }
      var ne = 0, nc = 0;
      for (var i = 0; i < hits.length; i++) { if (hits[i].r.k === 'e') ne++; else nc++; }
      status.textContent = hits.length === 0 ? 'Nothing matches.'
        : byMeaning() && index ? 'The ' + hits.length + ' closest in meaning: ' + ne + (ne === 1 ? ' entry' : ' entries') + ' and ' + nc + (nc === 1 ? ' comment' : ' comments') + '.'
        : ne + (ne === 1 ? ' entry' : ' entries') + ' and ' + nc + (nc === 1 ? ' comment' : ' comments') + ' match.';
      showMore();
    }

    function soon() { writeHash(); clearTimeout(timer); timer = setTimeout(run, 120); }

    form.addEventListener('submit', function (e) { e.preventDefault(); writeHash(); run(); });
    q.addEventListener('input', soon);
    form.addEventListener('change', soon);
    if (more) more.addEventListener('click', showMore);
    window.addEventListener('hashchange', function () { readHash(); run(); });

    readHash();
    run();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
`;
