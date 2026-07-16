import { parseFragment } from 'parse5';

/**
 * Structure-preserving redaction of entry/comment HTML.
 *
 * PARSE TO FIND, SPLICE TO EDIT. parse5 locates text nodes and attributes; the
 * edits are applied to the original string by byte offset. Nothing is
 * reserialized.
 *
 * That is not fussiness. parse5 AUTO-CLOSES unclosed tags on round-trip —
 * verified: an unclosed <lj-cut> goes in open=1/close=0 and comes out
 * open=1/close=1. 54 of 69 entries with a cut leave it unclosed, because LJ
 * treated that as "cut to the end of the entry". A reserializing redactor
 * repairs the exact malformation M2 must survive and yields a fixture testing a
 * well-formed corpus that does not exist (DESIGN.md §5.4).
 *
 * Round-tripping would also normalize attribute quoting and tag case — the
 * things a 2003 entry is full of and a parser has to cope with.
 *
 *   KEPT      tags, nesting, tag case, attribute names, quoting style (or its
 *             absence), unclosed anything, URL scheme, relative-vs-absolute,
 *             file extension, host DISTRIBUTION, entity encoding outside prose
 *   REDACTED  prose, usernames, hostnames, URL paths, and every attribute value
 *             not on the structural allowlist
 */

/**
 * Pseudonyms are COUNTERS, not hashes.
 *
 * A hash pseudonym is confirmable: anyone holding this file can hash a guess and
 * compare. Salting changes nothing, because the salt would be committed right
 * here — a published salt is not a secret.
 *
 * That bites hardest exactly where the input space is small, which is everywhere
 * that matters here. Image hosts are a tiny dictionary (photobucket, imageshack,
 * tinypic, tripod, angelfire, geocities — a few thousand candidates against 24
 * bits of hex); LJ usernames are likewise enumerable. Every one falls out in
 * milliseconds, and the pseudonym is decorative.
 *
 * A counter has no function from the real value to the fake one. There is
 * nothing to compute, so there is nothing to confirm. It reveals only the order
 * of first appearance, which says nothing about anyone.
 */
const ids = {
  host: new Map<string, string>(),
  path: new Map<string, string>(),
  user: new Map<string, string>(),
};

function counter(map: Map<string, string>, key: string, fmt: (n: number) => string): string {
  const hit = map.get(key);
  if (hit !== undefined) return hit;
  const fake = fmt(map.size + 1);
  map.set(key, fake);
  return fake;
}

/** Words a human wrote → filler. Punctuation and whitespace pass through. */
function redactProse(text: string): string {
  return text.replace(/\S+/g, (w) => (/^[\W\d]+$/.test(w) ? w : 'redacted'));
}

/**
 * Redact a TEXT-NODE SOURCE SPAN, which may contain markup.
 *
 * It sounds impossible and isn't: HTML5 FOSTER PARENTING relocates text found
 * directly inside a <table> (no cell) to before the table, and parse5 then hands
 * back a text node whose source span stretches across the <table> tag itself.
 * Feeding that to redactProse turns "<table>" into the word "redacted" and
 * destroys the tag — verified on a real entry (1284 tags in, 1283 out).
 *
 * So: redact only the text BETWEEN tags, never the tags.
 */
function redactSpan(raw: string): string {
  return raw.replace(
    /(<[^>]*>)|([^<]+)/g,
    (_m, tag: string | undefined, text: string | undefined) =>
      tag !== undefined ? tag : redactProse(text ?? ''),
  );
}

/**
 * Stable per-host pseudonym: every reference to one real host maps to one fake
 * host, always.
 *
 * That stability is the whole point. Poison detection keys on host COLLAPSE —
 * N distinct URLs on the same host hashing to identical bytes (§5.2) — so what
 * the fixture must preserve is the DISTRIBUTION: 142 refs sharing a host, 33
 * sharing another. It never needs the literal string "photobucket", and a real
 * hostname list is a fingerprint of what the author was reading for a decade.
 *
 * .invalid is reserved by RFC 2606 and can never resolve, so a fixture URL can't
 * accidentally hit a real server if a test ever fetches one.
 */
function pseudoHost(host: string): string {
  return counter(ids.host, host.toLowerCase(), (n) => `host${n}.invalid`);
}

/**
 * Keep the URL's SHAPE — scheme, relative-vs-absolute, extension — and replace
 * both host and path. Neither identifies anything; the shape is what a parser
 * has to cope with.
 */
function redactUrl(raw: string): string {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(raw)?.[1] ?? '';
  // Distinct URLs get distinct paths — all the fixture needs. The path is a
  // placeholder, not an identifier.
  const tail = `redacted/${counter(ids.path, raw, String)}${ext ? '.' + ext : ''}`;

  // Protocol-relative: //host/path
  if (raw.startsWith('//')) {
    const host = raw.slice(2).split('/')[0] ?? '';
    return `//${pseudoHost(host)}/${tail}`;
  }
  const m = /^([a-z][\w+.-]*):\/\/([^/?#]+)/i.exec(raw);
  if (m) return `${m[1]}://${pseudoHost(m[2] ?? '')}/${tail}`;
  // Relative — no host to hide; the shape is what matters.
  return raw.startsWith('/') ? `/${tail}` : tail;
}

/** The host + path we replace, so a verifier can prove neither survived. */
function identifyingParts(raw: string): string[] {
  const out: string[] = [];
  const m = /^(?:[a-z][\w+.-]*:)?\/\/([^/?#]+)(\/.*)?$/i.exec(raw);
  if (m) {
    if (m[1]) out.push(m[1]);
    if (m[2] !== undefined && m[2].length > 1) out.push(m[2]);
  } else if (raw.length > 1) {
    out.push(raw);
  }
  return out;
}

const URL_ATTRS = new Set(['src', 'href', 'background', 'lowsrc', 'poster', 'data']);
const USER_ATTRS = new Set(['user', 'comm']);

/**
 * Attributes whose values are STRUCTURE and may be published verbatim.
 *
 * This is a deny-by-default allowlist, and the direction is the whole point. The
 * first version listed which attributes to REDACT — and so published everything
 * it hadn't thought of. It leaked the account name out of an
 * `<input value='…'>` inside a 2000s LJ quiz meme, straight into a public
 * fixture. An attribute nobody anticipated is exactly the one that leaks.
 *
 * (And the first version of THIS comment quoted the leaked value verbatim —
 * documenting a leak by re-committing it. The example is the shape, never the
 * data.)
 *
 * Unknown attribute → redacted. Adding a case is cheap; a leak is not.
 */
const STRUCTURAL_ATTRS = new Set([
  'class',
  'id',
  'style',
  'width',
  'height',
  'border',
  'align',
  'valign',
  'cellpadding',
  'cellspacing',
  'colspan',
  'rowspan',
  'size',
  'color',
  'face',
  'bgcolor',
  'type',
  'target',
  'rel',
  'hspace',
  'vspace',
  'nowrap',
  'dir',
  'lang',
  'start',
  'clear',
]);

interface Loc {
  startOffset: number;
  endOffset: number;
}
interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
  sourceCodeLocation?: Loc & { attrs?: Record<string, Loc> };
}

export interface HtmlRedaction {
  readonly html: string;
  /**
   * Every original value removed, so a verifier can prove none survived.
   *
   * Only what CHANGED is recorded. Punctuation survives on purpose, so
   * recording it makes the verifier flag its own intended output as a leak.
   */
  readonly removed: string[];
}

export function redactHtml(html: string): HtmlRedaction {
  const removed: string[] = [];
  const edits: { start: number; end: number; text: string }[] = [];

  const frag = parseFragment(html, { sourceCodeLocationInfo: true }) as unknown as Node;

  const visit = (node: Node): void => {
    const loc = node.sourceCodeLocation;

    if (node.nodeName === '#text' && loc) {
      // Redact the RAW source slice, not parse5's decoded value: splicing
      // decoded text back in would silently rewrite entity encoding.
      const raw = html.slice(loc.startOffset, loc.endOffset);
      const out = redactSpan(raw);
      if (out !== raw) {
        removed.push(raw);
        edits.push({ start: loc.startOffset, end: loc.endOffset, text: out });
      }
    }

    for (const a of node.attrs ?? []) {
      const aLoc = loc?.attrs?.[a.name];
      if (!aLoc || !a.value.trim()) continue;
      const name = a.name.toLowerCase();

      let replacement: string;
      if (USER_ATTRS.has(name)) {
        removed.push(a.value);
        replacement = counter(ids.user, a.value.toLowerCase(), (n) => `commenter${n}`);
      } else if (URL_ATTRS.has(name)) {
        removed.push(...identifyingParts(a.value));
        replacement = redactUrl(a.value);
      } else if (STRUCTURAL_ATTRS.has(name)) {
        continue; // known-structural: publish verbatim
      } else {
        // Deny by default. alt, title, value, name, onclick, and every
        // attribute nobody has thought of yet land here.
        //
        // Flat 'redacted', not redactProse: that exempts digit-only values,
        // which is right for width=50 (structural, handled above) and wrong for
        // <input value='1073987828'>. Outside the structural list a bare number
        // is data, not layout.
        removed.push(a.value);
        replacement = 'redacted';
      }

      // Rebuild only the VALUE, preserving the attribute's original name case
      // and quoting style — including no quotes at all, which 2003 HTML is full
      // of and which a parser has to survive.
      const rawAttr = html.slice(aLoc.startOffset, aLoc.endOffset);
      const eq = rawAttr.indexOf('=');
      if (eq === -1) continue;
      const lhs = rawAttr.slice(0, eq + 1);
      const rest = rawAttr.slice(eq + 1).trimStart();
      const quote = rest.startsWith('"') ? '"' : rest.startsWith("'") ? "'" : '';
      edits.push({
        start: aLoc.startOffset,
        end: aLoc.endOffset,
        text: `${lhs}${quote}${replacement}${quote}`,
      });
    }

    for (const c of node.childNodes ?? []) visit(c);
    if (node.content) visit(node.content);
  };

  visit(frag);

  // Apply right-to-left so earlier offsets stay valid.
  edits.sort((a, b) => b.start - a.start);
  let out = html;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  return { html: out, removed };
}
