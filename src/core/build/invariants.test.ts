import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderBody, type RenderContext } from './render.js';

/**
 * Invariants, not examples (DESIGN.md §10).
 *
 * The rest of the suite asserts specific behaviours I had already thought of,
 * which is exactly why it was green while entry 406397 rendered 1 of its 3
 * images and entry 127053 silently ate its own sign-off. A test written from my
 * beliefs cannot catch a bug caused by my beliefs.
 *
 * Every real bug this project has had was ONE thing: content going in and not
 * coming out. That is a property, and a property can be checked over inputs
 * nobody hand-picked — including inputs whose failure mode nobody has imagined
 * yet. These are the checks that were being run as throwaway scripts while the
 * committed suite tested none of it.
 */

interface Body {
  readonly kind: 'entry' | 'comment';
  readonly id: number;
  readonly html: string;
}
const bodies: Body[] = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/bodies.json', import.meta.url), 'utf8'),
) as Body[];

const ctx = (over: Partial<RenderContext> = {}): RenderContext => ({
  localFor: () => 'blobs/ab/cd.jpg',
  deadReason: () => 'HTTP 404',
  username: 'testuser',
  entryHref: () => undefined,
  root: '../',
  ...over,
});

/**
 * Visible text, with entities decoded.
 *
 * NUMERIC entities are the point. LJ stores apostrophes as &#39;, so a source
 * reading `don&#39;t` renders correctly as `don't` — and comparing those raw
 * strings scores a CORRECT render as data loss. That false positive cost real
 * time on entry 403272 before the instrument was fixed. An assertion that fires
 * on correct behaviour is worse than no assertion.
 */
const text = (html: string): string =>
  html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();

const words = (html: string): string[] =>
  text(html)
    .split(' ')
    .filter((w) => w.length > 3);

describe('invariant: the renderer never loses content', () => {
  // catches: ANY transform that drops what it was handed — the entire class that
  // <lj-embed> and </3 both belong to. Not a list of tags I remembered; a rule.
  it.each(bodies.map((b) => [`${b.kind} ${b.id}`, b] as const))(
    'keeps every word of %s',
    (_label, b) => {
      const rendered = new Set(words(renderBody(b.html, ctx())));
      const lost = words(b.html).filter((w) => !rendered.has(w));
      expect(lost).toEqual([]);
    },
  );

  // catches: an <img> vanishing rather than becoming a marker. Unambiguous —
  // count them in, count them out. This is the check that found <lj-embed>
  // deleting 2 images, while 145 hand-written assertions saw nothing.
  it.each(bodies.map((b) => [`${b.kind} ${b.id}`, b] as const))(
    'every image in %s is still on the page, live or marked lost',
    (_label, b) => {
      const before = (b.html.match(/<img/gi) ?? []).length;
      const out = renderBody(b.html, ctx({ localFor: () => undefined }));
      const after = (out.match(/<img/gi) ?? []).length + (out.match(/dead-image/g) ?? []).length;
      expect(after).toBeGreaterThanOrEqual(before);
    },
  );
});

/**
 * Every LJ tag is VOID in practice: LiveJournal never emitted a closing tag, so
 * parse5 nests the rest of the entry INSIDE it. A handler that replaces the tag
 * without hoisting its children silently deletes everything after it.
 *
 * This bit three times — <lj user>, the lj-* catch-all, then <lj-embed>, which
 * ate 2 images and the prose after a video in 6 entries. Each time it was fixed
 * where it was found and not swept for. A table is the sweep: a new lj-* handler
 * that forgets to hoist fails here, including for tags nobody has met yet.
 */
describe('invariant: an unclosed LJ tag never eats the rest of the entry', () => {
  const TAGS = [
    '<lj user="alice">',
    '<lj comm="somegroup">',
    '<lj-cut text="more">',
    '<lj-embed id="42">',
    '<lj-poll-1438708>',
    '<lj-template name="qotd" id="27">',
    '<lj-raw>',
    '<lj-map id="9">', // never seen in this corpus: the point is it still holds
  ];

  it.each(TAGS)('%s keeps the prose that follows it', (tag) => {
    const html = renderBody(`before ${tag} SURVIVOR after`, ctx());
    expect(text(html)).toContain('SURVIVOR');
    expect(text(html)).toContain('after');
  });

  it.each(TAGS)('%s keeps an image that follows it', (tag) => {
    const html = renderBody(`${tag}<img src="http://h.invalid/a.jpg">`, ctx());
    expect((html.match(/<img/g) ?? []).length).toBe(1);
  });

  it.each(TAGS)('%s leaves no lj-namespace tag in the output', (tag) => {
    // A browser renders an unknown element as nothing and keeps only its text —
    // and these tags have no text, so shipping one means shipping a hole.
    expect(renderBody(`${tag}x`, ctx())).not.toMatch(/<lj[\s>-]/i);
  });
});

/**
 * Markup-shaped text is text. HTML5 sends `</` plus a non-letter into the BOGUS
 * COMMENT state, which swallows to the next `>` — and with none, the rest of the
 * body. A broken heart cost entry 127053 its sign-off AND the author's name,
 * while the live LJ page rendered both.
 */
describe('invariant: emoticons that look like markup survive', () => {
  it.each(['</3', '<3', '<-', '</', '>_<', '<_<', '</3, Preston'])(
    'keeps %s and everything after it',
    (emote) => {
      const html = renderBody(`before ${emote} SURVIVOR`, ctx());
      expect(text(html)).toContain('SURVIVOR');
    },
  );
});

/**
 * A newline is a line break (LJ's addbreaks).
 *
 * LiveJournal turned \n into <br /> when it rendered an entry, unless
 * opt_preformatted was set. We stored the raw body and parsed it as HTML, where
 * whitespace collapses — so every paragraph break in 1,132 of 1,547 entries
 * silently vanished. 73% of the journal rendered as one wall of text.
 *
 * Nothing caught it. Not 313 tests, and not the live parity check, which had
 * declared 1,541 entries "at parity" while it was happening: that check compares
 * letters and digits only, deliberately, because whitespace kept producing false
 * positives. Immune to whitespace means blind to whitespace. These assertions
 * exist because the oracle that should have seen this cannot.
 */
describe('invariant: a newline is a line break', () => {
  // catches: the wall of text. HTML collapses whitespace, so a body whose only
  // structure is newlines renders as one paragraph unless something intervenes.
  it('turns a bare newline into a break', () => {
    const html = renderBody('line one\nline two', ctx());
    expect(html).toContain('<br>');
    expect(html).toMatch(/line one\s*<br>\s*line two/);
  });

  it('turns a blank line into two breaks, not one', () => {
    expect((renderBody('a\n\nb', ctx()).match(/<br>/g) ?? []).length).toBe(2);
  });

  // catches: double-breaking a body that is already real HTML. Only 4 entries in
  // the corpus set opt_preformatted, which is exactly why it would go unnoticed.
  it('leaves a preformatted body alone', () => {
    expect(renderBody('a\nb', ctx({ preformatted: true }))).not.toContain('<br>');
  });

  // catches: injecting breaks into table markup. A newline between <tr> and <td>
  // is indentation, not writing, and breaking it puts blank rows in the layout.
  // Derived from the live journal: entry 35094 has 620 newlines, ~617 inside a
  // table, and LJ renders 3 breaks.
  it('does not break newlines inside table markup', () => {
    const html = renderBody('<table>\n<tr>\n<td>\ncell\n</td>\n</tr>\n</table>', ctx());
    expect(html).not.toContain('<br>');
  });

  it('does not break inside pre, where whitespace already means what it says', () => {
    expect(renderBody('<pre>a\nb</pre>', ctx())).not.toContain('<br>');
  });

  // catches: over-suppressing. My first suppression list included ul/ol on the
  // reasoning that indentation in a list is markup. The live page says otherwise:
  // entry 353595 has 6 newlines in a <ul> and LJ renders 6 breaks. A rule reasoned
  // out from first principles lost to one look at the thing.
  it('DOES break inside a list, because LiveJournal does', () => {
    const html = renderBody('<ul><li>one\ntwo</li></ul>', ctx());
    expect(html).toContain('<br>');
  });

  // The corpus: no entry may lose the structure its author typed.
  it.each(
    bodies
      .filter((b) => /\n/.test(b.html) && !/<br|<p[\s>]/i.test(b.html))
      .map((b) => [`${b.kind} ${b.id}`, b] as const),
  )('keeps the line structure of %s', (_label, b) => {
    const out = renderBody(b.html, ctx());
    // Every newline outside table markup survives as a break.
    expect(out).toContain('<br>');
  });
});

/**
 * Third-party content cannot execute (DESIGN.md §8).
 *
 * renderBody serializes commenter-supplied HTML into the generated page. LJ
 * scrubbed comments so this corpus is clean, but the archive is offline HTML that
 * may one day be hosted — at which point an un-neutralized script tag, on-handler,
 * or javascript: URL from a 2005 comment is stored XSS. Two review agents flagged
 * that no sanitizer existed; this is the invariant that keeps one.
 */
describe('invariant: rendered bodies carry no executable content', () => {
  // catches: any active-content vector surviving the transform. Not a list of the
  // three I fixed — a rule the output must satisfy for ANY input.
  it.each([
    '<script>alert(1)</script>',
    '<img src=x onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<div onclick="alert(1)">x</div>',
    '<style>body{x:url(javascript:alert(1))}</style>',
    '<a href="JavaScript:alert(1)">x</a>',
    '<svg onload="alert(1)">',
  ])('neutralizes %s', (evil) => {
    const out = renderBody(`before ${evil} after`, ctx());
    expect(out).not.toMatch(/<script[\s>]/i);
    expect(out).not.toMatch(/<style[\s>]/i);
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out).not.toMatch(/javascript:/i);
  });

  // catches: sanitization degrading into "strip everything". The surrounding
  // prose and a benign link must survive.
  it('keeps benign content and links intact', () => {
    const out = renderBody('hi <a href="http://ok.example/x">link</a> bye', ctx());
    expect(text(out)).toContain('hi');
    expect(text(out)).toContain('bye');
    expect(out).toContain('href="http://ok.example/x"');
    expect(out).toContain('link');
  });
});
