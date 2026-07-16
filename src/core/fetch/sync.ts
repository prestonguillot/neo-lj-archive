import { LjClient } from './client.js';
import {
  nextStartId,
  parseCommentBody,
  parseCommentMeta,
  parseEvents,
  parseLogin,
} from './parse.js';
import { Store, type SyncStats } from '../store/db.js';
import type { Config } from '../config.js';
import { silentReporter, type ProgressReporter } from '../progress.js';

/**
 * The fetch orchestration (DESIGN.md §5.1).
 *
 * Core: no console, no process, no argv. Progress goes through the reporter; the
 * shell decides what it looks like (§15).
 *
 * Order is not arbitrary — comment_meta carries the usermaps AND the index, so
 * users land before the comments that reference them. Foreign keys are on, so a
 * reordered sync dies on live data.
 */

/** Checkpoint keys. Named so a resumed run is inspectable with sqlite3. */
const K = {
  entriesBefore: 'entries.beforedate',
  commentsStartId: 'comments.startid',
  commentsMaxId: 'comments.maxid',
} as const;

/** LJ caps getevents; 50 keeps the whole journal to ~30 requests (§2). */
const ENTRY_PAGE_SIZE = 50;

export interface SyncDeps {
  readonly client: LjClient;
  readonly store: Store;
  readonly report?: ProgressReporter;
}

export async function sync(config: Config, deps: SyncDeps): Promise<SyncStats> {
  const { client, store } = deps;
  const report = deps.report ?? silentReporter;

  // --- login: identity + the mood vocabulary ------------------------------
  report({ kind: 'start', task: 'login' });
  const login = parseLogin(await client.login({ getMoods: true, getUserpics: true }));
  store.putMoods(login.moods);
  report({
    kind: 'done',
    task: 'login',
    summary: `${login.username}, ${login.moods.length} moods`,
  });

  if (login.usejournals.length > 0) {
    // Surfaced, never fetched. §3 scopes communities out; the client refuses to
    // send usejournal at all.
    report({
      kind: 'note',
      message: `${login.usejournals.length} communities visible — not archived (DESIGN.md §3)`,
    });
  }

  await syncEntries(config, { client, store, report });
  await syncComments({ client, store, report });

  return store.stats();
}

/**
 * Entries: walk backwards through time with `beforedate`.
 *
 * NOT syncitems+lastsync. Two reasons, both learned the hard way by running it:
 *
 * 1. The `lastsync` LJ returns in a getevents response is a SERVER TIMESTAMP
 *    ("you synced at this moment"), not a page cursor. Feeding it back asks for
 *    entries changed since now, which for a frozen corpus is nothing.
 * 2. Entries come back DESCENDING by logtime, and each page spans the whole
 *    decade rather than a contiguous slice. An earlier version advanced by the
 *    page's max logtime, which jumped straight to 2010 on the first page and
 *    terminated having fetched 240 of ~1,500 entries — silently, reporting
 *    success.
 *
 * §2 settles the shape: the corpus is frozen, so "incremental" means resumable
 * and idempotent, not fresh. Walking backwards is complete, terminates, and
 * checkpoints naturally.
 */
async function syncEntries(config: Config, deps: Required<SyncDeps>): Promise<void> {
  const { client, store, report } = deps;
  report({ kind: 'start', task: 'entries' });

  let before = store.getState(K.entriesBefore);

  for (;;) {
    const page = parseEvents(
      await client.getEvents({
        selecttype: 'lastn',
        howmany: ENTRY_PAGE_SIZE,
        ...(before !== undefined ? { beforedate: before } : {}),
      }),
    );
    if (page.length === 0) break;

    // Progress is measured in NEW rows, not in rows received. If beforedate is
    // inclusive at a boundary, or several entries share an eventtime, a page can
    // be entirely re-runs — and this is what stops that becoming a silent
    // infinite loop.
    const wasAt = store.stats().entries;
    store.putEntries(page);
    const nowAt = store.stats().entries;
    if (nowAt === wasAt) break;

    report({ kind: 'tick', task: 'entries', done: nowAt });

    const oldest = page
      .map((e) => e.eventtime)
      .sort()
      .at(0);
    if (oldest === undefined || oldest === before) break;
    before = oldest;
    store.setState(K.entriesBefore, before);
  }

  report({ kind: 'done', task: 'entries', summary: `${store.stats().entries} total` });
  void config;
}

/**
 * Comments in two passes: meta is the complete index, body fills in text.
 *
 * Meta returns every comment in one page for this journal (6,550, limit 10,000),
 * so it doubles as the id set and the usermaps. Body is capped at 1,000 and
 * paged by highest-id-seen + 1 — never a fixed stride, because ids have gaps
 * and a stride silently skips real comments (§5.1).
 */
async function syncComments(deps: Required<SyncDeps>): Promise<void> {
  const { client, store, report } = deps;

  const session = await client.sessionGenerate();

  // --- pass 1: the index ---------------------------------------------------
  report({ kind: 'start', task: 'comment index' });
  const meta = parseCommentMeta(await client.exportComments('comment_meta', 0, session));

  // Users first: comments.posterid references them and FKs are on.
  store.putUsers(meta.usermaps);
  store.putCommentMeta(meta.comments);
  store.setState(K.commentsMaxId, String(meta.maxid));
  report({
    kind: 'done',
    task: 'comment index',
    summary: `${meta.comments.length} comments, ${meta.usermaps.length} commenters`,
  });

  // --- pass 2: the text ----------------------------------------------------
  report({ kind: 'start', task: 'comment bodies', total: meta.maxid });
  let startid = Number(store.getState(K.commentsStartId) ?? 0);
  let done = 0;

  for (;;) {
    const page = parseCommentBody(await client.exportComments('comment_body', startid, session));
    if (page.length === 0) break;

    store.putCommentBodies(page);
    done += page.length;
    report({ kind: 'tick', task: 'comment bodies', done, detail: `id ${startid}` });

    const next = nextStartId(page, meta.maxid);
    if (next === undefined) break;
    startid = next;
    // Checkpoint after the page is durably written, not before — otherwise a
    // crash between the two skips a page on resume.
    store.setState(K.commentsStartId, String(startid));
  }

  report({ kind: 'done', task: 'comment bodies', summary: `${done} fetched` });
}
