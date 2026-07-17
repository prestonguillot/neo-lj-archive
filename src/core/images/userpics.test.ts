import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/db.js';
import { downloadUserpics } from './userpics.js';

/**
 * The userpic stage (DESIGN.md §3, §10).
 *
 * This shipped with no tests at all, and worse, with no fetchImpl to inject —
 * so it could not have been tested without hitting LiveJournal. Both are fixed
 * here. The properties below are the ones the stage exists for; the examples are
 * secondary.
 */

/**
 * Real PNG/GIF headers at a plausible userpic size.
 *
 * NOT 1x1: classifyBytes correctly treats a 1x1 image as a dead tracking pixel,
 * so a 1x1 fixture is rejected by the pipeline and the test fails for a reason
 * that has nothing to do with userpics. Real LJ userpics are up to 100x100.
 */
const PNG = (w: number, h: number): Uint8Array => {
  const b = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  Buffer.from([0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]).copy(b, 8);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return new Uint8Array(b);
};
/** A GIF header — a DIFFERENT format, to prove the type comes from the bytes. */
const GIF = (w: number, h: number): Uint8Array => {
  const b = Buffer.alloc(13);
  Buffer.from('GIF89a').copy(b, 0);
  b.writeUInt16LE(w, 6);
  b.writeUInt16LE(h, 8);
  return new Uint8Array(b);
};

const url = (picid: number): string => `https://l-userpic.livejournal.com/${picid}/1403367`;

function seed(store: Store, pics: [number, number][]): void {
  for (const [picid, userid] of pics) {
    store.query(
      'INSERT INTO userpics (picid, userid, url) VALUES (?, ?, ?)',
      picid,
      userid,
      url(picid),
    );
  }
}

const stub =
  (routes: Record<string, () => Response>): typeof fetch =>
  (input: unknown) => {
    const u = String(input);
    const r = routes[u];
    return Promise.resolve(r ? r() : new Response('nope', { status: 404 }));
  };

const run = async (
  store: Store,
  dir: string,
  fetchImpl: typeof fetch,
): ReturnType<typeof downloadUserpics> =>
  downloadUserpics(dir, { store, fetchImpl, sleepImpl: async () => {} });

const tmp = (): string => mkdtempSync(join(tmpdir(), 'neolj-up-'));

describe('downloadUserpics', () => {
  it('stores a pic and links it to its picid', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    seed(store, [[11, 1403367]]);
    const stats = await run(store, dir, stub({ [url(11)]: () => new Response(PNG(100, 100)) }));
    expect(stats.stored).toBe(1);
    const row = store.query('SELECT hash, fetched_at FROM userpics WHERE picid=11') as {
      hash: string | null;
      fetched_at: string | null;
    }[];
    expect(row[0]?.hash).toBeTruthy();
    expect(row[0]?.fetched_at).toBeTruthy();
  });

  // THE property this stage exists for. The author called it out early — "userpic
  // dedup obvious" — and it is only obvious because the pipeline is
  // content-addressed. One pic reused across 400 comments must be ONE blob.
  it('invariant: identical bytes converge on one blob however many pics point at them', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    // Three DIFFERENT picids for three different people, same image bytes.
    seed(store, [
      [1, 100],
      [2, 200],
      [3, 300],
    ]);
    await run(
      store,
      dir,
      stub({
        [url(1)]: () => new Response(PNG(100, 100)),
        [url(2)]: () => new Response(PNG(100, 100)),
        [url(3)]: () => new Response(PNG(100, 100)),
      }),
    );
    const hashes = store.query('SELECT DISTINCT hash FROM userpics WHERE hash IS NOT NULL') as {
      hash: string;
    }[];
    expect(hashes).toHaveLength(1);
    const blobs = store.query("SELECT COUNT(*) AS n FROM assets WHERE status='ok'") as {
      n: number;
    }[];
    expect(blobs[0]?.n).toBe(1);
  });

  // catches: a dead pic being retried on every run, forever. fetched_at is the
  // record of having TRIED, which is not the same as having succeeded.
  it('invariant: a pic that is gone is recorded as tried, not retried forever', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    seed(store, [[9, 100]]);
    const stats = await run(store, dir, stub({})); // everything 404s
    expect(stats.stored).toBe(0);
    expect(stats.failed).toBe(1);

    // A second run must not ask for it again.
    let asked = 0;
    await downloadUserpics(dir, {
      store,
      sleepImpl: async () => {},
      fetchImpl: () => {
        asked++;
        return Promise.resolve(new Response('nope', { status: 404 }));
      },
    });
    expect(asked).toBe(0);
  });

  // catches: re-fetching the world on every run. The archive is re-runnable by
  // design (§5.2) and a stage that ignores that is a stage that gets you banned.
  it('invariant: a pic already held is never fetched again', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    seed(store, [[7, 100]]);
    await run(store, dir, stub({ [url(7)]: () => new Response(PNG(100, 100)) }));

    let asked = 0;
    await downloadUserpics(dir, {
      store,
      sleepImpl: async () => {},
      fetchImpl: () => {
        asked++;
        return Promise.resolve(new Response(PNG(100, 100)));
      },
    });
    expect(asked).toBe(0);
  });

  // catches: trusting the URL for the file type. LJ serves gif, png and jpeg from
  // the same extensionless path, so the extension can only come from the bytes.
  it('invariant: the type is sniffed from the bytes, never guessed from the url', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    seed(store, [
      [1, 100],
      [2, 200],
    ]);
    await run(
      store,
      dir,
      stub({
        [url(1)]: () => new Response(PNG(100, 100)),
        [url(2)]: () => new Response(GIF(100, 100)),
      }),
    );
    const rows = store.query(
      "SELECT mime, local_path FROM assets WHERE status='ok' ORDER BY mime",
    ) as { mime: string; local_path: string }[];
    expect(rows.map((r) => r.mime)).toEqual(['image/gif', 'image/png']);
    // And the extension on disk follows the sniffed type, not the URL.
    expect(rows[0]?.local_path.endsWith('.gif')).toBe(true);
    expect(rows[1]?.local_path.endsWith('.png')).toBe(true);
    for (const r of rows) expect(existsSync(join(dir, r.local_path))).toBe(true);
  });

  // catches: a stage that does work when there is none, or throws on an empty set.
  it('does nothing, quietly, when every pic is already held', async () => {
    const store = Store.openMemory();
    const dir = tmp();
    const stats = await run(store, dir, stub({}));
    expect(stats.known).toBe(0);
    expect(stats.stored).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });
});
