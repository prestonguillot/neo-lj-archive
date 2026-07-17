import { downloadAll } from './download.js';
import type { Store } from '../store/db.js';
import { silentReporter, type ProgressReporter } from '../progress.js';

/**
 * Download the userpics whose picid/userid the scrape recovered (DESIGN.md §3).
 *
 * Almost nothing happens here on purpose. downloadAll already fetches politely,
 * sniffs the bytes, content-addresses them and writes the blob; putAssetResult
 * already records it. A userpic is just another image, so it goes through the
 * same pipeline and inherits the same properties — including dedup for free,
 * which is why one pic reused across 400 comments is one blob on disk.
 *
 * Landing them in `assets` also means the build's copy-into-site step carries
 * them with no special case.
 *
 * Core, so no console and no process: progress goes through the reporter (§15).
 */

export interface UserpicStats {
  readonly known: number;
  readonly stored: number;
  readonly failed: number;
  readonly people: number;
}

export async function downloadUserpics(
  outputDir: string,
  deps: {
    store: Store;
    report?: ProgressReporter;
    timeoutMs?: number;
    // Injected, like every other stage: core must be testable without a network
    // (§15). Their absence here was a design bug — it made this stage impossible
    // to test at all, which is exactly why it shipped untested.
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  },
): Promise<UserpicStats> {
  const { store } = deps;
  const report = deps.report ?? silentReporter;

  // Only what we don't hold yet. Re-running must never re-fetch the world (§5.2).
  const pending = store.query(
    'SELECT picid, url FROM userpics WHERE hash IS NULL AND fetched_at IS NULL ORDER BY picid',
  ) as { picid: number; url: string }[];

  report({ kind: 'start', task: 'userpics', total: pending.length });
  if (pending.length === 0) {
    report({ kind: 'done', task: 'userpics', summary: 'nothing new to fetch' });
    return statsFor(store);
  }

  const picidFor = new Map(pending.map((p) => [p.url, p.picid]));
  let done = 0;

  await downloadAll(
    pending.map((p) => p.url),
    {
      outputDir,
      // These all come from l-userpic.livejournal.com — ONE host — so downloadAll's
      // per-host queue makes this sequential whatever we pass. That's correct
      // here: a 403 from LiveJournal is terminal (§9) and these files are tiny.
      concurrency: 1,
      perHostDelayMs: 300,
      timeoutMs: deps.timeoutMs ?? 15_000,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.sleepImpl !== undefined ? { sleepImpl: deps.sleepImpl } : {}),
    },
    (a) => {
      done++;
      if (done % 10 === 0) report({ kind: 'tick', task: 'userpics', done });
      const picid = picidFor.get(a.url);
      if (picid === undefined) return;
      store.putAssetResult({ ...a, reason: a.reason });
      // fetched_at is set either way, so a pic that 404s is not retried forever.
      store.linkUserpicBlob(picid, a.hash);
    },
  );

  const s = statsFor(store);
  report({ kind: 'done', task: 'userpics', summary: `${s.stored} pics across ${s.people} people` });
  return s;
}

function statsFor(store: Store): UserpicStats {
  const n = (sql: string): number => (store.query(sql) as { n: number }[])[0]?.n ?? 0;
  return {
    known: n('SELECT COUNT(*) AS n FROM userpics'),
    stored: n('SELECT COUNT(*) AS n FROM userpics WHERE hash IS NOT NULL'),
    failed: n('SELECT COUNT(*) AS n FROM userpics WHERE hash IS NULL AND fetched_at IS NOT NULL'),
    people: n('SELECT COUNT(DISTINCT userid) AS n FROM userpics'),
  };
}
