import { parseFragment } from 'parse5';
import { createHash } from 'node:crypto';

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
 *             absence), unclosed anything, URL scheme + HOST, relative-vs-
 *             absolute, file extension, entity encoding outside prose
 *   REDACTED  prose, usernames, URL paths, alt/title text
 *
 * Hosts survive deliberately: host distribution IS the poison signal (§5.2).
 * 142 refs to img.photobucket.com collapsing to one hash is the whole
 * mechanism, and a fixture with fake hosts cannot exercise it.
 */

/** Stable pseudonyms, so the same input always yields the same fake. */
const seen = new Map<string, string>();
function stable(real: string, prefix: string): string {
  const hit = seen.get(prefix + real);
  if (hit !== undefined) return hit;
  const fake = `${prefix}_${createHash('sha256').update(real).digest('hex').slice(0, 6)}`;
  seen.set(prefix + real, fake);
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

/** Keep scheme + host + extension; redact the path that identifies the image. */
function redactUrl(raw: string): string {
  const ext = /\.([a-z0-9]{2,4})(?:[?#]|$)/i.exec(raw)?.[1] ?? '';
  const tail = `redacted/${createHash('sha256').update(raw).digest('hex').slice(0, 6)}${ext ? '.' + ext : ''}`;

  if (raw.startsWith('//')) return `//${raw.slice(2).split('/')[0] ?? ''}/${tail}`;
  const m = /^([a-z][\w+.-]*):\/\/([^/?#]+)/i.exec(raw);
  if (m) return `${m[1]}://${m[2]}/${tail}`;
  return raw.startsWith('/') ? `/${tail}` : tail;
}

/** The identifying part of a URL — what redactUrl actually strips. */
function urlPath(raw: string): string | undefined {
  const m = /^(?:[a-z][\w+.-]*:)?\/\/[^/?#]+(\/.*)?$/i.exec(raw);
  const path = m ? m[1] : raw;
  return path !== undefined && path.length > 1 ? path : undefined;
}

const URL_ATTRS = new Set(['src', 'href', 'background', 'lowsrc', 'poster', 'data']);
const USER_ATTRS = new Set(['user', 'comm']);

/**
 * Attributes whose values are STRUCTURE and may be published verbatim.
 *
 * This list is a deny-by-default allowlist, and that direction is the whole
 * point. The first version listed which attributes to REDACT — and so published
 * everything it hadn't thought of. It leaked the account name out of
 * `<input value='evilgoatbob'>` inside a 2000s LJ quiz meme, straight into a
 * public fixture. An attribute nobody anticipated is exactly the one that leaks.
 *
 * So: unknown attribute → redacted. Adding a case is cheap; a leak is not.
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
   * Only what CHANGED is recorded. Hosts and punctuation survive on purpose, so
   * recording them makes the verifier flag its own intended output as a leak.
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

      let replacement: string | undefined;
      if (USER_ATTRS.has(name)) {
        removed.push(a.value);
        replacement = stable(a.value, 'commenter');
      } else if (URL_ATTRS.has(name)) {
        const p = urlPath(a.value);
        if (p !== undefined) removed.push(p);
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
      if (replacement === undefined) continue;

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
