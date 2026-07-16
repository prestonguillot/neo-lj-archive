import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadAll, hostOf, blobPath } from './download.js';

/**
 * Oracle: a stub server with adversarially-chosen responses (DESIGN.md §10) —
 * chosen to be nasty, not to match the implementation. Real magic numbers,
 * because those are defined by the file formats.
 */

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03,
  0x20, 0, 0, 0x02, 0x58,
]);
const PNG2 = new Uint8Array([...PNG.slice(0, 20), 0, 0, 0x01, 0x90]);
const RANSOM = new TextEncoder().encode('<!DOCTYPE html><html>Upgrade your account</html>');

const out = () => mkdtempSync(join(tmpdir(), 'neolj-'));

/** Maps URL -> what the server does. Anything unmapped is a dead host. */
function server(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const impl = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    const r = routes[u];
    if (!r) throw new Error('getaddrinfo ENOTFOUND');
    return r();
  }) as unknown as typeof fetch;
  return { impl, calls: () => calls };
}

const bin = (b: Uint8Array, status = 200, type = 'image/png') =>
  new Response(b, { status, headers: { 'content-type': type } });

describe('downloadAll', () => {
  it('stores a real image content-addressed', async () => {
    const dir = out();
    const s = server({ 'http://h1.invalid/a.png': () => bin(PNG) });
    const [a] = await downloadAll(['http://h1.invalid/a.png'], {
      outputDir: dir,
      concurrency: 2,
      timeoutMs: 100,
      perHostDelayMs: 0,
      fetchImpl: s.impl,
      sleepImpl: async () => {},
    });

    expect(a?.status).toBe('ok');
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a?.localPath).toBe(blobPath(a!.hash!, 'png'));
    expect(existsSync(join(dir, a!.localPath!))).toBe(true);
    expect(readFileSync(join(dir, a!.localPath!)).equals(Buffer.from(PNG))).toBe(true);
    expect(a?.width).toBe(800);
  });

  // catches: content-addressing that isn't. Identical bytes at different URLs
  // MUST converge on one blob — that convergence is both the dedup and the
  // poison signal (§5.2). If it doesn't, neither works.
  it('converges identical bytes from different URLs onto one hash', async () => {
    const dir = out();
    const s = server({
      'http://h1.invalid/a.png': () => bin(PNG),
      'http://h2.invalid/b.png': () => bin(PNG),
      'http://h1.invalid/c.png': () => bin(PNG2),
    });
    const rs = await downloadAll(
      ['http://h1.invalid/a.png', 'http://h2.invalid/b.png', 'http://h1.invalid/c.png'],
      {
        outputDir: dir,
        concurrency: 2,
        timeoutMs: 100,
        perHostDelayMs: 0,
        fetchImpl: s.impl,
        sleepImpl: async () => {},
      },
    );
    const byUrl = new Map(rs.map((r) => [r.url, r.hash]));
    expect(byUrl.get('http://h1.invalid/a.png')).toBe(byUrl.get('http://h2.invalid/b.png'));
    expect(byUrl.get('http://h1.invalid/c.png')).not.toBe(byUrl.get('http://h1.invalid/a.png'));
  });

  // catches: a dead host stopping the run. HALF this corpus is expected to fail —
  // hosts gone for fifteen years. Failures are data (§9). The opposite of the LJ
  // fetcher, where one 403 must stop everything.
  it('records dead hosts and keeps going', async () => {
    const dir = out();
    const s = server({ 'http://alive.invalid/a.png': () => bin(PNG) });
    const rs = await downloadAll(
      ['http://gone.invalid/x.jpg', 'http://alive.invalid/a.png', 'http://alsogone.invalid/y.gif'],
      {
        outputDir: dir,
        concurrency: 3,
        timeoutMs: 100,
        perHostDelayMs: 0,
        maxRetries: 0,
        fetchImpl: s.impl,
        sleepImpl: async () => {},
      },
    );
    expect(rs).toHaveLength(3);
    expect(rs.filter((r) => r.status === 'ok')).toHaveLength(1);
    expect(rs.filter((r) => r.status === 'dead')).toHaveLength(2);
    for (const d of rs.filter((r) => r.status === 'dead')) expect(d.reason).toBeTruthy();
  });

  // catches: trusting HTTP 200. The Photobucket case, end to end: a ransom page
  // served at 200 with an image content-type from a .jpg URL. Nothing is stored.
  it('does not store an HTML ransom page served at 200 as an image', async () => {
    const dir = out();
    const s = server({
      'http://dead.invalid/photo.jpg': () => bin(RANSOM, 200, 'image/jpeg'),
    });
    const [a] = await downloadAll(['http://dead.invalid/photo.jpg'], {
      outputDir: dir,
      concurrency: 1,
      timeoutMs: 100,
      perHostDelayMs: 0,
      fetchImpl: s.impl,
      sleepImpl: async () => {},
    });
    expect(a?.status).toBe('dead');
    expect(a?.reason).toMatch(/HTML/);
    expect(a?.localPath).toBeUndefined();
    expect(a?.hash).toBeUndefined();
  });

  // catches: no retry on a flaky server, or retrying a 404 forever. 5xx might be
  // transient; 404 will 404 again.
  it('retries 5xx but not 404', async () => {
    const dir = out();
    let n = 0;
    const s = server({
      'http://flaky.invalid/a.png': () => (++n < 2 ? bin(new Uint8Array(0), 503) : bin(PNG)),
      'http://gone.invalid/b.png': () => bin(new Uint8Array(0), 404),
    });
    const rs = await downloadAll(['http://flaky.invalid/a.png', 'http://gone.invalid/b.png'], {
      outputDir: dir,
      concurrency: 2,
      timeoutMs: 100,
      perHostDelayMs: 0,
      maxRetries: 2,
      fetchImpl: s.impl,
      sleepImpl: async () => {},
    });
    expect(rs.find((r) => r.url.includes('flaky'))?.status).toBe('ok');
    expect(rs.find((r) => r.url.includes('gone'))?.status).toBe('dead');
    // flaky: 2 attempts. gone: exactly 1 — a 404 is final.
    expect(s.calls().filter((c) => c.includes('gone'))).toHaveLength(1);
  });

  // catches: hammering one wheezing server. Politeness is PER HOST — 142 images
  // from one 2005 box in parallel is rude and gets you blocked; but 161 hosts
  // shouldn't queue behind each other for no reason.
  it('paces per host, not globally', async () => {
    const dir = out();
    const sleeps: number[] = [];
    const s = server({
      'http://h1.invalid/1.png': () => bin(PNG),
      'http://h1.invalid/2.png': () => bin(PNG),
      'http://h1.invalid/3.png': () => bin(PNG),
      'http://h2.invalid/1.png': () => bin(PNG),
    });
    await downloadAll(
      [
        'http://h1.invalid/1.png',
        'http://h1.invalid/2.png',
        'http://h1.invalid/3.png',
        'http://h2.invalid/1.png',
      ],
      {
        outputDir: dir,
        concurrency: 4,
        timeoutMs: 100,
        perHostDelayMs: 250,
        fetchImpl: s.impl,
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
      },
    );
    // h1 has 3 images -> 2 waits between them. h2 has 1 -> none.
    expect(sleeps).toEqual([250, 250]);
  });

  it('reports each result as it lands, for progress', async () => {
    const dir = out();
    const seen: string[] = [];
    const s = server({ 'http://h1.invalid/a.png': () => bin(PNG) });
    await downloadAll(
      ['http://h1.invalid/a.png'],
      {
        outputDir: dir,
        concurrency: 1,
        timeoutMs: 100,
        perHostDelayMs: 0,
        fetchImpl: s.impl,
        sleepImpl: async () => {},
      },
      (a) => seen.push(a.url),
    );
    expect(seen).toEqual(['http://h1.invalid/a.png']);
  });
});

describe('hostOf', () => {
  it('lowercases the host so grouping is stable', () => {
    expect(hostOf('http://EXAMPLE.invalid/a.png')).toBe('example.invalid');
  });

  // catches: throwing on the unparseable URLs the extractor deliberately keeps
  // verbatim so a placeholder can name what was lost.
  it('returns undefined for an unparseable URL rather than throwing', () => {
    expect(hostOf('http://[nope')).toBeUndefined();
  });
});
