// Default import, not `{ render }`: ejs resolves its "import" condition to a real
// ESM file that exports ONLY a default, while @types/ejs describes the CommonJS
// shape. tsc typechecks the named import and Node then dies on it at startup —
// the same green-build-red-runtime trap schema.sql set (see templates.ts).
import ejs from 'ejs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
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
  props_json: string | null;
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

/**
 * A tag becomes a filename: lowercase, punctuation squashed to hyphens.
 *
 * NOT collision-free on its own, which is the whole point of assignSlugs below.
 * "foo bar", "foo-bar" and "foo_bar" all land here as "foo-bar".
 */
export function slugify(tag: string): string {
  const base = tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // A tag of only punctuation still needs a page. Hex rather than dropping it.
  return base === '' ? 't-' + Buffer.from(tag).toString('hex').slice(0, 12) : base;
}

/**
 * tag -> filename, distinct for distinct tags.
 *
 * slugify() squashes punctuation, so "foo bar" and "foo-bar" both become
 * "foo-bar" — one page, and whichever is written second silently REPLACES the
 * other's entries. This journal's 143 tags happen not to collide, so the bug is
 * latent rather than live; it would surface on someone else's archive, or on
 * this one after a single new tag.
 *
 * The comment here used to claim slugify handled collisions. It never did — it
 * only handled the empty case. That is the kind of lie that survives review
 * precisely because it sounds like diligence.
 *
 * Sorted first, so the assignment depends only on the SET of tags and not on the
 * order rows came back — a slug that moves between builds breaks every bookmark.
 */
export function assignSlugs(tags: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  const taken = new Set<string>();
  for (const tag of [...new Set(tags)].sort()) {
    const base = slugify(tag);
    let slug = base;
    if (taken.has(slug)) {
      // Disambiguate with a hash of the ORIGINAL tag: stable across builds, and
      // it can't collide with a counter someone else's tag might have claimed.
      const h = createHash('sha256').update(tag).digest('hex').slice(0, 6);
      slug = `${base}-${h}`;
    }
    taken.add(slug);
    out.set(tag, slug);
  }
  return out;
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

/** Thousands separators, applied consistently. 1547 next to 2,514 reads as a typo. */
const num = (n: number): string => n.toLocaleString('en-US');

const entryPath = (ditemid: number): string => `entries/${ditemid}.html`;
const dayPath = (y: number, m: number, d: number): string =>
  `calendar/${y}/${pad(m)}/${pad(d)}.html`;
const yearPath = (y: number): string => `calendar/${y}/index.html`;
const monthAnchor = (m: number): string => `m${pad(m)}`;
/** Built from the assigned slug map, NOT slugify: see assignSlugs. */
const tagPathVia = (slugs: Map<string, string>, tag: string): string =>
  `tags/${slugs.get(tag) ?? slugify(tag)}.html`;

const otdPath = (m: number, d: number): string => `onthisday/${pad(m)}-${pad(d)}.html`;

/**
 * LJ's current_music, split into who and what.
 *
 * The rule is DERIVED, not guessed: 409 of 473 values in this journal use " - "
 * as the separator, 2 use " by ", and 64 carry no separator at all. So " - "
 * splits artist from song, the first occurrence wins (song titles contain
 * hyphens far more often than artist names do), and anything unseparated is
 * treated as an artist rather than thrown away.
 */
function splitMusic(raw: string): { artist: string; song: string | null } {
  const i = raw.indexOf(' - ');
  if (i > 0) return { artist: raw.slice(0, i).trim(), song: raw.slice(i + 3).trim() || null };
  const by = / by /i.exec(raw);
  // "Song by Artist" is the reverse order — 2 entries, and getting it backwards
  // would file a song under an artist that doesn't exist.
  if (by && by.index > 0) {
    return { artist: raw.slice(by.index + 4).trim(), song: raw.slice(0, by.index).trim() || null };
  }
  return { artist: raw.trim(), song: null };
}

/**
 * A key for GROUPING only — never for display.
 *
 * "Green Day", "green day" and "The Beatles" vs "Beatles" are the same act typed
 * differently across seven years. Normalising for the count is what makes the
 * number true; the page still shows the spelling the author actually used.
 */
function musicKey(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/&amp;/g, '&')
      .replace(/^the\s+/, '')
      // Everything that is not a letter or digit goes. Seven years of typing the
      // same band name produces "Green Day" and "Greenday" — which listed as two
      // artists, 14 plays and 8, and that split is exactly what normalisation is
      // for. Checked against the real values before applying: it fuses green
      // day/greenday, lost prophets/lostprophets, gold finger/goldfinger and fall
      // out boy/fallout boy, and nothing else. Four merges, zero false ones.
      .replace(/[^a-z0-9]/g, '')
  );
}

const monthPath = (y: number, m: number): string => `calendar/${y}/${pad(m)}/index.html`;
const hourPath = (h: number): string => `hours/${pad(h)}.html`;
const moodPath = (slug: string): string => `moods/${slug}.html`;
const musicPath = (slug: string): string => `music/${slug}.html`;

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
    'SELECT itemid, ditemid, eventtime, subject, body, security, mood, moodid, music, location, props_json FROM entries ORDER BY eventtime',
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

  // One assignment for the whole journal, so two tags can never share a page.
  const tagSlugs = assignSlugs(tagRows.map((t) => t.tag));

  const meRow = store.query(
    'SELECT posterid AS id FROM users WHERE username = ?',
    config.username,
  ) as {
    id: number;
  }[];
  const myId = meRow[0]?.id ?? -1;

  // Hoisted: Retrospect reports these and it builds before the index does.
  //
  // Joined to asset_refs on purpose. Userpics are stored in `assets` too — that
  // is what makes the build copy them into the site for free — but they are not
  // images from the writing, and counting them here reported "426 images
  // recovered" when the entries and comments hold 203. A number nobody can check
  // is a number that drifts.
  const imagesKept =
    (
      store.query(
        `SELECT COUNT(DISTINCT a.hash) AS n FROM assets a
           JOIN asset_refs r ON r.hash = a.hash WHERE a.status = 'ok'`,
      ) as { n: number }[]
    )[0]?.n ?? 0;
  const imagesLost =
    (
      store.query(
        'SELECT COUNT(*) AS n FROM asset_refs WHERE hash IS NULL AND fetched_at IS NOT NULL',
      ) as { n: number }[]
    )[0]?.n ?? 0;

  // Recovered embed URLs, per entry, in appearance order (§11 M4).
  //
  // The export had only <lj-embed id="X">; the real target was scraped from the
  // rendered page into entry_embeds. LJ's proxy URL carries the video: for
  // youtube, ?source=youtube&vid=ID rebuilds a durable watch link (the video id
  // outlives the proxy). The 7 without a vid held only session tokens and stay
  // as plain "media was here" markers.
  const embedUrlOf = (proxy: string): string | undefined => {
    try {
      const u = new URL(proxy);
      const vid = u.searchParams.get('vid');
      if (u.searchParams.get('source') === 'youtube' && vid !== null && vid !== '') {
        return `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}`;
      }
    } catch {
      /* a malformed proxy URL just falls through to the plain marker */
    }
    return undefined;
  };
  const embedsByEntry = new Map<number, (string | undefined)[]>();
  for (const r of store.query(
    'SELECT ditemid, idx, url FROM entry_embeds ORDER BY ditemid, idx',
  ) as { ditemid: number; idx: number; url: string }[]) {
    const list = embedsByEntry.get(r.ditemid) ?? [];
    list[r.idx] = embedUrlOf(r.url);
    embedsByEntry.set(r.ditemid, list);
  }

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
  // Formatted once, here, so every page agrees. These are display-only: the
  // per-entry commentCount and per-person entryCount are passed separately.
  const totals = { entryCount: num(entries.length), commentCount: num(comments.length) };

  const railYears = [...new Set(entries.map((e) => parts(e.eventtime).y))].sort();

  /**
   * A decade at a glance, on ONE scale.
   *
   * Scaling each year to its own peak — which is what this did first — made
   * 1984's single entry and 2010's five burn exactly as hot as 2004's 348. Every
   * row equally busy, which is precisely the opposite of the point: the shape of
   * the decline IS the story here, and a heatmap whose rows can't be compared to
   * each other is decoration.
   */
  const monthCount = (y: number, m: number): number =>
    entries.filter((e) => {
      const p = parts(e.eventtime);
      return p.y === y && p.m === m;
    }).length;

  // The rail's "On this day" is retargeted to the real today by six lines of JS in
  // the layout. This is the NO-JS fallback, and it must be deterministic: the same
  // archive.db has to build the same bytes on any day, so it cannot be Date.now().
  const newest = parts(entries[entries.length - 1]?.eventtime ?? '2004-01-01 00:00');
  const todayHref = `${pad(newest.m)}-${pad(newest.d)}.html`;
  // Which dates actually have a page, so the script can walk forward to the next
  // real one instead of pointing at a 404 on a day nothing was ever written.
  const otdDates = [
    ...new Set(
      entries.map((e) => {
        const p = parts(e.eventtime);
        return `${pad(p.m)}-${pad(p.d)}`;
      }),
    ),
  ].sort();

  const page = (rel: string, title: string, content: string): Promise<void> =>
    write(
      rel,
      render(T.LAYOUT, {
        title: esc(title),
        journal: esc(journal),
        root: rootFor(rel),
        content,
        railYears,
        todayHref,
        otdDates,
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

    const entryEmbeds = embedsByEntry.get(e.ditemid) ?? [];
    const ctx = {
      // opt_preformatted: LJ leaves this body's newlines alone, so we must too.
      preformatted: /"opt_preformatted"/.test(e.props_json ?? ''),
      embedUrl: (i: number) => entryEmbeds[i],
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
      href: root + tagPathVia(tagSlugs, t),
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

  // One grid, one peak, so the rows mean something next to each other.
  const heatGrid = yearList.map((y) => MONTHS.map((_, mi) => monthCount(y.year, mi + 1)));
  const heatPeak = Math.max(1, ...heatGrid.flat());
  const heatRows = yearList.map((y, yi) => ({
    year: y.year,
    href: yearPath(y.year),
    total: y.count,
    cells: (heatGrid[yi] ?? []).map((n, mi) => ({
      // Four buckets, not a gradient: the eye reads steps, not interpolation.
      level: n === 0 ? 0 : n >= heatPeak * 0.5 ? 3 : n >= heatPeak * 0.2 ? 2 : 1,
      label: `${MONTHS[mi]} ${y.year}: ${n} ${n === 1 ? 'entry' : 'entries'}`,
    })),
  }));

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
        href: rootFor('tags/index.html') + tagPathVia(tagSlugs, name),
      })),
    }),
  );
  pages++;

  for (const [tag, count] of sortedTags) {
    const rel = tagPathVia(tagSlugs, tag);
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

  // --- on this day, across years (§11 M4) --------------------------------
  //
  // The navigation a diary actually wants. The calendar answers "what did I
  // write in March 2005"; nothing answered "what was I doing on this date,
  // ever". Only dates that HAVE entries get a page — 366 pages, 271 of them
  // empty, would be 271 invitations to a dead end.
  report({ kind: 'start', task: 'on this day' });
  const byMonthDay = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const p = parts(e.eventtime);
    const k = `${pad(p.m)}-${pad(p.d)}`;
    byMonthDay.set(k, [...(byMonthDay.get(k) ?? []), e]);
  }
  const otdKeys = [...byMonthDay.keys()].sort();
  for (const [i, key] of otdKeys.entries()) {
    const [ms, ds] = key.split('-');
    const m = Number(ms);
    const d = Number(ds);
    const rel = otdPath(m, d);
    const root = rootFor(rel);
    const mine = byMonthDay.get(key) ?? [];
    const byYear = new Map<number, EntryRow[]>();
    for (const e of mine) {
      const y = parts(e.eventtime).y;
      byYear.set(y, [...(byYear.get(y) ?? []), e]);
    }
    // Wraps around, so the spine never dead-ends on Jan 1 or Dec 31.
    const prev = otdKeys[(i - 1 + otdKeys.length) % otdKeys.length]!;
    const next = otdKeys[(i + 1) % otdKeys.length]!;
    const label = (k: string): string => {
      const [mm, dd] = k.split('-');
      return `${MONTHS[Number(mm) - 1]} ${Number(dd)}`;
    };
    await page(
      rel,
      `${MONTHS[m - 1]} ${d}`,
      render(T.ONTHISDAY, {
        displayDate: `${MONTHS[m - 1]} ${d}`,
        count: mine.length,
        yearCount: byYear.size,
        years: [...byYear.entries()]
          .sort((a, b) => b[0] - a[0])
          .map(([year, es]) => ({
            year,
            entries: es.map((e) => {
              const p = parts(e.eventtime);
              return {
                href: root + entryPath(e.ditemid),
                time: `${p.hh}:${p.mm}`,
                subject: esc(e.subject ?? '(no subject)'),
              };
            }),
          })),
        prevHref: root + otdPath(Number(prev.split('-')[0]), Number(prev.split('-')[1])),
        prevLabel: label(prev),
        nextHref: root + otdPath(Number(next.split('-')[0]), Number(next.split('-')[1])),
        nextLabel: label(next),
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'on this day', summary: `${otdKeys.length} dates` });

  // --- people (§11 M4) --------------------------------------------------
  report({ kind: 'start', task: 'people' });
  const perPerson = store.query(
    `SELECT u.posterid AS id, u.username AS name, COUNT(*) AS n
       FROM comments c JOIN users u ON u.posterid = c.posterid
      GROUP BY c.posterid ORDER BY n DESC, u.username`,
  ) as { id: number; name: string; n: number }[];
  // Their most-used pic: the face you'd actually recognise them by.
  const faceFor = new Map(
    (
      store.query(
        `SELECT u.userid AS id, a.local_path AS p, COUNT(*) AS n
           FROM comment_userpics cu
           JOIN userpics u ON u.picid = cu.picid
           JOIN assets a ON a.hash = u.hash AND a.status = 'ok'
          GROUP BY u.userid ORDER BY n DESC`,
      ) as { id: number; p: string; n: number }[]
    ).map((r) => [r.id, r.p]),
  );
  const anonCount =
    (store.query('SELECT COUNT(*) AS n FROM comments WHERE posterid IS NULL') as { n: number }[])[0]
      ?.n ?? 0;
  // The author is not one of "the people". He commented on his own journal 1,713
  // times, which makes him the top name on a list of everyone ELSE who showed up.
  const others = perPerson.filter((p) => p.id !== myId);

  // Same collision rule as tags: two usernames must never share a page.
  const personSlugs = assignSlugs(others.map((p) => p.name));
  const personPathVia = (name: string): string =>
    `people/${personSlugs.get(name) ?? slugify(name)}.html`;

  const commentsByPoster = new Map<number, CommentRow[]>();
  for (const c of comments)
    if (c.posterid !== null)
      commentsByPoster.set(c.posterid, [...(commentsByPoster.get(c.posterid) ?? []), c]);
  const entryByItemid = new Map(entries.map((e) => [e.itemid, e]));

  const spanOf = (cs: CommentRow[]): string => {
    const ds = cs
      .map((c) => c.date ?? '')
      .filter(Boolean)
      .sort();
    const y = (d: string): string => d.slice(0, 4);
    if (ds.length === 0) return '';
    const a = y(ds[0]!);
    const b = y(ds[ds.length - 1]!);
    return a === b ? a : `${a}\u2013${b}`;
  };

  await page(
    'people/index.html',
    'People',
    render(T.PEOPLE, {
      root: rootFor('people/index.html'),
      count: others.length,
      total: others.reduce((a, p) => a + p.n, 0),
      anon: anonCount,
      people: others.map((p) => ({
        name: esc(p.name),
        n: p.n,
        // To the conversations, not to a journal as dead as this one.
        href: rootFor('people/index.html') + personPathVia(p.name),
        span: spanOf(commentsByPoster.get(p.id) ?? []),
        pic: faceFor.get(p.id),
      })),
    }),
  );
  pages++;

  // One page per person: the entries they turned up in, and how much.
  for (const p of others) {
    const theirs = commentsByPoster.get(p.id) ?? [];
    const byEntry = new Map<number, number>();
    for (const c of theirs) byEntry.set(c.jitemid, (byEntry.get(c.jitemid) ?? 0) + 1);
    const rel = personPathVia(p.name);
    const root = rootFor(rel);
    const list = [...byEntry.entries()]
      .map(([itemid, n]) => ({ e: entryByItemid.get(itemid), n }))
      .filter((x) => x.e !== undefined)
      .sort((a, b) => (a.e!.eventtime < b.e!.eventtime ? 1 : -1));
    await page(
      rel,
      p.name,
      render(T.PERSON, {
        name: esc(p.name),
        n: p.n,
        entryCount: list.length,
        span: spanOf(theirs),
        ljHref: esc(journalUrl(p.name)),
        entries: list.map((x) => {
          const q = parts(x.e!.eventtime);
          return {
            href: root + entryPath(x.e!.ditemid),
            date: `${q.y}-${pad(q.m)}-${pad(q.d)}`,
            subject: esc(x.e!.subject ?? '(no subject)'),
            n: x.n,
          };
        }),
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'people', summary: `${perPerson.length} people` });

  // --- userpic gallery (§11 M4) -----------------------------------------
  report({ kind: 'start', task: 'faces' });
  // The author is identified BY NAME.
  //
  // Two earlier versions got this wrong in opposite directions: one took his
  // userid from a subquery on the first row of entry_userpics (betting that row
  // was his), and the replacement used "every userid that is NOT a commenter" —
  // which excluded him completely, because he commented on his own journal 1,713
  // times. The page rendered "0 of yours". His name is the only thing that
  // actually identifies him.
  const myPics = store.query(
    `SELECT a.local_path AS pic, COUNT(eu.ditemid) AS n
       FROM userpics u
       JOIN assets a ON a.hash = u.hash AND a.status = 'ok'
       LEFT JOIN entry_userpics eu ON eu.picid = u.picid
      WHERE u.userid = ?
      GROUP BY u.picid ORDER BY n DESC`,
    myId,
  ) as { pic: string; n: number }[];
  const theirPics = store.query(
    `SELECT a.local_path AS pic, us.username AS who
       FROM userpics u
       JOIN assets a ON a.hash = u.hash AND a.status = 'ok'
       JOIN users us ON us.posterid = u.userid
      WHERE u.userid <> ?
      GROUP BY u.picid ORDER BY us.username`,
    myId,
  ) as { pic: string; who: string }[];
  await page(
    'userpics/index.html',
    'Userpics',
    render(T.FACES, {
      root: rootFor('userpics/index.html'),
      mine: myPics,
      others: theirPics.map((t) => ({ ...t, who: esc(t.who) })),
    }),
  );
  pages++;
  report({
    kind: 'done',
    task: 'faces',
    summary: `${myPics.length} yours, ${theirPics.length} theirs`,
  });

  // --- month pages ------------------------------------------------------
  // Removed once as redundant with the year grid, and back because the heatmap
  // needs a real landing place: "click a month" has to reach that month's posts,
  // not a calendar grid scrolled to an anchor.
  report({ kind: 'start', task: 'months' });
  const byMonth = new Map<string, EntryRow[]>();
  for (const e of entries) {
    const p = parts(e.eventtime);
    byMonth.set(`${p.y}-${pad(p.m)}`, [...(byMonth.get(`${p.y}-${pad(p.m)}`) ?? []), e]);
  }
  const monthKeys = [...byMonth.keys()].sort();
  for (const [i, key] of monthKeys.entries()) {
    const [ys, ms] = key.split('-');
    const y = Number(ys);
    const m = Number(ms);
    const rel = monthPath(y, m);
    const root = rootFor(rel);
    const mine = byMonth.get(key) ?? [];
    const lbl = (k: string): string => {
      const [yy, mm] = k.split('-');
      return `${MONTHS[Number(mm) - 1]} ${yy}`;
    };
    const prevK = monthKeys[i - 1];
    const nextK = monthKeys[i + 1];
    await page(
      rel,
      lbl(key),
      render(T.MONTH, {
        name: lbl(key),
        count: mine.length,
        entries: mine.map((e) => {
          const q = parts(e.eventtime);
          return {
            href: root + entryPath(e.ditemid),
            date: `${pad(q.m)}-${pad(q.d)}`,
            subject: esc(e.subject ?? '(no subject)'),
            n: (commentsByEntry.get(e.itemid) ?? []).length,
          };
        }),
        prev: prevK
          ? {
              href: root + monthPath(Number(prevK.split('-')[0]), Number(prevK.split('-')[1])),
              label: lbl(prevK),
            }
          : null,
        next: nextK
          ? {
              href: root + monthPath(Number(nextK.split('-')[0]), Number(nextK.split('-')[1])),
              label: lbl(nextK),
            }
          : null,
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'months', summary: `${monthKeys.length} months` });

  // --- image gallery (§11 M4) -------------------------------------------
  // Every image that survived, each linking back to the post it came from. The
  // "203 images" line on Retrospect had nowhere to go; now it goes here.
  report({ kind: 'start', task: 'images page' });
  const galleryRows = store.query(
    `SELECT a.local_path AS pic, r.context AS ctx, r.context_id AS cid, MIN(r.alt_text) AS alt
       FROM assets a JOIN asset_refs r ON r.hash = a.hash
      WHERE a.status = 'ok'
      GROUP BY a.hash ORDER BY r.context_id`,
  ) as { pic: string; ctx: string; cid: number; alt: string | null }[];
  const entryForComment = new Map(comments.map((c) => [c.id, c.jitemid]));
  await page(
    'images/index.html',
    'Images',
    render(T.IMAGES, {
      root: rootFor('images/index.html'),
      count: galleryRows.length,
      lost: imagesLost,
      images: galleryRows
        .map((g) => {
          // An image referenced from a COMMENT belongs to that comment's entry.
          const itemid = g.ctx === 'comment' ? entryForComment.get(g.cid) : g.cid;
          const e = itemid === undefined ? undefined : entryByItemid.get(itemid);
          if (e === undefined) return null;
          const q = parts(e.eventtime);
          return {
            pic: g.pic,
            href: rootFor('images/index.html') + entryPath(e.ditemid),
            tip: esc(`${q.y}-${pad(q.m)}-${pad(q.d)} · ${e.subject ?? '(no subject)'}`),
          };
        })
        .filter((x): x is NonNullable<typeof x> => x !== null),
    }),
  );
  pages++;
  report({ kind: 'done', task: 'images page', summary: `${galleryRows.length} images` });

  // --- hour and mood slices (§11 M4) ------------------------------------
  // A stat you cannot click is a dead end. Every bar on Retrospect lands here.
  report({ kind: 'start', task: 'slices' });
  for (let h = 0; h < 24; h++) {
    const mine = entries.filter((e) => Number(parts(e.eventtime).hh) === h);
    if (mine.length === 0) continue;
    const rel = hourPath(h);
    const root = rootFor(rel);
    await page(
      rel,
      `${pad(h)}:00`,
      render(T.SLICE, {
        title: `Written between ${pad(h)}:00 and ${pad(h)}:59`,
        count: mine.length,
        backHref: root + 'retrospect/index.html',
        entries: mine
          .slice()
          .reverse()
          .map((e) => {
            const q = parts(e.eventtime);
            return {
              href: root + entryPath(e.ditemid),
              date: `${q.y}-${pad(q.m)}-${pad(q.d)} ${q.hh}:${q.mm}`,
              subject: esc(e.subject ?? '(no subject)'),
            };
          }),
      }),
    );
    pages++;
  }
  const moodOf = (e: EntryRow): string | undefined =>
    e.mood ?? (e.moodid !== null ? moods.get(e.moodid) : undefined);
  const moodNames = [
    ...new Set(entries.map((e) => moodOf(e)).filter((m): m is string => m !== undefined)),
  ];
  const moodSlugs = assignSlugs(moodNames.map((m) => m.toLowerCase()));
  const moodSlugFor = (name: string): string =>
    moodSlugs.get(name.toLowerCase()) ?? slugify(name.toLowerCase());
  for (const name of moodNames) {
    const mine = entries.filter((e) => moodOf(e)?.toLowerCase() === name.toLowerCase());
    const rel = moodPath(moodSlugFor(name));
    const root = rootFor(rel);
    await page(
      rel,
      name,
      render(T.SLICE, {
        title: `Feeling ${esc(name)}`,
        count: mine.length,
        backHref: root + 'retrospect/index.html',
        entries: mine
          .slice()
          .reverse()
          .map((e) => {
            const q = parts(e.eventtime);
            return {
              href: root + entryPath(e.ditemid),
              date: `${q.y}-${pad(q.m)}-${pad(q.d)}`,
              subject: esc(e.subject ?? '(no subject)'),
            };
          }),
      }),
    );
    pages++;
  }
  report({ kind: 'done', task: 'slices', summary: `24 hours, ${moodNames.length} moods` });

  // --- music (§11 M4) ---------------------------------------------------
  report({ kind: 'start', task: 'music' });
  interface Played {
    artistKey: string;
    artist: string;
    song: string | null;
    e: EntryRow;
  }
  const played: Played[] = [];
  for (const e of entries) {
    const raw = e.music?.trim();
    if (raw === undefined || raw === '') continue;
    const { artist, song } = splitMusic(raw);
    const key = musicKey(artist);
    if (key === '') continue;
    played.push({ artistKey: key, artist, song, e });
  }
  const byArtist = new Map<string, Played[]>();
  for (const p2 of played) byArtist.set(p2.artistKey, [...(byArtist.get(p2.artistKey) ?? []), p2]);
  const artistSlugs = assignSlugs([...byArtist.keys()]);
  const artistSlugFor = (k: string): string => artistSlugs.get(k) ?? slugify(k);
  // Display the spelling the author used MOST — normalisation is for counting,
  // never for putting words in his mouth.
  const displayName = (ps: Played[]): string => {
    const tally = new Map<string, number>();
    for (const x of ps) tally.set(x.artist, (tally.get(x.artist) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]![0];
  };
  for (const [key, ps] of byArtist) {
    const rel = musicPath(artistSlugFor(key));
    const root = rootFor(rel);
    await page(
      rel,
      displayName(ps),
      render(T.ARTIST, {
        name: esc(displayName(ps)),
        count: ps.length,
        songCount: new Set(ps.map((x) => (x.song === null ? '' : musicKey(x.song))).filter(Boolean))
          .size,
        backHref: root + 'retrospect/index.html',
        entries: ps
          .slice()
          .reverse()
          .map((x) => {
            const q = parts(x.e.eventtime);
            return {
              href: root + entryPath(x.e.ditemid),
              date: `${q.y}-${pad(q.m)}-${pad(q.d)}`,
              subject: esc(x.e.subject ?? '(no subject)'),
              song: x.song === null ? '' : esc(x.song),
            };
          }),
      }),
    );
    pages++;
  }
  const artistTop = [...byArtist.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 10);
  const artistPeak = Math.max(1, ...artistTop.map(([, ps]) => ps.length));
  const songKeys = new Set(
    played.filter((x) => x.song !== null).map((x) => `${x.artistKey} :: ${musicKey(x.song!)}`),
  );
  const onceArtists = [...byArtist.values()].filter((ps) => ps.length === 1).length;
  report({ kind: 'done', task: 'music', summary: `${byArtist.size} artists` });

  // --- retrospect (§11 M4) ----------------------------------------------
  report({ kind: 'start', task: 'retrospect' });
  const hourCounts = Array.from(
    { length: 24 },
    (_, h) => entries.filter((e) => Number(parts(e.eventtime).hh) === h).length,
  );
  const hourPeak = Math.max(1, ...hourCounts);
  const moodRows = store.query(
    `SELECT COALESCE(e.mood, m.name) AS name, COUNT(*) AS n
       FROM entries e LEFT JOIN moods m ON m.moodid = e.moodid
      WHERE COALESCE(e.mood, m.name) IS NOT NULL
      GROUP BY LOWER(COALESCE(e.mood, m.name)) ORDER BY n DESC LIMIT 8`,
  ) as { name: string; n: number }[];
  // The REAL total, not the sum of the top 8 — the page says "N entries recorded
  // a mood", and the top 8 is not that number.
  const moodTotal =
    (
      store.query(
        'SELECT COUNT(*) AS n FROM entries WHERE mood IS NOT NULL OR moodid IS NOT NULL',
      ) as { n: number }[]
    )[0]?.n ?? 0;
  const moodPeak = Math.max(1, ...moodRows.map((r) => r.n));
  // Real entries only: the 1984 post is a deliberate backdated joke and would
  // otherwise report this journal as spanning 26 years.
  const realTimes = entries
    .map((e) => e.eventtime)
    .filter((t) => t > '2000')
    .sort();
  const firstT = realTimes[0] ?? '';
  const lastT = realTimes[realTimes.length - 1] ?? '';
  const dayMs = 86_400_000;
  const spanDays =
    firstT && lastT
      ? Math.round(
          (Date.parse(lastT.replace(' ', 'T') + 'Z') - Date.parse(firstT.replace(' ', 'T') + 'Z')) /
            dayMs,
        )
      : 0;
  const privateN = entries.filter((e) => e.security === 'private').length;

  const R = 'retrospect/index.html';
  const rr = rootFor(R);
  const dOf = (e: EntryRow): string => {
    const q = parts(e.eventtime);
    return `${q.y}-${pad(q.m)}-${pad(q.d)}`;
  };
  const words = (b: string): number =>
    b
      .replace(/<[^>]*>/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

  // Records. Every one links to the thing it describes — a number you can't click
  // is a dead end, and this page is nothing but numbers.
  const longestE = entries.reduce((a, b) => (words(b.body) > words(a.body) ? b : a));
  const commentTally = new Map<number, number>();
  for (const c of comments) commentTally.set(c.jitemid, (commentTally.get(c.jitemid) ?? 0) + 1);
  const mostCommented = entries.reduce((a, b) =>
    (commentTally.get(b.itemid) ?? 0) > (commentTally.get(a.itemid) ?? 0) ? b : a,
  );
  // The deepest thread, and WHICH entry it happened in.
  const deepInfo = (() => {
    const byId = new Map(comments.map((c) => [c.id, c]));
    let best = { n: 0, jitemid: 0 };
    for (const c of comments) {
      let d = 1;
      let p2 = c.parentid;
      while (p2 !== null && p2 !== undefined) {
        d++;
        p2 = byId.get(p2)?.parentid ?? null;
      }
      if (d > best.n) best = { n: d, jitemid: c.jitemid };
    }
    return best;
  })();
  const deepEntry = entryByItemid.get(deepInfo.jitemid);
  const busiestKey = [...byDay.entries()].reduce((a, b) => (b[1].length > a[1].length ? b : a));
  // The longest silence. Real entries only: the 1984 joke would report a 19-year
  // gap and be the only thing on this list.
  const realSorted = entries
    .filter((e) => e.eventtime > '2000')
    .map((e) => e.eventtime)
    .sort();
  const gap = (() => {
    let best = { days: 0, at: realSorted[0] ?? '' };
    for (let i = 1; i < realSorted.length; i++) {
      const d = Math.round(
        (Date.parse(realSorted[i]!.replace(' ', 'T') + 'Z') -
          Date.parse(realSorted[i - 1]!.replace(' ', 'T') + 'Z')) /
          86_400_000,
      );
      if (d > best.days) best = { days: d, at: realSorted[i]! };
    }
    return best;
  })();
  const gapEntry = entries.find((e) => e.eventtime === gap.at);

  await page(
    R,
    'Retrospect',
    render(T.RETROSPECT, {
      ...totals,
      firstDate: firstT.slice(0, 10),
      lastDate: lastT.slice(0, 10),
      days: num(spanDays),
      months: MONTHS.map((m) => m[0]),
      heat: heatRows.map((r) => ({
        ...r,
        href: rr + yearPath(r.year),
        cells: r.cells.map((c, mi) => ({
          ...c,
          href: byMonth.has(`${r.year}-${pad(mi + 1)}`) ? rr + monthPath(r.year, mi + 1) : null,
        })),
      })),
      hours: hourCounts.map((n, h) => ({
        pct: Math.round((n / hourPeak) * 100),
        label: `${pad(h)}:00 — ${n} ${n === 1 ? 'entry' : 'entries'}`,
        href: n > 0 ? rr + hourPath(h) : null,
      })),
      // A real axis: ticks every 3 hours from 0 to 24, placed by fraction of the
      // day so midnight sits under the first bar and 24 closes the right edge.
      // Military time, 00..21. Not am/pm: the old axis printed "12a" at both 0 and
      // 24, wrong twice — it's a 24-bar chart of hours 00-23, and there is no 24.
      // Each tick centres under its bar: bar h spans [h/24, (h+1)/24], middle
      // (h + 0.5)/24.
      hourTicks: [0, 3, 6, 9, 12, 15, 18, 21].map((h) => ({
        label: pad(h),
        pct: ((h + 0.5) / 24) * 100,
      })),
      moods: moodRows.map((r) => ({
        name: esc(r.name),
        n: r.n,
        pct: Math.round((r.n / moodPeak) * 100),
        href: rr + moodPath(moodSlugFor(r.name)),
        tip: esc(`${r.n} ${r.n === 1 ? 'entry' : 'entries'} — read them`),
      })),
      moodTotal,
      musicTotal: played.length,
      artists: artistTop.map(([key, ps]) => ({
        name: esc(displayName(ps)),
        n: ps.length,
        pct: Math.round((ps.length / artistPeak) * 100),
        href: rr + musicPath(artistSlugFor(key)),
        tip: esc(`${ps.length} ${ps.length === 1 ? 'entry' : 'entries'} — read them`),
      })),
      artistTotal: num(byArtist.size),
      songTotal: num(songKeys.size),
      oncePct: Math.round((onceArtists / Math.max(1, byArtist.size)) * 100),
      tagTotal: sortedTags.length,
      tagsHref: rr + 'tags/index.html',
      taggedEntries: new Set(tagRows.map((t) => t.itemid)).size,
      longest: {
        words: num(words(longestE.body)),
        href: rr + entryPath(longestE.ditemid),
        date: dOf(longestE),
      },
      mostComments: {
        n: commentTally.get(mostCommented.itemid) ?? 0,
        href: rr + entryPath(mostCommented.ditemid),
        date: dOf(mostCommented),
      },
      deepest: {
        n: deepInfo.n,
        href: deepEntry ? rr + entryPath(deepEntry.ditemid) : rr + 'index.html',
      },
      busiest: {
        n: busiestKey[1].length,
        date: busiestKey[0],
        href:
          rr +
          dayPath(
            Number(busiestKey[0].split('-')[0]),
            Number(busiestKey[0].split('-')[1]),
            Number(busiestKey[0].split('-')[2]),
          ),
      },
      quietest: {
        days: num(gap.days),
        date: gap.at.slice(0, 10),
        href: gapEntry ? rr + entryPath(gapEntry.ditemid) : rr + 'index.html',
      },
      privatePct: Math.round((privateN / Math.max(1, entries.length)) * 100),
      friendsPct: Math.round(
        (entries.filter((e) => e.security === 'usemask').length / Math.max(1, entries.length)) *
          100,
      ),
      imagesKept,
      imagesLost,
      imagesHref: rr + 'images/index.html',
      userpicsHref: rr + 'userpics/index.html',
      peopleHref: rr + 'people/index.html',
      anon: anonCount,
      people: others.length,
      userpicCount:
        (
          store.query('SELECT COUNT(*) AS n FROM userpics WHERE hash IS NOT NULL') as {
            n: number;
          }[]
        )[0]?.n ?? 0,
      facesPeople:
        (
          store.query(
            'SELECT COUNT(DISTINCT userid) AS n FROM userpics WHERE hash IS NOT NULL',
          ) as {
            n: number;
          }[]
        )[0]?.n ?? 0,
    }),
  );
  pages++;
  report({ kind: 'done', task: 'retrospect' });

  // --- index + theme ----------------------------------------------------
  await page(
    'index.html',
    journal,
    render(T.INDEX, {
      journal: esc(journal),
      ...totals,
      // A decade at a glance, by month. 2004 has 348 entries and 2010 has 5, and
      // that curve is the story — a grid of year chips says nothing about shape.
      years: yearList.map((y) => ({ ...y, href: yearPath(y.year) })),
      recent: entries
        .slice(-30)
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
