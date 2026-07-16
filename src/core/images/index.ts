import { extract } from './extract.js';
import { downloadAll, hostOf } from './download.js';
import { detectPoison } from './classify.js';
import { Store, type AssetRefRow, type ImageStats } from '../store/db.js';
import type { Config } from '../config.js';
import { silentReporter, type ProgressReporter } from '../progress.js';

export { extract, distinctUrls } from './extract.js';
export { downloadAll, hostOf, blobPath } from './download.js';
export { sniffMime, readSize, classifyBytes, detectPoison } from './classify.js';
export type { ImageRef, EmbedRef, Extraction } from './extract.js';
export type { StoredAsset } from './download.js';
export type { AssetStatus, PoisonFinding } from './classify.js';

/**
 * The images stage: extract -> download -> classify (DESIGN.md §5.2).
 *
 * Core, so progress goes through the reporter and never to stdout (§15).
 *
 * Three passes, each resumable, because the work list lives in the DB rather
 * than in memory: a killed run resumes and a finished one is a no-op (§4.5).
 */

export interface ImagesDeps {
  readonly store: Store;
  readonly report?: ProgressReporter;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export async function localizeImages(config: Config, deps: ImagesDeps): Promise<ImageStats> {
  const { store } = deps;
  const report = deps.report ?? silentReporter;

  // --- 1. extract -------------------------------------------------------
  report({ kind: 'start', task: 'scanning bodies' });
  const bodies = store.bodiesForExtraction(config.username);

  const refs: AssetRefRow[] = [];
  let ljUsers = 0;
  let embeds = 0;
  let cuts = 0;

  for (const b of bodies) {
    const e = extract(b.html, b.url);
    for (const img of e.images) {
      refs.push({
        sourceUrl: img.url,
        host: hostOf(img.url),
        context: b.context,
        contextId: b.id,
        altText: img.alt,
      });
    }
    ljUsers += e.ljUsers.length;
    embeds += e.embeds.length;
    if (e.hasCut) cuts++;
  }

  store.putAssetRefs(refs);

  // Occurrences, not rows. asset_refs is UNIQUE(source_url, context, context_id),
  // so an entry using the same image three times stores ONE row — which is right,
  // because rewriting at build time is keyed on the URL, not on occurrences. But
  // the two numbers differ (649 vs 465 on the real archive) and reporting only
  // the first invites someone to think rows went missing.
  const rows = store.imageStats().refs;
  report({
    kind: 'done',
    task: 'scanning bodies',
    summary:
      `${refs.length} image occurrences -> ${rows} unique refs, ` +
      `${ljUsers} lj-user mentions, ${embeds} embeds, ${cuts} cuts`,
  });

  // --- 2. download ------------------------------------------------------
  const pending = store.pendingUrls();
  if (pending.length === 0) {
    report({ kind: 'note', message: 'every image already attempted — nothing to fetch' });
  } else {
    report({ kind: 'start', task: 'fetching images', total: pending.length });
    let done = 0;
    let ok = 0;

    await downloadAll(
      pending,
      {
        outputDir: config.outputDir,
        concurrency: config.imageConcurrency,
        timeoutMs: config.imageTimeoutMs,
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.sleepImpl !== undefined ? { sleepImpl: deps.sleepImpl } : {}),
      },
      (a) => {
        // Written as each lands, so a kill mid-run loses at most one fetch.
        store.putAssetResult(a);
        done++;
        if (a.status === 'ok') ok++;
        report({
          kind: 'tick',
          task: 'fetching images',
          done,
          detail: `${ok} ok, ${done - ok} dead`,
        });
      },
    );
    report({ kind: 'done', task: 'fetching images', summary: `${ok} of ${done} still exist` });
  }

  // --- 3. host collapse -------------------------------------------------
  report({ kind: 'start', task: 'classifying' });
  const findings = detectPoison(store.poisonInput());
  store.markPoison(findings.map((f) => f.hash));

  for (const f of findings) {
    // Hosts are named in the local report but never published — this runs
    // against the author's own machine and their own archive.
    report({
      kind: 'warn',
      message:
        `placeholder: ${f.distinctUrls} distinct URLs on ${f.host} return identical bytes ` +
        `(${Math.round(f.share * 100)}% of that host) — marked poison, bytes kept`,
    });
  }
  report({
    kind: 'done',
    task: 'classifying',
    summary:
      findings.length === 0 ? 'no placeholders detected' : `${findings.length} placeholder(s)`,
  });

  return store.imageStats();
}
