import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { extract, distinctUrls, type Extraction } from './extract.js';

/**
 * The oracle is 57 real entry and comment bodies — LiveJournal's markup and
 * 2005 Preston's tag soup, selected for coverage and redacted structure-
 * preserving (DESIGN.md §5.4, §10). Nobody here authored the structure.
 *
 * Counts below are properties of that corpus, so they cannot pass unless the
 * extractor is right.
 */
interface Body {
  readonly kind: 'entry' | 'comment';
  readonly id: number;
  readonly html: string;
}

const bodies: Body[] = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/bodies.json', import.meta.url), 'utf8'),
) as Body[];

const all = (): Extraction[] => bodies.map((b) => extract(b.html));

describe('extract — images', () => {
  it('finds every inline image across the corpus', () => {
    const n = all().reduce((sum, e) => sum + e.images.filter((i) => i.kind === 'img').length, 0);
    expect(n).toBe(335);
  });

  // catches: treating any <a href> as an image. A link to a photo *page* is a
  // link; only a link whose target is the file itself is something to localize.
  it('takes <a href> only when the target is an image file', () => {
    const links = all().flatMap((e) => e.images.filter((i) => i.kind === 'link'));
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) expect(l.url).toMatch(/\.(jpe?g|png|gif|bmp|webp|tiff?)(?:[?#]|$)/i);
  });

  // catches: dropping relative URLs. 5 of 608 refs in the real corpus are
  // relative or protocol-relative; without a base they're unfetchable, and
  // silently skipping them loses real images.
  it('resolves relative URLs against the entry permalink', () => {
    const e = extract(
      '<img src="pic.jpg"><img src="/abs.png"><img src="//host9.invalid/p.gif">',
      'https://example.invalid/1234.html',
    );
    expect(e.images.map((i) => i.url)).toEqual([
      'https://example.invalid/pic.jpg',
      'https://example.invalid/abs.png',
      'https://host9.invalid/p.gif',
    ]);
  });

  // catches: throwing on a URL that won't parse. Image failures are data, not
  // crashes (§9) — and the placeholder needs the original to name what was lost.
  it('keeps an unparseable URL verbatim rather than throwing', () => {
    const e = extract('<img src="http://[not a url">');
    expect(e.images).toHaveLength(1);
    expect(e.images[0]?.raw).toBe('http://[not a url');
  });

  it('records alt text where it exists, undefined where it does not', () => {
    const e = extract('<img src="a.jpg" alt="a cat"><img src="b.jpg">');
    expect(e.images[0]?.alt).toBe('a cat');
    expect(e.images[1]?.alt).toBeUndefined();
  });

  // catches: an extractor that only survives well-formed HTML. This is 2003 tag
  // soup — uppercase tags, unquoted attributes, unclosed everything — and a
  // strict parser returns nothing for it.
  it('survives era tag soup: uppercase tags and unquoted attributes', () => {
    const e = extract('<TABLE><TR><TD><IMG SRC=cat.jpg WIDTH=50>');
    expect(e.images).toHaveLength(1);
    expect(e.images[0]?.raw).toBe('cat.jpg');
  });
});

describe('extract — LJ markup (§5.3)', () => {
  // catches: ignoring <lj user>. It renders as NOTHING in a browser, so 204
  // mentions of 193 people would silently vanish from the entries — and the
  // design didn't mention the tag at all until the corpus was surveyed.
  it('finds every <lj user> reference in the corpus', () => {
    const n = all().reduce((sum, e) => sum + e.ljUsers.length, 0);
    expect(n).toBe(196);
  });

  it('reads both <lj user> and <lj comm>', () => {
    const e = extract('<lj user="alice"> and <lj comm="somegroup">');
    expect(e.ljUsers).toEqual(['alice', 'somegroup']);
  });

  it('normalises usernames to lowercase so they join the users table', () => {
    expect(extract('<lj user="Alice">').ljUsers).toEqual(['alice']);
  });

  // catches: requiring a matching </lj-cut>. 54 of 69 cuts in the real corpus
  // are never closed — LJ treated that as "cut to the end of the entry" — so an
  // implementation expecting pairs mangles the majority.
  it('detects an unclosed <lj-cut>', () => {
    const e = extract('before <lj-cut text="more"> after');
    expect(e.hasCut).toBe(true);
    expect(e.cutText).toBe('more');
  });

  it('detects a closed <lj-cut>', () => {
    expect(extract('a <lj-cut>b</lj-cut> c').hasCut).toBe(true);
  });

  it('finds cuts across the corpus, most of them unclosed', () => {
    expect(all().filter((e) => e.hasCut).length).toBeGreaterThan(0);
  });

  // Structural guard, not a defect-catcher — and worth being honest about the
  // difference. The else-if chain means an embed *cannot* reach `images`, so
  // this can only fail if someone refactors that separation away. Kept for that,
  // claimed as nothing more (§10).
  it('records embeds without treating them as images', () => {
    const e = extract('<lj-embed id="42"></lj-embed><iframe src="https://v.invalid/x"></iframe>');
    expect(e.embeds.map((x) => x.tag)).toEqual(['lj-embed', 'iframe']);
    expect(e.images).toHaveLength(0);
  });

  // catches: recording that an embed existed but not WHAT it referenced. §5.2
  // says embeds are kept "as links with metadata" — an embed with no URL is a
  // note saying a video used to be here, which is exactly the silent gap §4.3
  // forbids. The reference is the only part worth keeping.
  it('captures what each embed pointed at', () => {
    const e = extract(
      '<iframe src="https://v.invalid/watch"></iframe>' +
        '<object data="https://v.invalid/movie.swf"></object>' +
        '<lj-embed id="42"></lj-embed>',
    );
    expect(e.embeds.map((x) => x.url)).toEqual([
      'https://v.invalid/watch',
      'https://v.invalid/movie.swf',
      '42',
    ]);
  });
});

describe('extract — the work list', () => {
  // catches: fetching the same URL once per reference. 335 refs collapse to far
  // fewer distinct URLs; the download list is the distinct set.
  it('collapses references to distinct URLs', () => {
    const urls = distinctUrls(all());
    const refs = all().reduce((n, e) => n + e.images.length, 0);
    expect(urls.size).toBeGreaterThan(0);
    expect(urls.size).toBeLessThan(refs);
  });

  // catches: losing the reference count. Host collapse — many refs, one host —
  // is the entire poison signal (§5.2), so the counts have to survive.
  it('preserves the host concentration the poison signal keys on', () => {
    const perHost = new Map<string, number>();
    for (const [url, count] of distinctUrls(all())) {
      try {
        const h = new URL(url).hostname;
        perHost.set(h, (perHost.get(h) ?? 0) + count);
      } catch {
        /* unparseable — not a host */
      }
    }
    const top = [...perHost.values()].sort((a, b) => b - a);
    // One host dominates: that concentration is what makes collapse detectable.
    expect(top[0]).toBeGreaterThan(50);
    expect(perHost.size).toBeGreaterThan(20);
  });
});
