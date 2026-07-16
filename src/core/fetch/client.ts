import { createHash } from 'node:crypto';
import type { Secret } from '../secret.js';
import { decodeResponse, encodeRequest, type XmlRpcValue } from './xmlrpc.js';

/**
 * The HTTP half of the fetch layer: auth, pacing, and error policy.
 *
 * Core, so it never touches console/process — it takes an injectable `fetch` and
 * `sleep` so the error policy can be tested without a network or a real clock
 * (DESIGN.md §15).
 */

const XMLRPC_URL = 'https://www.livejournal.com/interface/xmlrpc';
const COMMENTS_URL = 'https://www.livejournal.com/export_comments.bml';
const CLIENT_VERSION = 'Node-neo-lj-archive/0.1';

/**
 * A 403 from LiveJournal means a ban — ArchiveTeam documents month-long ones.
 * Retrying makes it worse, so this is thrown to stop the run, never caught and
 * retried (DESIGN.md §9).
 */
export class BannedError extends Error {
  constructor() {
    super(
      'LiveJournal returned 403. That means a ban, not a hiccup — retrying deepens it. ' +
        'Stop, wait it out, and re-run later; the fetch resumes where it left off.',
    );
    this.name = 'BannedError';
  }
}

export class AuthError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AuthError';
  }
}

export interface ClientOptions {
  readonly username: string;
  readonly passwordMd5: Secret;
  /** Between every LJ request. The whole journal is ~40 requests (§2). */
  readonly requestDelayMs: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number, reason: SleepReason) => Promise<void>;
  readonly maxRetries?: number;
}

/**
 * Why we're waiting. Pacing and backoff are both sleeps of similar length but
 * mean opposite things — one is politeness we chose, the other is LJ failing —
 * and a caller (or a test) that can't tell them apart can't report or assert on
 * either.
 */
export type SleepReason = 'pace' | 'backoff';

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class LjClient {
  readonly #opts: Required<Omit<ClientOptions, 'fetchImpl' | 'sleepImpl'>> & {
    fetchImpl: typeof fetch;
    sleepImpl: (ms: number, reason: SleepReason) => Promise<void>;
  };
  #lastRequestAt = 0;

  constructor(opts: ClientOptions) {
    this.#opts = {
      username: opts.username,
      passwordMd5: opts.passwordMd5,
      requestDelayMs: opts.requestDelayMs,
      maxRetries: opts.maxRetries ?? 3,
      fetchImpl: opts.fetchImpl ?? fetch,
      sleepImpl: opts.sleepImpl ?? realSleep,
    };
  }

  /** Politeness. Free insurance at ~40 requests; the alternative is a ban. */
  async #pace(): Promise<void> {
    const since = Date.now() - this.#lastRequestAt;
    const wait = this.#opts.requestDelayMs - since;
    if (this.#lastRequestAt !== 0 && wait > 0) await this.#opts.sleepImpl(wait, 'pace');
    this.#lastRequestAt = Date.now();
  }

  /**
   * One HTTP attempt plus the retry policy.
   *
   * 403 → stop, never retry. 5xx → bounded exponential backoff. Everything else
   * → throw. §9.
   */
  async #send(url: string, init: RequestInit): Promise<string> {
    let lastErr: unknown;

    for (let attempt = 0; attempt <= this.#opts.maxRetries; attempt++) {
      await this.#pace();

      let res: Response;
      try {
        res = await this.#opts.fetchImpl(url, init);
      } catch (err) {
        // Network-level failure: retryable.
        lastErr = err;
        if (attempt === this.#opts.maxRetries) break;
        await this.#opts.sleepImpl(2 ** attempt * 1000, 'backoff');
        continue;
      }

      if (res.status === 403) throw new BannedError();
      if (res.ok) return await res.text();

      if (res.status >= 500) {
        lastErr = new Error(`LiveJournal returned HTTP ${res.status}`);
        if (attempt === this.#opts.maxRetries) break;
        await this.#opts.sleepImpl(2 ** attempt * 1000, 'backoff');
        continue;
      }

      throw new Error(`LiveJournal returned HTTP ${res.status}`);
    }

    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async #xmlrpc(
    method: string,
    params: Record<string, string | number> = {},
  ): Promise<XmlRpcValue> {
    const body = encodeRequest(method, params);
    const xml = await this.#send(XMLRPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'User-Agent': CLIENT_VERSION },
      body,
    });
    return decodeResponse(xml);
  }

  /**
   * Fresh challenge per request. They are single-use and expire in ~60s, so
   * there is no session to cache — settled by the spike, not assumed (§5.1).
   */
  async #auth(): Promise<Record<string, string | number>> {
    const chal = await this.#xmlrpc('LJ.XMLRPC.getchallenge');
    const challenge =
      chal !== null && typeof chal === 'object' && !Array.isArray(chal)
        ? String(chal['challenge'] ?? '')
        : '';
    if (!challenge) throw new AuthError('LiveJournal returned no challenge');

    return {
      username: this.#opts.username,
      auth_method: 'challenge',
      auth_challenge: challenge,
      auth_response: createHash('md5')
        .update(challenge + this.#opts.passwordMd5.reveal(), 'utf8')
        .digest('hex'),
      ver: 1,
      clientversion: CLIENT_VERSION,
    };
  }

  /**
   * `login` is also where LJ keeps the account's userpic list, but only if you
   * ask: without getpickws/getpickwurls it says nothing about them, which is
   * why the archive had no userpics at all rather than a bug losing them.
   */
  async login(opts: { getMoods?: boolean; getUserpics?: boolean } = {}): Promise<string> {
    const { getMoods = true, getUserpics = false } = opts;
    return this.#raw('LJ.XMLRPC.login', {
      ...(getMoods ? { getmoods: 0 } : {}),
      // Keywords and URLs are separate flags and both are needed: the keyword is
      // what an entry names its pic by, the URL is the only way to fetch it.
      ...(getUserpics ? { getpickws: 1, getpickwurls: 1 } : {}),
    });
  }

  /**
   * Fetch a slice of entries.
   *
   * NEVER passes `usejournal`. The account can post to nine communities and §3
   * scopes them out; those entries live in the community's journal, not
   * Preston's. Enforced by test.
   */
  async getEvents(params: Record<string, string | number>): Promise<string> {
    if ('usejournal' in params) {
      throw new Error('usejournal is out of scope (DESIGN.md §3) and must never be sent');
    }
    return this.#raw('LJ.XMLRPC.getevents', { lineendings: 'unix', ...params });
  }

  /** Mint a cookie session. Comment export is not XML-RPC and needs one. */
  async sessionGenerate(): Promise<Secret> {
    const res = await this.#xmlrpc('LJ.XMLRPC.sessiongenerate', {
      ...(await this.#auth()),
      expiration: 'short',
    });
    const value =
      res !== null && typeof res === 'object' && !Array.isArray(res)
        ? String(res['ljsession'] ?? '')
        : '';
    if (!value) throw new AuthError('LiveJournal returned no session');
    const { Secret: S } = await import('../secret.js');
    return new S(value);
  }

  /**
   * A page of comment export.
   *
   * `props` is deliberately never requested: it returns commenters' IP
   * addresses — 194 other people's — and §4 is "owner's content, owner's rules".
   */
  async exportComments(
    get: 'comment_meta' | 'comment_body',
    startid: number,
    session: Secret,
  ): Promise<string> {
    return this.#send(`${COMMENTS_URL}?get=${get}&startid=${startid}`, {
      headers: { Cookie: `ljsession=${session.reveal()}`, 'User-Agent': CLIENT_VERSION },
    });
  }

  /** Raw XML for the parsers, which are tested against captured bytes (§10). */
  async #raw(method: string, params: Record<string, string | number>): Promise<string> {
    const body = encodeRequest(method, { ...(await this.#auth()), ...params });
    return this.#send(XMLRPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml', 'User-Agent': CLIENT_VERSION },
      body,
    });
  }
}
