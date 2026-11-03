import { describe, it, expect } from 'vitest';
import { runInNewContext } from 'node:vm';
import { textOf, searchDataJs, SEARCH_JS, type SearchRecord } from './search.js';

/**
 * The search engine, tested as the exact bytes the browser runs: SEARCH_JS is
 * evaluated in a sandbox with no document, which exposes the engine and skips
 * the page wiring. Expected values are hand-chosen strings, never the engine's
 * own output (DESIGN.md §10).
 */

interface Seg {
  text: string;
  mark: boolean;
}
interface Hit {
  r: SearchRecord;
}
interface Engine {
  norm(s: string): string;
  terms(q: string): string[];
  search(rs: SearchRecord[], q: string, scope: string, sort: string): Hit[];
  snippet(text: string, ts: string[], width?: number): Seg[];
}

const engine = (): Engine => {
  const window: { NeoSearch?: Engine } = {};
  runInNewContext(SEARCH_JS, { window });
  return window.NeoSearch!;
};

const E = (u: string, d: string, t: string, x: string): SearchRecord => ({ k: 'e', u, d, t, x });
const C = (u: string, d: string, t: string, x: string): SearchRecord => ({
  k: 'c',
  u,
  d,
  t,
  w: 'alice',
  x,
});
const urls = (hits: Hit[]): string[] => hits.map((h) => h.r.u);
const marked = (segs: Seg[]): string[] => segs.filter((s) => s.mark).map((s) => s.text);

describe('textOf: what the reader sees, as searchable words', () => {
  // catches: line breaks and blocks gluing words together — "line<br>second"
  // indexed as "linesecond", so neither word could ever be found.
  it.each([
    ['a <br>', 'first line<br>second line', 'first line second line'],
    ['paragraphs', '<p>one</p><p>two</p>', 'one two'],
    ['list items', '<ul><li>apples</li><li>pears</li></ul>', 'apples pears'],
    ['table cells', '<table><tr><td>left</td><td>right</td></tr></table>', 'left right'],
  ])('%s ends a word', (_l, html, expected) => {
    expect(textOf(html)).toBe(expected);
  });

  // catches: indexing entity source instead of text — "Iron &amp; Wine" is what
  // the HTML says, "Iron & Wine" is what the reader reads and types.
  it('decodes entities to the characters shown', () => {
    expect(textOf('Iron &amp; Wine &#39;04 &lt;3')).toBe("Iron & Wine '04 <3");
  });

  // catches: inline formatting splitting a word — bold mid-word is still one word.
  it('does not split a word at inline markup', () => {
    expect(textOf('a <b>bold</b><i>ly</i> typed word')).toBe('a boldly typed word');
  });
});

describe('the engine', () => {
  const ns = engine();

  // catches: OR semantics. Every word typed has to appear; a record holding only
  // one of them is noise, and at 8,000 records OR buries the one you meant.
  it('requires every word', () => {
    const rs = [E('a', '2004-01-01', '', 'red fish'), E('b', '2004-01-02', '', 'red bicycle')];
    expect(urls(ns.search(rs, 'red fish', 'all', 'oldest'))).toEqual(['a']);
  });

  // catches: a quoted phrase matching its words anywhere instead of together.
  it('keeps a quoted phrase together', () => {
    const rs = [
      E('a', '2004-01-01', '', 'we went to the late show'),
      E('b', '2004-01-02', '', 'the show ran late'),
    ];
    expect(urls(ns.search(rs, '"late show"', 'all', 'oldest'))).toEqual(['a']);
  });

  // catches: the query and the text folded differently — what a decade of
  // keyboards, phones, and LJ's editor typed has to meet what's typed now.
  it.each([
    ['case', 'TIRED', 'so tired'],
    ['accents', 'cafe', 'back at the café'],
    ['curly apostrophe', "don't", 'I don’t know'],
    ['curly quotes', '"he said"', 'and “he said” it'],
    ['ligature', 'final', 'the ﬁnal straw'],
  ])('%s does not matter', (_l, q, x) => {
    expect(urls(ns.search([E('a', '2004-01-01', '', x)], q, 'all', 'oldest'))).toEqual(['a']);
  });

  // catches: a comment matching on the title of the entry it sits under, which
  // returns every reply on "Road trip" for a search about a road trip.
  it("does not match a comment by its entry's title", () => {
    const rs = [
      E('e', '2004-01-01', 'Road trip', 'we drove'),
      C('e#c1', '2004-01-01', 'Road trip', 'lol'),
    ];
    expect(urls(ns.search(rs, 'road trip', 'all', 'oldest'))).toEqual(['e']);
  });

  // catches: scope ignored, or applied backwards.
  it('narrows to entries or comments', () => {
    const rs = [E('e', '2004-01-01', '', 'cats'), C('e#c1', '2004-01-02', 't', 'cats')];
    expect(urls(ns.search(rs, 'cats', 'entries', 'oldest'))).toEqual(['e']);
    expect(urls(ns.search(rs, 'cats', 'comments', 'oldest'))).toEqual(['e#c1']);
  });

  it('sorts by date either way', () => {
    const rs = [
      E('mid', '2005-06-01', '', 'x'),
      E('old', '2002-01-01', '', 'x'),
      E('new', '2009-12-31', '', 'x'),
    ];
    expect(urls(ns.search(rs, 'x', 'all', 'oldest'))).toEqual(['old', 'mid', 'new']);
    expect(urls(ns.search(rs, 'x', 'all', 'newest'))).toEqual(['new', 'mid', 'old']);
  });

  // catches: a title hit ranked below a passing mention in a long body.
  it('ranks a title match first', () => {
    const rs = [
      E('body', '2004-01-01', 'Monday', 'mentions guitar once'),
      E('title', '2009-01-01', 'Guitar', 'new strings'),
    ];
    expect(urls(ns.search(rs, 'guitar', 'all', 'relevance'))[0]).toBe('title');
  });

  it('matches nothing for an empty query', () => {
    expect(ns.search([E('a', '2004-01-01', '', 'x')], '   ', 'all', 'relevance')).toEqual([]);
  });
});

describe('snippets', () => {
  const ns = engine();

  // catches: highlight offsets computed in the FOLDED text and applied to the
  // original — wherever folding changes length (a ligature splits, an accent
  // drops), every mark after it lands shifted onto the wrong letters.
  it('marks the original characters where folding changed the length', () => {
    const text = 'ﬁne ﬁne and then the final word';
    expect(marked(ns.snippet(text, ns.terms('final')))).toEqual(['final']);
    expect(marked(ns.snippet(text, ns.terms('fine')))).toEqual(['ﬁne', 'ﬁne']);
    expect(marked(ns.snippet('Ça va, café', ns.terms('cafe')))).toEqual(['café']);
  });

  // catches: the snippet window losing or duplicating text at its seams.
  it('reassembles to a contiguous slice of the original', () => {
    const text = 'one two three four five six seven eight nine ten';
    const joined = ns
      .snippet(text, ns.terms('five'), 1000)
      .map((s) => s.text)
      .join('');
    expect(joined).toBe(text);
  });

  it('windows a long body around the first match', () => {
    const text = 'filler '.repeat(200) + 'needle here' + ' filler'.repeat(200);
    const segs = ns.snippet(text, ns.terms('needle'), 120);
    expect(segs[0]!.text).toBe('…');
    expect(marked(segs)).toEqual(['needle']);
    expect(segs.map((s) => s.text).join('').length).toBeLessThan(130);
  });
});

describe('search/data.js', () => {
  // catches: data that a file:// page can't load. It has to be a plain script
  // assigning a global — the one mechanism every engine allows — and survive
  // text that looks like script.
  it('evaluates as a classic script to the records it was given', () => {
    const recs: SearchRecord[] = [E('entries/1.html', '2004-01-01', 't', 'a </script> b   c')];
    const window: { NEO_SEARCH?: unknown } = {};
    runInNewContext(searchDataJs(recs), { window });
    expect(window.NEO_SEARCH).toEqual(recs);
  });
});
