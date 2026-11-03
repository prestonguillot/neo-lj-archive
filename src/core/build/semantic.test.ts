import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/db.js';
import { buildSite } from './index.js';
import { Secret } from '../secret.js';
import { MODEL } from '../embed/index.js';
import type { ProgressEvent } from '../progress.js';
import { tinyPack, tinyEmbedder } from '../../../tests/support/tiny-model.js';

/**
 * Search by meaning is OPTIONAL (DESIGN.md §7.4): the build never computes a
 * vector unless handed an embedder, ships the browser files only when every
 * passage has one, and otherwise leaves the search page as it always was.
 */
let dir: string;
const config = () => ({
  username: 'testuser',
  passwordMd5: new Secret(''),
  outputDir: dir,
  requestDelayMs: 0,
  imageConcurrency: 1,
  imageTimeoutMs: 1000,
});
const entry = (itemid: number, body: string) => ({
  itemid,
  anum: 0,
  ditemid: itemid * 256,
  eventtime: `2004-03-${String(itemid).padStart(2, '0')} 21:30:00`,
  logtime: undefined,
  subject: `Entry ${itemid}`,
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
const site = (rel: string) => join(dir, 'site', rel);
const searchPage = () => readFileSync(site('search/index.html'), 'utf8');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'neolj-sem-'));
  const s = Store.open(dir);
  s.putEntries([entry(1, 'chips and pretzels'), entry(2, 'the snack table, with everything')]);
  s.close();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function build(embed?: ReturnType<typeof deps>, events?: ProgressEvent[]) {
  const store = Store.open(dir);
  try {
    return await buildSite(config(), {
      store,
      ...(events ? { report: (e: ProgressEvent) => events.push(e) } : {}),
      ...(embed ? { embed } : {}),
    });
  } finally {
    store.close();
  }
}
function deps() {
  const pack = { ...tinyPack(), name: MODEL.name };
  const t = tinyEmbedder(pack);
  let modelFetches = 0;
  return {
    embedder: t.embedder,
    model: async () => {
      modelFetches++;
      return { pack, source: 'test' };
    },
    calls: t.calls,
    fetches: () => modelFetches,
  };
}

describe('search by meaning is optional', () => {
  // catches: the semantic files or toggle leaking into a build that never asked
  // for them — the page would load scripts that aren't there (a console error
  // on every visit) or offer a checkbox that can't work.
  it('without an embedder or stored vectors, the search page is keyword-only', async () => {
    const stats = await build();
    expect(stats.semantic.shipped).toBe(false);
    for (const f of ['bert.js', 'model.js', 'vectors.js'])
      expect(existsSync(site(`search/${f}`))).toBe(false);
    expect(searchPage()).not.toContain('id="meaning"');
    expect(searchPage()).not.toContain('bert.js');
  });

  it('with an embedder, every passage gets a vector and the page offers meaning', async () => {
    const d = deps();
    const stats = await build(d);
    expect(stats.semantic).toEqual({ passages: 2, embedded: 2, shipped: true });
    for (const f of ['bert.js', 'model.js', 'vectors.js'])
      expect(existsSync(site(`search/${f}`))).toBe(true);
    expect(searchPage()).toContain('id="meaning"');
  });

  // catches: vectors computed on every build. They live in archive.db and are
  // keyed by passage text, so a rebuild — with or without --embed — must reuse
  // them and never ask the model again.
  it('stores vectors and the model in archive.db, and reuses them', async () => {
    const first = deps();
    await build(first);
    expect(first.calls()).toBe(2);
    expect(first.fetches()).toBe(1);

    const again = deps();
    await build(again);
    expect(again.calls()).toBe(0);
    expect(again.fetches()).toBe(0);

    const plain = await build(); // no embedder at all
    expect(plain.semantic.shipped).toBe(true);
  });

  // catches: an edit leaving a stale vector in place, or re-embedding the world.
  // Only the changed passage is new, so only it is embedded.
  it('re-embeds only a passage whose text changed', async () => {
    await build(deps());
    const s = Store.open(dir);
    s.putEntries([entry(2, 'a different snack now')]);
    s.close();

    const events: ProgressEvent[] = [];
    const stale = await build(undefined, events);
    expect(stale.semantic).toEqual({ passages: 2, embedded: 1, shipped: false });
    // Partial coverage ships nothing, and says why.
    // …and the earlier build's files don't linger, unused, at ~35 MB.
    expect(existsSync(site('search/vectors.js'))).toBe(false);
    expect(searchPage()).not.toContain('vectors.js');
    expect(events.some((e) => e.kind === 'warn' && /--embed/.test(e.message))).toBe(true);

    const d = deps();
    await build(d);
    expect(d.calls()).toBe(1);
  });
});
