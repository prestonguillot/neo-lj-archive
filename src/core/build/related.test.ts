import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { relatedEntries, tokens, type RelatedDoc } from './related.js';
import { renderBody, RENDERER_TEXT_CLASSES } from './render.js';
import { textOf } from './search.js';
import { buildSite } from './index.js';
import { Store } from '../store/db.js';
import { Secret } from '../secret.js';

/**
 * Related entries (DESIGN.md §7.5). Every corpus here is hand-built so the right
 * answer is obvious to a reader without running anything (§10).
 */

const doc = (id: number, text: string, tags: string[] = []): RelatedDoc => ({ id, text, tags });
const ids = (m: Map<number, { id: number }[]>, id: number): number[] =>
  (m.get(id) ?? []).map((r) => r.id);

// Filler so df stays meaningful: terms in over half the corpus are ignored, so a
// four-entry corpus can't test anything. These share nothing with each other.
const filler = (from: number): RelatedDoc[] =>
  [
    'gardening tomatoes compost trellis',
    'taxes paperwork accountant receipts',
    'dentist appointment cavity filling',
    'snowboarding tahoe lift tickets',
    'birthday cake candles frosting',
    'laundry detergent dryer lint',
  ].map((t, i) => doc(from + i, t));

describe('relatedEntries', () => {
  // catches: an entry related to itself — its own cosine is 1.0, so without the
  // self-skip every list would open with a link back to the page you're on.
  it('never relates an entry to itself', () => {
    const rs = relatedEntries([
      doc(1, 'warfield concert dragonforce encore'),
      doc(2, 'warfield concert dragonforce encore'),
      ...filler(10),
    ]);
    for (const [id, list] of rs) expect(list.map((r) => r.id)).not.toContain(id);
    expect(ids(rs, 1)).toEqual([2]);
  });

  // catches: IDF missing. Without it, two entries that share the journal's
  // everyday words outrank two that share a rare name — the name is the signal.
  it('ranks a shared rare name above shared everyday words', () => {
    const everyday = 'tonight work tired sleep coffee';
    const rs = relatedEntries([
      doc(1, `${everyday} cassie picayune`),
      doc(2, `cassie picayune hospital`),
      doc(3, `${everyday} bus`),
      doc(4, `${everyday} rain`),
      doc(5, `${everyday} movie`),
      ...filler(10),
    ]);
    expect(ids(rs, 1)[0]).toBe(2);
  });

  // catches: vectors not normalised. A huge entry containing every word scores
  // highest against everything by sheer volume, and becomes everyone's "related".
  it("doesn't let one long entry relate to everything", () => {
    const pairs = [
      ['benadryl sinus dreams', 'benadryl sinus pharmacy'],
      ['warfield dragonforce encore', 'warfield dragonforce tickets'],
      ['picayune deadline editor', 'picayune deadline printer'],
    ];
    const docs = pairs.flatMap(([a, b], i) => [doc(i * 2 + 1, a!), doc(i * 2 + 2, b!)]);
    const everything = doc(99, Array(20).fill(pairs.flat().join(' ')).join(' '));
    const rs = relatedEntries([...docs, everything, ...filler(10)]);
    for (let i = 0; i < pairs.length; i++) {
      expect(ids(rs, i * 2 + 1)[0]).toBe(i * 2 + 2);
    }
  });

  // catches: one coincidental word making a link. Two entries whose only overlap
  // is one word are not related, however rare the word.
  it('needs at least two shared words', () => {
    const rs = relatedEntries([
      doc(1, 'zeppelin alpha beta'),
      doc(2, 'zeppelin gamma delta'),
      doc(3, 'zeppelin'),
      ...filler(10),
    ]);
    expect(ids(rs, 1)).toEqual([]);
    expect(ids(rs, 2)).toEqual([]);
  });

  // catches: a tag counting for no more than a passing word. Two entries tagged
  // the same thing say outright they're about it.
  it('counts a shared tag as a shared word', () => {
    const rs = relatedEntries([
      doc(1, 'drove north', ['road trip', 'oregon']),
      doc(2, 'slept in the car', ['road trip', 'oregon']),
      ...filler(10),
    ]);
    expect(ids(rs, 1)).toEqual([2]);
  });

  // catches: ties ordered by Map iteration instead of id — the same archive.db
  // would build different bytes depending on input order.
  it('breaks ties by id, whatever order entries arrive in', () => {
    const same = 'warfield dragonforce encore';
    const forward = relatedEntries([doc(1, same), doc(2, same), doc(3, same), ...filler(10)]);
    const backward = relatedEntries([...filler(10), doc(3, same), doc(2, same), doc(1, same)]);
    expect(ids(forward, 1)).toEqual([2, 3]);
    expect(ids(backward, 1)).toEqual([2, 3]);
  });

  it('explains each link with words both entries hold', () => {
    const rs = relatedEntries([
      doc(1, 'warfield dragonforce encore'),
      doc(2, 'warfield dragonforce tickets'),
      ...filler(10),
    ]);
    expect([...(rs.get(1)?.[0]?.why ?? [])].sort()).toEqual(['dragonforce', 'warfield']);
  });
});

describe('tokens', () => {
  // catches: the same word counted as two because of case, accents, or an
  // apostrophe — "Café"/"cafe" and "Cassie's"/"Cassie’s" must meet.
  it('folds case, accents, and apostrophes', () => {
    expect(tokens("Café CAFE cafe Cassie's Cassie\u2019s")).toEqual([
      'cafe',
      'cafe',
      'cafe',
      'cassies',
      'cassies',
    ]);
  });
});

describe("what counts as the author's words", () => {
  // catches: renderer boilerplate relating entries. "▶ Watch on YouTube" and the
  // lost-image marker are text WE wrote into every such entry, so unfiltered,
  // every video entry related to every other on "youtube, watch".
  it('leaves out text the renderer wrote', () => {
    const ctx = {
      localFor: () => undefined,
      deadReason: () => 'HTTP 404',
      username: 'testuser',
      entryHref: () => undefined,
      root: '../',
      embedUrl: () => ({ watch: 'https://www.youtube.com/watch?v=abc' }),
    };
    const html = renderBody(
      'My own words. <img src="http://photobucket.invalid/x.jpg"> <lj-embed id="1"> <lj-poll-12>',
      ctx,
    );
    const author = textOf(html, RENDERER_TEXT_CLASSES);
    expect(author).toBe('My own words.');
    // Search still sees everything the page shows.
    expect(textOf(html)).toMatch(/YouTube/);
    expect(textOf(html)).toMatch(/photobucket/);
  });
});

describe('related links in the built site', () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'neolj-related-'));
    const store = Store.openMemory();
    const entry = (itemid: number, ditemid: number, body: string) => ({
      itemid,
      anum: 0,
      ditemid,
      eventtime: `2004-03-${String(itemid).padStart(2, '0')} 21:30:00`,
      logtime: undefined,
      subject: undefined,
      body,
      security: 'public' as const,
      allowmask: undefined,
      mood: undefined,
      moodid: undefined,
      music: undefined,
      location: undefined,
      pictureKeyword: undefined,
      tags: [],
      props: {},
    });
    store.putEntries([
      entry(1, 101, 'saw dragonforce at the warfield last night'),
      entry(2, 202, 'still deaf from dragonforce at the warfield'),
      entry(3, 303, 'tomatoes in the garden'),
      entry(4, 404, 'paperwork for taxes'),
      entry(5, 505, 'dentist again'),
    ]);
    await buildSite(
      {
        username: 'testuser',
        passwordMd5: new Secret(''),
        outputDir: dir,
        requestDelayMs: 0,
        imageConcurrency: 1,
        imageTimeoutMs: 1000,
      },
      { store },
    );
    store.close();
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // catches: related hrefs built without the page's root — from entries/101.html
  // a bare "entries/202.html" resolves to entries/entries/202.html, nowhere.
  it('every related link resolves to an entry page that exists', () => {
    const entriesDir = join(dir, 'site', 'entries');
    let links = 0;
    for (const f of readdirSync(entriesDir)) {
      const html = readFileSync(join(entriesDir, f), 'utf8');
      const section = /<section class="related">([\s\S]*?)<\/section>/.exec(html)?.[1] ?? '';
      for (const [, href] of section.matchAll(/href="([^"]+)"/g)) {
        links++;
        expect(existsSync(join(entriesDir, href!)), `${f} -> ${href}`).toBe(true);
      }
    }
    expect(links).toBeGreaterThan(0);
  });

  it('links the two Warfield entries to each other', () => {
    const page = readFileSync(join(dir, 'site', 'entries', '101.html'), 'utf8');
    expect(page).toContain('href="../entries/202.html"');
  });
});
