import { downloadAll } from './download.js';
import type { Store } from '../store/db.js';
import { silentReporter, type ProgressReporter } from '../progress.js';

/**
 * Download a poster frame for each recovered video (DESIGN.md §3, §5.2).
 *
 * A YouTube player cannot load from file:// — it needs a valid referrer and
 * returns error 153 without one — so an offline archive cannot play the video
 * inline. The honest ceiling is a real poster frame (stored locally, so it shows
 * offline) that links out to the video. This fetches that poster.
 *
 * Like userpics, almost nothing happens here: downloadAll fetches, sniffs,
 * content-addresses and writes the blob; putAssetResult records it. A poster is
 * just another image.
 *
 * Core, so progress goes through the reporter, never stdout (§15).
 */

export interface EmbedThumbStats {
  readonly known: number;
  readonly stored: number;
  readonly failed: number;
}

/** img.youtube.com/vi/ID/hqdefault.jpg, from LJ's proxy URL. Null if not YouTube. */
export function youtubeThumb(proxyUrl: string): string | undefined {
  try {
    const u = new URL(proxyUrl);
    const vid = u.searchParams.get('vid');
    if (u.searchParams.get('source') === 'youtube' && vid !== null && vid !== '') {
      return `https://img.youtube.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg`;
    }
  } catch {
    /* malformed proxy URL — no poster */
  }
  return undefined;
}

export async function downloadEmbedThumbs(
  outputDir: string,
  deps: {
    store: Store;
    report?: ProgressReporter;
    timeoutMs?: number;
    fetchImpl?: typeof fetch;
    sleepImpl?: (ms: number) => Promise<void>;
  },
): Promise<EmbedThumbStats> {
  const { store } = deps;
  const report = deps.report ?? silentReporter;

  // Only YouTube embeds we haven't tried. Re-running never re-fetches (§5.2).
  const rows = store.query(
    'SELECT ditemid, idx, url FROM entry_embeds WHERE thumb_hash IS NULL AND fetched_at IS NULL',
  ) as { ditemid: number; idx: number; url: string }[];
  const pending = rows
    .map((r) => ({ ...r, thumb: youtubeThumb(r.url) }))
    .filter((r): r is typeof r & { thumb: string } => r.thumb !== undefined);

  report({ kind: 'start', task: 'video posters', total: pending.length });
  if (pending.length === 0) {
    report({ kind: 'done', task: 'video posters', summary: 'nothing new to fetch' });
    return statsFor(store);
  }

  // A poster can be shared by two entries embedding the same video, so one URL
  // maps to many (ditemid, idx). downloadAll dedups the fetch; we link them all.
  const targetsFor = new Map<string, { ditemid: number; idx: number }[]>();
  for (const p of pending) {
    targetsFor.set(p.thumb, [
      ...(targetsFor.get(p.thumb) ?? []),
      { ditemid: p.ditemid, idx: p.idx },
    ]);
  }
  let done = 0;

  await downloadAll(
    [...targetsFor.keys()],
    {
      outputDir,
      // img.youtube.com is one host; downloadAll paces per host regardless.
      concurrency: 1,
      perHostDelayMs: 200,
      timeoutMs: deps.timeoutMs ?? 15_000,
      ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.sleepImpl !== undefined ? { sleepImpl: deps.sleepImpl } : {}),
    },
    (a) => {
      done++;
      if (done % 5 === 0) report({ kind: 'tick', task: 'video posters', done });
      store.putAssetResult({ ...a, reason: a.reason });
      // fetched_at is stamped either way, so a 404 poster isn't retried forever.
      for (const t of targetsFor.get(a.url) ?? []) store.linkEmbedThumb(t.ditemid, t.idx, a.hash);
    },
  );

  const s = statsFor(store);
  report({ kind: 'done', task: 'video posters', summary: `${s.stored} posters` });
  return s;
}

function statsFor(store: Store): EmbedThumbStats {
  const n = (sql: string): number => (store.query(sql) as { n: number }[])[0]?.n ?? 0;
  return {
    known: n('SELECT COUNT(*) AS n FROM entry_embeds'),
    stored: n('SELECT COUNT(*) AS n FROM entry_embeds WHERE thumb_hash IS NOT NULL'),
    failed: n(
      'SELECT COUNT(*) AS n FROM entry_embeds WHERE thumb_hash IS NULL AND fetched_at IS NOT NULL',
    ),
  };
}
