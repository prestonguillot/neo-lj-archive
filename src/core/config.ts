import type { Secret } from './secret.js';

/**
 * Everything core needs to run, passed in. Core reads no env vars, no argv, and
 * no config file — the shell resolves all of that and hands over this object
 * (DESIGN.md §15).
 */
export interface Config {
  /** The journal to archive. Always Preston's own — see `usejournal` below. */
  readonly username: string;

  /** Held in memory for the run, never written anywhere (DESIGN.md §8). */
  readonly passwordMd5: Secret;

  /** Where archive.db, blobs/, and site/ live. Gitignored (DESIGN.md §8). */
  readonly outputDir: string;

  /**
   * Delay between requests to LiveJournal. Deliberately slow: the whole journal
   * is ~40 requests (DESIGN.md §2), so politeness costs nothing and a 403 means
   * a month-long ban.
   */
  readonly requestDelayMs: number;

  /** Parallel image downloads. These hit third-party hosts, not LJ. */
  readonly imageConcurrency: number;

  /** Per-request timeout for third-party image hosts, many of which are dead. */
  readonly imageTimeoutMs: number;
}

export const DEFAULTS = {
  outputDir: './archive',
  requestDelayMs: 2000,
  imageConcurrency: 8,
  imageTimeoutMs: 15_000,
} as const satisfies Partial<Config>;

/**
 * Scope guard (DESIGN.md §3).
 *
 * `login` advertises posting access to nine communities. Preston's entries in
 * those live in the *community's* journal, not his, and are explicitly out of
 * scope. ljdump supports fetching them via `usejournal`; we never send it.
 *
 * This constant exists so the ban is greppable and testable rather than a
 * comment someone deletes in 2029.
 */
export const NEVER_SEND_USEJOURNAL = true;
