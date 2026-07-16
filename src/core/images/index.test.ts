import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localizeImages } from './index.js';
import { Store } from '../store/db.js';
import { Secret } from '../secret.js';
import type { Config } from '../config.js';

/**
 * The wiring, end to end: bodies in the store -> extract -> download -> classify.
 *
 * Oracle: a stub host set chosen adversarially (DESIGN.md §10). The individual
 * pieces are covered elsewhere; this is about whether they're connected right —
 * which the real run showed is a separate question from whether they work.
 */

const PNG = (w: number, h: number): Uint8Array => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  Buffer.from([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(b, 8);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
};
const RANSOM = new TextEncoder().encode('<!DOCTYPE html><html>Upgrade your account</html>');

const config = (outputDir: string): Config => ({
  username: 'testuser',
  passwordMd5: new Secret(''),
  outputDir,
  requestDelayMs: 0,
  imageConcurrency: 4,
  imageTimeoutMs: 100,
});

/** An entry body with the given HTML, itemid 1, ditemid 256. */
function seed(store: Store, html: string, commentHtml?: string): void {
  store.putEntries([
    {
      itemid: 1,
      anum: 0,
      ditemid: 256,
      eventtime: '2004-01-01 00:00:00',
      logtime: undefined,
      subject: undefined,
      body: html,
      security: 'private',
      allowmask: undefined,
      mood: undefined,
      moodid: undefined,
      music: undefined,
      location: undefined,
      pictureKeyword: undefined,
      tags: [],
      props: {},
    },
  ]);
  if (commentHtml !== undefined) {
    store.putUsers([{ posterid: 7, username: 'commenter1' }]);
    store.putCommentBodies([
      {
        id: 1,
        jitemid: 1,
        parentid: undefined,
        posterid: 7,
        subject: undefined,
        body: commentHtml,
        date: '2004-01-02T00:00:00Z',
        state: 'A',
      },
    ]);
  }
}

function stub(routes: Record<string, () => Response>): typeof fetch {
  return (async (url: string | URL) => {
    const r = routes[String(url)];
    if (!r) throw new Error('getaddrinfo ENOTFOUND');
    return r();
  }) as unknown as typeof fetch;
}

const run = (store: Store, dir: string, fetchImpl: typeof fetch) =>
  localizeImages(config(dir), { store, fetchImpl, sleepImpl: async () => {} });

describe('localizeImages — wiring', () => {
  it('extracts, fetches and stores a real image', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<img src="http://h1.invalid/a.png">');
    const stats = await run(
      store,
      dir,
      stub({ 'http://h1.invalid/a.png': () => new Response(PNG(800, 600)) }),
    );
    expect(stats.blobs).toBe(1);
    expect(stats.deadRefs).toBe(0);
  });

  // catches: images inside comments being skipped. 107 comments in the real
  // archive carry images — they're as much the journal as the entries are (§3).
  it('scans comment bodies, not just entries', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<p>no images here</p>', '<img src="http://h1.invalid/c.png">');
    const stats = await run(
      store,
      dir,
      stub({ 'http://h1.invalid/c.png': () => new Response(PNG(400, 300)) }),
    );
    expect(stats.blobs).toBe(1);
    const rows = store.query('SELECT context FROM asset_refs') as { context: string }[];
    expect(rows[0]?.context).toBe('comment');
  });

  // catches: relative URLs resolved against nothing, or against the wrong page.
  // A comment's images resolve against the ENTRY's permalink — a comment has no
  // page of its own.
  it('resolves a relative URL in a comment against its entry permalink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<p>x</p>', '<img src="pic.gif">');
    await run(store, dir, stub({}));
    const rows = store.query('SELECT source_url AS u FROM asset_refs') as { u: string }[];
    expect(rows[0]?.u).toBe('https://testuser.livejournal.com/pic.gif');
  });

  // catches: a dead host aborting the whole stage. Half the corpus is expected
  // to fail; the run must finish and record why (§9).
  it('finishes when most hosts are gone, recording why', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<img src="http://gone.invalid/a.png"><img src="http://h1.invalid/b.png">');
    const stats = await run(
      store,
      dir,
      stub({ 'http://h1.invalid/b.png': () => new Response(PNG(50, 50)) }),
    );
    expect(stats.blobs).toBe(1);
    expect(stats.deadRefs).toBe(1);
    const dead = store.query('SELECT error FROM asset_refs WHERE hash IS NULL') as {
      error: string;
    }[];
    expect(dead[0]?.error).toBeTruthy();
  });

  // catches: an HTML ransom page stored as an image. The real archive hit this
  // 33 times — a status-code check would have archived 33 web pages as photos.
  it('does not store an HTML page served at 200 from an image URL', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<img src="http://dead.invalid/photo.jpg">');
    const stats = await run(
      store,
      dir,
      stub({
        'http://dead.invalid/photo.jpg': () =>
          new Response(RANSOM, { headers: { 'content-type': 'image/jpeg' } }),
      }),
    );
    expect(stats.blobs).toBe(0);
    expect(stats.deadRefs).toBe(1);
  });

  // catches: host collapse not being wired to the store. Detection working in
  // isolation is worth nothing if nothing ever marks the blob.
  it('marks a collapsed host as poison, keeping the bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    const placeholder = PNG(120, 60);
    const urls = Array.from({ length: 8 }, (_, i) => `http://ransom.invalid/p${i}.jpg`);
    seed(store, urls.map((u) => `<img src="${u}">`).join(''));

    const routes: Record<string, () => Response> = {};
    for (const u of urls) routes[u] = () => new Response(placeholder);

    const stats = await run(store, dir, stub(routes));
    expect(stats.poison).toBe(1);
    // The bytes stay: a verdict is a flag, not a deletion (§5.2).
    const rows = store.query("SELECT local_path FROM assets WHERE status='poison'") as {
      local_path: string;
    }[];
    expect(rows[0]?.local_path).toBeTruthy();
  });

  // catches: a re-run re-downloading the world, or duplicating rows (§4.5).
  it('is idempotent: a second run fetches nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-'));
    const store = Store.openMemory();
    seed(store, '<img src="http://h1.invalid/a.png">');
    let fetches = 0;
    const impl = (async () => {
      fetches++;
      return new Response(PNG(10, 10));
    }) as unknown as typeof fetch;

    const first = await run(store, dir, impl);
    const second = await run(store, dir, impl);
    expect(fetches).toBe(1);
    expect(second).toEqual(first);
  });
});
