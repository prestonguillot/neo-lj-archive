import { describe, it, expect, vi } from 'vitest';
import { LjClient, BannedError } from './client.js';
import { Secret } from '../secret.js';

/**
 * The oracle here is LJ's documented error policy (DESIGN.md §9), exercised
 * against a stub `fetch`. No network, no clock — the retry behaviour is the
 * thing under test, and a real one would make it slow and flaky.
 */

const CHALLENGE = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
  <member><name>challenge</name><value><string>c0:1:2:60:abc:def</string></value></member>
</struct></value></param></params></methodResponse>`;

const OK = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
  <member><name>username</name><value><string>testuser</string></value></member>
</struct></value></param></params></methodResponse>`;

const reply = (status: number, body = ''): Response =>
  new Response(body, { status, statusText: String(status) });

interface Harness {
  client: LjClient;
  calls: () => number;
  sleeps: () => { ms: number; reason: string }[];
}

/** `responses` is consumed one per HTTP attempt, in order. */
function harness(responses: (() => Response)[], maxRetries = 3): Harness {
  let i = 0;
  const sleeps: { ms: number; reason: string }[] = [];
  const fetchImpl = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    return next!();
  }) as unknown as typeof fetch;

  const client = new LjClient({
    username: 'testuser',
    passwordMd5: new Secret('deadbeef'),
    requestDelayMs: 2000,
    maxRetries,
    fetchImpl,
    sleepImpl: async (ms, reason) => {
      sleeps.push({ ms, reason });
    },
  });
  return { client, calls: () => i, sleeps: () => sleeps };
}

describe('LjClient — error policy (§9)', () => {
  // catches: 403 treated as a transient error and retried. LJ's 403 IS the ban.
  // ArchiveTeam documents month-long ones, and hammering a banned endpoint
  // deepens it. This is the one failure where retrying does real, lasting harm.
  it('stops immediately on 403 and never retries', async () => {
    const h = harness([() => reply(403)]);
    await expect(h.client.login()).rejects.toThrow(BannedError);
    // Exactly one attempt: the getchallenge call. No retry, no second request.
    expect(h.calls()).toBe(1);
  });

  it('explains that a 403 is a ban rather than a hiccup', async () => {
    const h = harness([() => reply(403)]);
    await expect(h.client.login()).rejects.toThrow(/ban/i);
  });

  // catches: retrying forever on 5xx, or not retrying at all. Bounded backoff:
  // LJ deserves a few tries, not a hammering.
  it('retries 5xx with bounded exponential backoff', async () => {
    const h = harness([() => reply(500)], 3);
    await expect(h.client.login()).rejects.toThrow(/HTTP 500/);

    // 4 attempts (initial + 3 retries), then gives up.
    expect(h.calls()).toBe(4);
    // Backoff grows and stops — not a fixed retry, not unbounded.
    const backoffs = h
      .sleeps()
      .filter((s) => s.reason === 'backoff')
      .map((s) => s.ms);
    expect(backoffs).toEqual([1000, 2000, 4000]);
  });

  // catches: a 4xx (bad request, gone) retried as if transient. Only 5xx and
  // network faults are worth a second try; a 404 will 404 again.
  it('does not retry a non-403 4xx', async () => {
    const h = harness([() => reply(404)]);
    await expect(h.client.login()).rejects.toThrow(/HTTP 404/);
    expect(h.calls()).toBe(1);
  });

  it('recovers when a 5xx is followed by success', async () => {
    let n = 0;
    const h = harness([
      () => {
        n++;
        if (n === 1) return reply(500);
        if (n === 2) return reply(200, CHALLENGE);
        return reply(200, OK);
      },
    ]);
    await expect(h.client.login()).resolves.toContain('testuser');
  });
});

describe('LjClient — pacing (§5.1)', () => {
  // catches: no delay between requests. The whole journal is ~40 requests, so
  // politeness is free — and the alternative is a month-long ban.
  it('waits between consecutive requests', async () => {
    const h = harness([() => reply(200, CHALLENGE), () => reply(200, OK)]);
    await h.client.login();
    // First request is immediate; the second waits out the configured delay.
    const paces = h.sleeps().filter((s) => s.reason === 'pace');
    expect(paces.length).toBeGreaterThan(0);
    for (const p of paces) expect(p.ms).toBeLessThanOrEqual(2000);
  });
});

describe('LjClient — scope (§3)', () => {
  // catches: fetching community entries. The account can post to nine
  // communities; those entries live in the community's journal, not Preston's,
  // and §3 scopes them out. ljdump supports this path — we deliberately don't.
  it('refuses to send usejournal', async () => {
    const h = harness([() => reply(200, CHALLENGE)]);
    await expect(h.client.getEvents({ usejournal: 'some_community' })).rejects.toThrow(
      /usejournal/,
    );
  });

  it('sends getevents without usejournal normally', async () => {
    const h = harness([() => reply(200, CHALLENGE), () => reply(200, OK)]);
    await expect(h.client.getEvents({ selecttype: 'lastn', howmany: 5 })).resolves.toContain(
      'testuser',
    );
  });
});

describe('LjClient — credentials (§8)', () => {
  // catches: the password hash reaching a log, an error, or a request URL.
  // md5(password) is password-equivalent to LiveJournal — anyone holding it
  // authenticates indefinitely. There is nothing to crack.
  it('never renders the password hash, even in a thrown error', async () => {
    const h = harness([() => reply(403)]);
    const err = await h.client.login().catch((e: unknown) => e);
    const rendered = `${String(err)} ${JSON.stringify(err, Object.getOwnPropertyNames(err))}`;
    expect(rendered).not.toContain('deadbeef');
  });
});
