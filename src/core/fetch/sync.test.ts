import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sync } from './sync.js';
import { LjClient } from './client.js';
import { Store } from '../store/db.js';
import { Secret } from '../secret.js';
import { DEFAULTS, type Config } from '../config.js';

/**
 * The oracle is LJ's real captured pages, served by a stub `fetch` that answers
 * the way LiveJournal actually does — descending by logtime, each page spanning
 * years rather than a contiguous slice (DESIGN.md §10).
 *
 * That property is the whole point. An earlier version of syncEntries advanced
 * by the page's newest logtime, which on real data jumped to 2010 on page one
 * and terminated after 240 of ~1,500 entries — reporting success. Sixty-four
 * tests were green at the time, because they all replayed a single page. Only
 * running it caught that, so this is the test that would have.
 */

const fixture = (n: string): string =>
  readFileSync(new URL(`../../../tests/fixtures/${n}`, import.meta.url), 'utf8');

const CHALLENGE = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
  <member><name>challenge</name><value><string>c0:1:2:60:abc:def</string></value></member>
</struct></value></param></params></methodResponse>`;

const SESSION = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
  <member><name>ljsession</name><value><string>ws:test:1:abc</string></value></member>
</struct></value></param></params></methodResponse>`;

const EMPTY_EVENTS = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
  <member><name>events</name><value><array><data></data></array></value></member>
</struct></value></param></params></methodResponse>`;

const EMPTY_COMMENTS = `<?xml version="1.0"?><livejournal><comments></comments></livejournal>`;

const config = (): Config => ({
  username: 'testuser',
  passwordMd5: new Secret('deadbeef'),
  outputDir: '/tmp/unused',
  requestDelayMs: 0,
  imageConcurrency: DEFAULTS.imageConcurrency,
  imageTimeoutMs: DEFAULTS.imageTimeoutMs,
});

/**
 * Serves the two real getevents captures as a backwards walk, the way LJ does:
 * Thresholds are the fixtures' real EVENTTIME bounds, because that is what LJ's
 * beforedate filters on — not logtime. Using the logtime boundary here made the
 * stub hand back page one forever and failed correct code:
 *
 *   no beforedate           -> 2010 page (eventtime 2009-08-28 .. 2010-09-07)
 *   before > 2009-08-28 ... -> still inside that page's range, so LJ returns it again
 *   before > 2004-05-09 ... -> the 2004 page (eventtime 2004-05-09 .. 2004-05-30)
 *   older                   -> empty
 */
function stubFetch(): { impl: typeof fetch; eventCalls: () => string[] } {
  const eventCalls: string[] = [];

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const body = String(init?.body ?? '');

    if (u.includes('export_comments.bml')) {
      if (u.includes('comment_meta')) return new Response(fixture('export-comment-meta.xml'));
      // One full body page, then empty — nextStartId stops on maxid anyway.
      return new Response(
        u.includes('startid=0') ? fixture('export-comment-body.xml') : EMPTY_COMMENTS,
      );
    }

    if (body.includes('getchallenge')) return new Response(CHALLENGE);
    if (body.includes('sessiongenerate')) return new Response(SESSION);
    if (body.includes('LJ.XMLRPC.login')) return new Response(fixture('login.xml'));

    if (body.includes('getevents')) {
      const before = /<name>beforedate<\/name>\s*<value>\s*<string>([^<]*)/.exec(body)?.[1];
      eventCalls.push(before ?? '(none)');
      // Model beforedate the way LJ does: return the newest page whose entries
      // actually precede the requested date. An earlier stub returned page two
      // for ANY beforedate past 2005, which meant a walk that wrongly jumped
      // FORWARD to 2010 still got handed page two and looked healthy. A stub
      // that can't say no can't catch the bug it exists for.
      if (before === undefined) return new Response(fixture('getevents-lastn.xml'));
      // Still inside the 2010 page's own range -> LJ hands back that same page.
      if (before > '2009-08-28 09:44:00') return new Response(fixture('getevents-lastn.xml'));
      if (before > '2004-05-09 01:32:00') return new Response(fixture('getevents-2004.xml'));
      return new Response(EMPTY_EVENTS);
    }

    throw new Error(`unexpected request: ${u}`);
  }) as unknown as typeof fetch;

  return { impl, eventCalls: () => eventCalls };
}

function harness(): {
  config: Config;
  deps: { client: LjClient; store: Store };
  calls: () => string[];
} {
  const { impl, eventCalls } = stubFetch();
  const client = new LjClient({
    username: 'testuser',
    passwordMd5: new Secret('deadbeef'),
    requestDelayMs: 0,
    fetchImpl: impl,
    sleepImpl: async () => {},
  });
  return { config: config(), deps: { client, store: Store.openMemory() }, calls: eventCalls };
}

describe('sync — entry paging (§5.1)', () => {
  // catches: advancing by the page's newest logtime. LJ returns entries
  // DESCENDING, each page spanning years, so the newest is on page one — the
  // next request asks for entries after it, gets nothing, and the walk stops.
  // On the real journal that fetched 240 of 1,547 entries and reported success.
  it('keeps walking backwards past the first page', async () => {
    const h = harness();
    const stats = await sync(h.config, h.deps);
    // Both captured pages, not just the first.
    expect(stats.entries).toBe(40);
  });

  // catches: the same bug from the other side. The walk must move BACKWARDS in
  // time; advancing by max logtime moves forward and terminates instantly.
  it('advances beforedate to the oldest entry seen, not the newest', async () => {
    const h = harness();
    await sync(h.config, h.deps);
    const calls = h.calls();
    expect(calls[0]).toBe('(none)');
    // The 2010 page's oldest eventtime — not its newest (2010-09-07).
    expect(calls[1]).toMatch(/^2009-/);
  });

  // catches: an infinite loop when a page yields nothing new — a boundary where
  // beforedate is inclusive, or several entries sharing an eventtime. Progress
  // is measured in new rows, so a repeated page terminates instead of spinning
  // against LJ forever, which is how you earn a ban.
  it('terminates when a page adds no new entries', async () => {
    const h = harness();
    await sync(h.config, h.deps);
    // page 1, page 2, then the empty one that stops it.
    expect(h.calls().length).toBeLessThanOrEqual(4);
  });
});

describe('sync — comments (§5.1)', () => {
  it('writes the index, the usermaps, and the bodies', async () => {
    const h = harness();
    const stats = await sync(h.config, h.deps);
    expect(stats.comments).toBe(6550);
    expect(stats.users).toBe(194);
  });

  // catches: fetching bodies before the index. comment_meta carries the usermaps
  // that comments.posterid references, and foreign keys are on — reversing the
  // order dies on live data.
  it('records commenters before the comments that reference them', async () => {
    const h = harness();
    await expect(sync(h.config, h.deps)).resolves.toBeDefined();
  });
});

describe('sync — resumability (§4.5)', () => {
  // catches: a re-run duplicating the archive or re-downloading the world.
  it('is idempotent: a second run changes nothing', async () => {
    const h = harness();
    const first = await sync(h.config, h.deps);
    const second = await sync(h.config, h.deps);
    expect(second).toEqual(first);
  });
});
