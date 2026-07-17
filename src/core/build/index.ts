// Default import, not `{ render }`: ejs resolves its "import" condition to a real
// ESM file that exports ONLY a default, while @types/ejs describes the CommonJS
// shape. tsc typechecks the named import and Node then dies on it at startup —
// the same green-build-red-runtime trap schema.sql set (see templates.ts).
import ejs from 'ejs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { renderBody, journalUrl } from './render.js';
import { STYLE } from './theme.js';
import * as T from './templates.js';
import { Store } from '../store/db.js';
import type { Config } from '../config.js';
import { silentReporter, type ProgressReporter } from '../progress.js';

const { render } = ejs;

export { renderBody } from './render.js';
export type { RenderContext } from './render.js';

/**
 * archive.db -> site/ (DESIGN.md §7).
 *
 * Plain HTML, relative paths only. It opens from file:// with no server, no
 * runtime, and no install, and it keeps working when this tool doesn't (§13).
 *
 * Core, so progress goes through the reporter, never to stdout (§15).
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const DAY_NAMES = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];

interface EntryRow {
  itemid: number;
  ditemid: number;
  eventtime: string;
  subject: string | null;
  body: string;
  security: string;
  mood: string | null;
  moodid: number | null;
  music: string | null;
  location: string | null;
}

interface CommentRow {
  id: number;
  jitemid: number;
  parentid: number | null;
  posterid: number | null;
  username: string | null;
  subject: string | null;
  body: string | null;
  date: string | null;
  state: string;
}

export interface BuildStats {
  readonly pages: number;
  readonly entries: number;
  readonly comments: number;
  readonly imagesKept: number;
  readonly imagesLost: number;
}

/** A tag becomes a filename. Must be stable and collision-free on any OS. */
export function slugify(tag: string): string {
  const base = tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A tag of only punctuation, or one that collides after squashing, still needs
  // a page. Fall back to a hex encoding rather than silently dropping it.
  return base === '' ? 't-' + Buffer.from(tag).toString('hex').slice(0, 12) : base;
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SECURITY_LABEL: Record<string, string> = {
  public: 'public',
  private: 'private',
  usemask: 'friends only',
};
const SECURITY_TITLE: Record<string, string> = {
  public: 'Anyone could read this',
  private: 'Only you could read this',
  usemask: 'Only a friends group could read this',
};

/** yyyy-mm-dd hh:mm:ss -> parts, without a Date and its timezone opinions. */
function parts(eventtime: string): { y: number; m: number; d: number; hh: string; mm: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(eventtime);
  return {
    y: Number(m?.[1] ?? 0),
    m: Number(m?.[2] ?? 1),
    d: Number(m?.[3] ?? 1),
    hh: m?.[4] ?? '00',
    mm: m?.[5] ?? '00',
  };
}

const pad = (n: number): string => String(n).padStart(2, '0');

const entryPath = (ditemid: number): string => `entries/${ditemid}.html`;
const dayPath = (y: number, m: number, d: number): string =>
  `calendar/${y}/${pad(m)}/${pad(d)}.html`;
const yearPath = (y: number): string => `calendar/${y}/index.html`;
const monthAnchor = (m: number): string => `m${pad(m)}`;
const tagPath = (tag: string): string => `tags/${slugify(tag)}.html`;

/** How many '../' to get from a page back to the site root. */
const rootFor = (path: string): string => '../'.repeat(path.split('/').length - 1);

export async function buildSite(
  config: Config,
  deps: { store: Store; report?: ProgressReporter },
): Promise<BuildStats> {
  const { store } = deps;
  const report = deps.report ?? silentReporter;
  const site = join(config.outputDir, 'site');

  const write = async (rel: string, html: string): Promise<void> => {
    const abs = join(site, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, html, 'utf8');
  };

  report({ kind: 'start', task: 'loading' });

  const entries = store.query(
    'SELECT itemid, ditemid, eventtime, subject, body, security, mood, moodid, music, location FROM entries ORDER BY eventtime',
  ) as EntryRow[];
  const comments = store.query(
    `SELECT c.id, c.jitemid, c.parentid, c.posterid, u.username, c.subject, c.body, c.date, c.state
       FROM comments c LEFT JOIN users u ON u.posterid = c.posterid
      ORDER BY c.id`,
  ) as CommentRow[];
  const moods = new Map(
    (store.query('SELECT moodid, name FROM moods') as { moodid: number; name: string }[]).map(
      (m) => [m.moodid, m.name],
    ),
  );
  const tagRows = store.query('SELECT itemid, tag FROM entry_tags') as {
    itemid: number;
    tag: string;
  }[];

  // URL -> local blob, and URL -> why it died. Only 'ok' blobs are linkable:
  // poison bytes stay on disk but must never render as a photo (§5.2).
  const live = new Map(
    (
      store.query(
        `SELECT r.source_url AS u, a.local_path AS p FROM asset_refs r
           JOIN assets a ON a.hash = r.hash WHERE a.status = 'ok'`,
      ) as { u: string; p: string }[]
    ).map((r) => [r.u, r.p]),
  );
  // Only 'ok' blobs get copied: poison bytes stay in archive/ and never enter
  // the site, so a ransom placeholder can't masquerade as a photo (§5.2).
  const assetPaths = (
    store.query("SELECT local_path AS p FROM assets WHERE status = 'ok'") as { p: string }[]
  ).map((r) => r.p);
  const dead = new Map(
    (
      store.query(
        `SELECT source_url AS u, COALESCE(error, 'HTTP ' || http_status, 'not recovered') AS why
           FROM asset_refs WHERE hash IS NULL AND fetched_at IS NOT NULL`,
      ) as { u: string; why: string }[]
    ).map((r) => [r.u, r.why]),
  );

  // Userpics (§3). Scraped, not from the API — LJ never returns picture_keyword
  // and the comment export has no picid. Only blobs we actually hold are joined,
  // so a pic we know about but failed to fetch renders as nothing rather than a
  // broken image.
  const entryPic = new Map(
    (
      store.query(
        `SELECT e.ditemid AS d, a.local_path AS p FROM entry_userpics e
           JOIN userpics u ON u.picid = e.picid
           JOIN assets a ON a.hash = u.hash WHERE a.status = 'ok'`,
      ) as { d: number; p: string }[]
    ).map((r) => [r.d, r.p]),
  );
  const commentPic = new Map(
    (
      store.query(
        `SELECT c.comment_id AS c, a.local_path AS p FROM comment_userpics c
           JOIN userpics u ON u.picid = c.picid
           JOIN assets a ON a.hash = u.hash WHERE a.status = 'ok'`,
      ) as { c: number; p: string }[]
    ).map((r) => [r.c, r.p]),
  );

  const heldDitemids = new Set(entries.map((e) => e.ditemid));
  const tagsByEntry = new Map<number, string[]>();
  for (const t of tagRows) tagsByEntry.set(t.itemid, [...(tagsByEntry.get(t.itemid) ?? []), t.tag]);

  const commentsByEntry = new Map<number, CommentRow[]>();
  for (const c of comments)
    commentsByEntry.set(c.jitemid, [...(commentsByEntry.get(c.jitemid) ?? []), c]);

  report({
    kind: 'done',
    task: 'loading',
    summary: `${entries.length} entries, ${comments.length} comments`,
  });

  const journal = `${config.username}'s journal`;
  const totals = { entryCount: entries.length, commentCount: comments.length };

  const page = (rel: string, title: string, content: string): Promise<void> =>
    write(
      rel,
      render(T.LAYOUT, {
        title: esc(title),
        journal: esc(journal),
        root: rootFor(rel),
        content,
        ...totals,
      }),
    );

  let pages = 0;

  // --- entries ----------------------------------------------------------
  report({ kind: 'start', task: 'entries', total: entries.length });

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const rel = entryPath(e.ditemid);
    const root = rootFor(rel);
    const p = parts(e.eventtime);

    const ctx = {
      localFor: (u: string) => live.get(u),
      deadReason: (u: string) => dead.get(u),
      username: config.username,
      entryHref: (d: number) => (heldDitemids.has(d) ? entryPath(d) : undefined),
      root,
    };

    // Threading: real nesting, built from parentid. NULL means top-level — never
    // 0, which is the bug that would have flattened all of it (§5.1).
    const mine = commentsByEntry.get(e.itemid) ?? [];
    const kids = new Map<number | null, CommentRow[]>();
    for (const c of mine) kids.set(c.parentid, [...(kids.get(c.parentid) ?? []), c]);

    const renderComments = (parent: number | null): string =>
      (kids.get(parent) ?? [])
        .map((c) =>
          render(T.COMMENT, {
            root,
            id: c.id,
            state: c.state,
            pic: commentPic.get(c.id),
            // Anonymous is the ABSENCE of a poster, not a kind of user (§6).
            // journalUrl, not a hand-built host: LJ maps underscores to hyphens
            // in journal hostnames, and this line had its own copy of that URL
            // and its own copy of the bug. Fixing the renderer left all 644
            // comment bylines here still pointing at nothing.
            who:
              c.username !== null
                ? `<a class="lj-user" href="${esc(journalUrl(c.username))}">${esc(c.username)}</a>`
                : '<span class="anon">anonymous</span>',
            date: c.date ?? '',
            stateLabel:
              c.state === 'D'
                ? 'deleted'
                : c.state === 'S'
                  ? 'screened'
                  : c.state === 'F'
                    ? 'frozen'
                    : '',
            subject: c.subject ?? '',
            // Deleted comments have no body at all — 217 of them. That is not
            // an empty comment, and rendering it as one would be a lie (§5.1).
            body: c.body !== null ? renderBody(c.body, ctx) : '',
            children: renderComments(c.id),
          }),
        )
        .join('');

    const moodText = e.mood ?? (e.moodid !== null ? moods.get(e.moodid) : undefined);
    const tags = (tagsByEntry.get(e.itemid) ?? []).map((t) => ({
      name: esc(t),
      href: root + tagPath(t),
    }));
    const prevE = entries[i - 1];
    const nextE = entries[i + 1];
    const label = (x: EntryRow): string =>
      x.subject ??
      parts(x.eventtime).y + '-' + pad(parts(x.eventtime).m) + '-' + pad(parts(x.eventtime).d);

    const content = render(T.ENTRY, {
      root,
      pic: entryPic.get(e.ditemid),
      subject: esc(e.subject ?? '(no subject)'),
      displayDate: `${MONTHS[p.m - 1]} ${p.d}, ${p.y} — ${p.hh}:${p.mm}`,
      dayHref: root + dayPath(p.y, p.m, p.d),
      security: e.security,
      securityLabel: SECURITY_LABEL[e.security] ?? e.security,
      securityTitle: SECURITY_TITLE[e.security] ?? '',
      // mood and moodid are independent: 307 entries have an id and no text, so
      // resolving through the vocabulary is the only way they render at all (§5.1).
      mood: moodText !== undefined ? esc(moodText) : '',
      music: e.music !== null ? esc(e.music) : '',
      location: e.location !== null ? esc(e.location) : '',
      tags,
      body: renderBody(e.body, ctx),
      prev: prevE ? { href: root + entryPath(prevE.ditemid), label: esc(label(prevE)) } : null,
      next: nextE ? { href: root + entryPath(nextE.ditemid), label: esc(label(nextE)) } : null,
      commentCount: mine.length,
      comments: renderComments(null),
    });

    await page(rel, e.subject ?? `Entry ${e.ditemid}`, content);
    pages++;
    if (i % 100 === 0) report({ kind: 'tick', task: 'entries', done: i });
  }
  report({ kind: 'done', task: 'entries', summary: `${entries.length} pages` });

  // --- calendar ---------------------------------------------------------
  report({ kind: 'start', task: 'calendar' });

  const byDay = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const p = parts(e.eventtime);
    const k = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }
  const years = [...new Set(entries.map((e) => parts(e.eventtime).y))].sort();
  const yearCount = (y: number): number => entries.filter((e) => parts(e.eventtime).y === y).length;

  const yearList = years.map((y) => ({ year: y, count: yearCount(y), href: '' }));

  await page(
    'calendar/index.html',
    'Calendar',
    render(T.YEARS, {
      years: yearList.map((y) => ({
        ...y,
        href: rootFor('calendar/index.html') + yearPath(y.year),
      })),
    }),
  );
  pages++;

  for (const y of years) {
    const rel = yearPath(y);
    const root = rootFor(rel);
    const months = MONTHS.map((name, mi) => {
      const m = mi + 1;
      const first = new Date(Date.UTC(y, mi, 1)).getUTCDay();
      const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
      const cells: ({ day: number; count: number; href: string } | null)[] =
        Array(first).fill(null);
      let count = 0;
      for (let d = 1; d <= days; d++) {
        const hits = byDay.get(`${y}-${pad(m)}-${pad(d)}`) ?? [];
        count += hits.length;
        cells.push({
          day: d,
          count: hits.length,
          href: hits.length ? root + dayPath(y, m, d) : '',
        });
      }
      const weeks: (typeof cells)[] = [];
      for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
      // An anchor, not a month index page. The year page already draws all 12
      // grids with every day linked, so a month page would hold nothing the
      // reader can't already see — 78 pages that exist only to be linked to.
      return { name, count, anchor: monthAnchor(m), weeks };
    });
    await page(
      rel,
      `${y}`,
      render(T.YEAR, { year: y, count: yearCount(y), months, dayNames: DAY_NAMES }),
    );
    pages++;
  }

  for (const [key, dayEntries] of byDay) {
    const [ys, ms, ds] = key.split('-');
    const y = Number(ys),
      m = Number(ms),
      d = Number(ds);
    const rel = dayPath(y, m, d);
    const root = rootFor(rel);
    await page(
      rel,
      key,
      render(T.DAY, {
        displayDate: `${MONTHS[m - 1]} ${d}, ${y}`,
        monthHref: `${root}${yearPath(y)}#${monthAnchor(m)}`,
        monthName: `${MONTHS[m - 1]} ${y}`,
        entries: dayEntries.map((e) => ({
          href: root + entryPath(e.ditemid),
          subject: esc(e.subject ?? '(no subject)'),
          commentCount: (commentsByEntry.get(e.itemid) ?? []).length,
        })),
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'calendar', summary: `${years.length} years, ${byDay.size} days` });

  // --- tags -------------------------------------------------------------
  report({ kind: 'start', task: 'tags' });
  const tagCounts = new Map<string, number>();
  for (const t of tagRows) tagCounts.set(t.tag, (tagCounts.get(t.tag) ?? 0) + 1);
  const sortedTags = [...tagCounts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  await page(
    'tags/index.html',
    'Tags',
    render(T.TAGS, {
      tags: sortedTags.map(([name, count]) => ({
        name: esc(name),
        count,
        href: rootFor('tags/index.html') + tagPath(name),
      })),
    }),
  );
  pages++;

  for (const [tag, count] of sortedTags) {
    const rel = tagPath(tag);
    const root = rootFor(rel);
    const ids = new Set(tagRows.filter((t) => t.tag === tag).map((t) => t.itemid));
    await page(
      rel,
      `Tagged ${tag}`,
      render(T.TAG, {
        tag: esc(tag),
        count,
        entries: entries
          .filter((e) => ids.has(e.itemid))
          .reverse()
          .map((e) => {
            const p = parts(e.eventtime);
            return {
              href: root + entryPath(e.ditemid),
              date: `${p.y}-${pad(p.m)}-${pad(p.d)}`,
              subject: esc(e.subject ?? '(no subject)'),
            };
          }),
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'tags', summary: `${sortedTags.length} tags` });

  // --- index + theme ----------------------------------------------------
  const imagesKept =
    (store.query("SELECT COUNT(*) AS n FROM assets WHERE status = 'ok'") as { n: number }[])[0]
      ?.n ?? 0;
  const imagesLost =
    (
      store.query(
        'SELECT COUNT(*) AS n FROM asset_refs WHERE hash IS NULL AND fetched_at IS NOT NULL',
      ) as { n: number }[]
    )[0]?.n ?? 0;

  await page(
    'index.html',
    journal,
    render(T.INDEX, {
      journal: esc(journal),
      ...totals,
      firstYear: years[0] ?? '',
      lastYear: years.at(-1) ?? '',
      imagesKept,
      imagesLost,
      years: yearList.map((y) => ({ ...y, href: yearPath(y.year) })),
      recent: entries
        .slice(-15)
        .reverse()
        .map((e) => {
          const p = parts(e.eventtime);
          return {
            href: entryPath(e.ditemid),
            date: `${p.y}-${pad(p.m)}-${pad(p.d)}`,
            subject: esc(e.subject ?? '(no subject)'),
          };
        }),
    }),
  );
  pages++;

  await write('style.css', STYLE);

  // --- blobs ------------------------------------------------------------
  // The images live at archive/blobs, a SIBLING of site/. Pages reference them
  // as blobs/... relative to the site root, so every recovered image resolves
  // to nothing until they're copied in. Linking '../blobs' instead would fix the
  // paths and break the promise: site/ has to be a folder you can move, zip, or
  // hand to someone and still have it open (§13). A copy is what makes that true.
  report({ kind: 'start', task: 'images', total: assetPaths.length });
  let copied = 0;
  for (const rel of assetPaths) {
    const dest = join(site, rel);
    await mkdir(dirname(dest), { recursive: true });
    // copyFile over rename/link: the archive keeps its own copy, and a build is
    // never allowed to move the only copy of something it didn't download.
    await copyFile(join(config.outputDir, rel), dest);
    copied++;
    if (copied % 50 === 0) report({ kind: 'tick', task: 'images', done: copied });
  }
  report({ kind: 'done', task: 'images', summary: `${copied} images copied into the site` });

  return { pages, entries: entries.length, comments: comments.length, imagesKept, imagesLost };
}
