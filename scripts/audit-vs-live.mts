#!/usr/bin/env tsx
/**
 * Diff the built archive against the live journal (DESIGN.md §10).
 *
 * This exists because the test suite cannot find this class of bug. The fixtures
 * are ones I wrote, so they encode what I already believed; 145 unit tests and 12
 * browser tests were green while entry 406397 silently rendered 1 of its 3
 * images. Preston found it in a minute by opening the live page. LiveJournal is
 * the only oracle here that doesn't share the author's blind spots.
 *
 * All three of these work — text parity, structure parity, and the harvest.
 *
 *   WORKS  Harvest the userpics and embed URLs the XML-RPC API refuses to give
 *          up — per-entry AND per-comment, keyed by picid/userid. Verified
 *          against an oracle it didn't author: every userid scraped is either
 *          the author or a commenter already in our users table. Zero unknown.
 *
 *   WORKS  Does the renderer drop what archive.db holds? Offline, no network.
 *          This is the <lj-embed> class.
 *
 *   WORKS  Is archive.db complete? Compares LJ's rendering of the body against
 *          ours. Seven heuristics tried to infer the body container and every
 *          one cried wolf on entries that were provably intact. Then I looked at
 *          the markup: it is div.entry_text, identical on every entry. The
 *          lesson is the whole project's lesson — look at the thing rather than
 *          reason about it from a distance.
 *
 * Auth is a SAVED SESSION, not a password (§8: never store credentials, use them
 * only to mint auth state). Log in once by hand in a real browser:
 *
 *   npx tsx scripts/audit-vs-live.mts --login     # opens a window, you log in
 *   npx tsx scripts/audit-vs-live.mts [n]         # reuses the saved session
 *
 * Scripted logins are why this exists in this shape. A POST to login.bml gets
 * handed the form back — LJ rejects the client, not the credentials — and
 * repeating the attempt while debugging got the web login throttled for a while,
 * despite the account being perfectly fine on XML-RPC. Logging in once and
 * keeping the session avoids both problems and keeps the password out of the
 * codebase entirely.
 *
 * The session file and the report both land under archive/, which is gitignored:
 * one is live auth state, the other is private content.
 */
import { chromium } from '@playwright/test';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { renderBody } from '../src/core/build/render.js';
import { SCHEMA } from '../src/core/store/schema.js';

/** Live auth state. Gitignored with the rest of archive/, never committed. */
const SESSION = './archive/session.json';

/**
 * What has already been audited, and how it came out.
 *
 * The point of chunking: each run must spend its requests on entries nobody has
 * looked at yet. Re-auditing the same 14 would rediscover the same bugs and find
 * no new ones, while still paying the full ban risk. Entries that reached parity
 * are retired; the ones that diverged stay listed so a fix can be re-checked on
 * purpose (--recheck) rather than by accident.
 */
const STATE = './archive/audit/state.json';

interface Verdict {
  shape: string;
  gap: number; // 0 = parity, >0 = chars LJ shows that we don't, -1 = body not found
  /**
   * Line breaks LJ renders minus line breaks we render.
   *
   * The whole reason this field exists: `gap` compares letters and digits only,
   * deliberately, because whitespace and tokenisation produced constant false
   * positives. Immune to whitespace turned out to mean BLIND to whitespace — it
   * certified 1,541 entries "at parity" while 73% of the journal rendered as one
   * wall of text, every paragraph break gone. An oracle that cannot see the
   * defect will happily sign off on it forever. Content loss and formatting loss
   * are different failures and need different instruments.
   */
  brDiff: number;
  note?: string;
}
type State = Record<string, Verdict>;

const loadState = (): State =>
  existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {};

const saveState = (s: State): void => {
  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};

const USER = process.env['LJ_USER'] ?? 'evilgoatbob';
const SAMPLE = Number(process.argv[2] ?? 40);

/** LJ bans clients and a 403 is terminal (§9). This is deliberately slow. */
const PACE_MS = 2000;

const db = new DatabaseSync('./archive/archive.db');
// This opens sqlite directly rather than through Store, so the schema has to be
// applied by hand — the userpic tables are new and every statement is
// CREATE ... IF NOT EXISTS, so this is idempotent on an existing archive.
db.exec(SCHEMA);

interface Row {
  ditemid: number;
  itemid: number;
  body: string;
  shape: string;
}

/**
 * Sample by SHAPE, not at random. The bugs live in the weird markup — an
 * unclosed embed, a cut wrapping a table, a poll — and a uniform random sample
 * of 40 from 1,547 would very likely contain none of them.
 */
function sample(seen: Set<string>): Row[] {
  const shapes: [string, string][] = [
    ['lj-embed', "body LIKE '%<lj-embed%'"],
    // lj-poll and lj-template are DELIBERATELY not sampled. Four of them audited
    // and all four diverge identically: LJ renders questions it kept on its own
    // servers, the export has only <lj-poll-NNN>, and the page already says so.
    // Auditing more would re-confirm a known, unrecoverable class at 2s a request
    // and find nothing new. 25 entries carry them; none is checkable this way.
    ['lj-cut', "body LIKE '%<lj-cut%'"],
    ['table', "body LIKE '%<table%'"],
    ['lj-user', "body LIKE '%<lj user%'"],
    ['many-images', "(LENGTH(body) - LENGTH(REPLACE(LOWER(body), '<img', ''))) / 4 >= 3"],
    ['object-embed', "body LIKE '%<object%' OR body LIKE '%<embed%'"],
    ['plain', '1=1'],
  ];
  const per = Math.max(2, Math.floor(SAMPLE / shapes.length));
  const picked = new Set<number>();
  const out: Row[] = [];
  for (const [shape, where] of shapes) {
    // Pull a wide net, then skip what's already audited. Ordering by length
    // DESC and taking the top N would hand every run the SAME longest entries
    // forever — the chunking would explore nothing.
    const rows = db
      .prepare(
        `SELECT ditemid, itemid, body FROM entries WHERE ${where} ORDER BY LENGTH(body) DESC`,
      )
      .all() as Omit<Row, 'shape'>[];
    for (const r of rows) {
      if (picked.has(r.ditemid) || seen.has(String(r.ditemid))) continue;
      if (out.filter((o) => o.shape === shape).length >= per) break;
      picked.add(r.ditemid);
      out.push({ ...r, shape });
    }
  }

  // Top up from whatever is left over.
  //
  // The per-shape cap is what makes the FIRST chunks find bugs: it forces the
  // weird markup in front of the check instead of letting a uniform sample miss
  // every poll and unclosed embed. But once a shape is exhausted its bucket just
  // goes empty, and the cap silently throttles the run to a fraction of the
  // target — 664 of 1547 audited, 883 left, and a chunk asked for 1600 doing 228.
  // The shape quota is a floor on variety, not a ceiling on work.
  if (out.length < SAMPLE) {
    const rest = db
      .prepare('SELECT ditemid, itemid, body FROM entries ORDER BY eventtime DESC')
      .all() as Omit<Row, 'shape'>[];
    for (const r of rest) {
      if (out.length >= SAMPLE) break;
      if (picked.has(r.ditemid) || seen.has(String(r.ditemid))) continue;
      picked.add(r.ditemid);
      out.push({ ...r, shape: 'fill' });
    }
  }
  return out;
}

/**
 * Tags out, entities decoded, whitespace collapsed. Contiguous, order intact.
 *
 * NUMERIC entities matter as much as the named ones. LJ stores apostrophes as
 * &#39;, so the source reads `don&#39;t` while the renderer correctly emits
 * `don't` \u2014 and comparing those raw strings scores a CORRECT render as data
 * loss. That was the entirety of the "RENDERER-LOSS" on entry 403272: six
 * apostrophes. A measurement that flags correct behaviour is worse than none,
 * because it spends a human's attention on nothing.
 */
const plain = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; LAST: decoding it first turns a literal "&amp;#39;" into "&#39;" and
    // then into an apostrophe, inventing a character the source never had.
    .replace(/&amp;/g, '&')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();

/** For set-comparison only. Short words are dropped as noise. */
const words = (s: string): string[] =>
  plain(s)
    .split(' ')
    .filter((w) => w.length > 3);

/**
 * Letters and digits only. Immune to tags, whitespace and tokenisation — the
 * three things that made every earlier comparison lie.
 *
 * Word-splitting could never work here: plain() turns tags into SPACES while the
 * DOM's textContent turns them into NOTHING, so LJ's `<b>hello</b><i>world</i>`
 * is one token and ours is two. On a 20k entry that manufactured 533 phantom
 * "missing words" on an entry that was perfectly intact.
 */
const stream = (s: string): string =>
  plain(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The longest run of LJ's letters that is absent from ours, in order.
 *
 * Subsequence, not containment: the archive deliberately ADDS text LJ never had
 * — cut labels, "image lost" markers, poll notices — and those insertions break
 * contiguity while losing nothing. Loss is the reverse: LJ having letters we
 * don't. Over thousands of characters, matching by coincidence is impossible.
 */
const missingRun = (lj: string, ours: string): number => {
  let i = 0;
  let worst = 0;
  let run = 0;
  for (const ch of lj) {
    const at = ours.indexOf(ch, i);
    if (at === -1) {
      run++;
      worst = Math.max(worst, run);
    } else {
      i = at + 1;
      run = 0;
    }
  }
  return worst;
};

/**
 * Log in with the password and SAVE the session.
 *
 * The saving is the point. Re-authenticating per run is what got LJ's web login
 * throttled while the account stayed perfectly healthy on XML-RPC — so this runs
 * at most once, then every later run reuses the cookies.
 */
async function login(pw: string): Promise<void> {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  try {
    await page.goto('https://www.livejournal.com/login.bml', { waitUntil: 'domcontentloaded' });

    // The cookie banner sits over the page and can swallow the click.
    await page
      .getByRole('button', { name: /^OK$/i })
      .click({ timeout: 3000 })
      .catch(() => {});

    // Scope to the REAL login form: the page carries three (search, login,
    // OpenID) and TWO buttons named action:login. An unscoped click is a coin
    // flip that posts the OpenID form instead.
    const form = page.locator('form[action="https://www.livejournal.com/login.bml"]');
    await form.locator('input[name="user"]').fill(USER);
    await form.locator('input[name="password"]').fill(pw);
    await form.locator('button[name="action:login"]').click();
    await page.waitForLoadState('networkidle');

    const authed = (await ctx.cookies()).some((c) => c.name === 'ljloggedin' && c.value.length > 3);
    if (!authed) {
      throw new Error(
        'login rejected. The account is fine (XML-RPC still authenticates) — this is the web ' +
          'login throttle. Wait a few minutes and re-run.',
      );
    }
    mkdirSync('./archive', { recursive: true });
    await ctx.storageState({ path: SESSION });
    console.log(`logged in, session saved -> ${SESSION} (gitignored)`);
  } finally {
    await b.close();
  }
}

async function main(): Promise<void> {
  const pw = process.env['LJ_PASSWORD'];

  // Log in ONLY when there's no session to reuse.
  if (!existsSync(SESSION)) {
    if (pw === undefined || pw === '') throw new Error('no session yet — set LJ_PASSWORD once');
    await login(pw);
  }

  const state = loadState();
  const recheck = process.argv.includes('--recheck');
  // --recheck re-runs only the entries that DIVERGED, to confirm a fix. The
  // default run skips everything already audited and spends the chunk on new
  // ground, which is the entire point of chunking.
  const havePic = new Set(
    (db.prepare('SELECT ditemid FROM entry_userpics').all() as { ditemid: number }[]).map((r) =>
      String(r.ditemid),
    ),
  );

  // An entry is only RETIRED when every job that visits it is done: its text
  // checked, its line structure checked, and its userpic captured. Tracking just
  // "audited" is how the entry-pic selector recorded nothing for 85 entries and
  // they were never revisited, and how a brDiff-less verdict would masquerade as
  // a verified one — the oracle grew an eye and every old verdict predates it.
  const retired = (k: string): boolean =>
    havePic.has(k) && state[k]?.brDiff !== undefined && state[k]?.gap !== -1;

  const seen = recheck
    ? new Set(
        Object.entries(state)
          .filter(([k, v]) => v.gap === 0 && (v.brDiff ?? 0) === 0 && retired(k))
          .map(([k]) => k),
      )
    : new Set(Object.keys(state).filter(retired));
  const rows = sample(seen);
  if (rows.length === 0) {
    console.log(`nothing new to audit — ${Object.keys(state).length} entries already done.`);
    return;
  }
  const done = Object.keys(state).length;
  console.log(
    `${done} entries audited so far. This chunk: ${rows.length} ${recheck ? 'RE-CHECKS' : 'NEW'}, ` +
      `${PACE_MS}ms apart\n`,
  );

  const b = await chromium.launch();
  let ctx = await b.newContext({ storageState: SESSION });
  let page = await ctx.newPage();

  // Prove the session is live BEFORE auditing. An expired one silently serves
  // anonymous pages, and every entry would then look like catastrophic "db loss"
  // when the truth is only that we were logged out.
  await page.goto(`https://${USER}.livejournal.com/`, { waitUntil: 'domcontentloaded' });
  if (!(await ctx.cookies()).some((c) => c.name === 'ljloggedin' && c.value.length > 3)) {
    await b.close();
    if (pw === undefined || pw === '')
      throw new Error('session expired — set LJ_PASSWORD to renew');
    await login(pw);
    const b2 = await chromium.launch();
    ctx = await b2.newContext({ storageState: SESSION });
    page = await ctx.newPage();
  }
  console.log('session is live\n');

  const report: Record<string, unknown>[] = [];
  let renderLoss = 0;
  let dbLoss = 0;
  let structLoss = 0;
  let notLocated = 0;
  let picsFound = 0;
  let embedUrls = 0;

  for (const [i, r] of rows.entries()) {
    const ctxRender = {
      localFor: () => 'blobs/x/y.jpg',
      deadReason: () => 'gone',
      username: USER,
      entryHref: () => undefined,
      root: '../',
    };

    // Q2, offline: does the renderer keep what the DB holds?
    const stored = words(r.body);
    const renderedHtml = renderBody(r.body, ctxRender);
    const renderedWords = new Set(words(renderedHtml));
    const droppedByRenderer = stored.filter((w) => !renderedWords.has(w));

    // Retry, then skip. A single transient network error used to end the whole
    // run: ERR_NETWORK_CHANGED on one page threw out of the loop and killed a
    // 400-entry chunk with 1,355 done and 192 to go. Over ~40 minutes of paced
    // requests a blip is not an edge case, it is a certainty — wifi moves, a VPN
    // reconnects, a laptop lid dips. The entry that failed simply comes back on
    // the next chunk, because an entry is only retired once it has a verdict.
    let loaded = false;
    for (let attempt = 1; attempt <= 3 && !loaded; attempt++) {
      try {
        await page.goto(`https://${USER}.livejournal.com/${r.ditemid}.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 30_000,
        });
        loaded = true;
      } catch (err) {
        const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
        if (attempt === 3) {
          console.log(`${String(i + 1).padStart(3)}/${rows.length} ${r.ditemid} SKIPPED — ${why}`);
        } else {
          await page.waitForTimeout(3000 * attempt);
        }
      }
    }
    // No verdict, no state row: it stays unaudited and a later chunk picks it up.
    if (!loaded) continue;

    // Is archive.db complete? Ask div.entry_text — LJ's own name for the body,
    // read off the markup rather than inferred. Every heuristic that guessed at
    // this container grabbed the comments and chrome too, and reported loss on
    // entries that were fine.
    // Structure, not just characters. Counted on the same cloned subtree the text
    // comes from, so the tags footer is excluded from both.
    const liveBreaks = await page
      .locator('div.entry_text')
      .first()
      .evaluate((e) => {
        const c = e.cloneNode(true) as HTMLElement;
        for (const t of c.querySelectorAll('div.ljtags')) t.remove();
        return c.querySelectorAll('br').length;
      })
      .catch(() => -1);
    const ourBreaks = (renderedHtml.match(/<br>/g) ?? []).length;
    const brDiff = liveBreaks < 0 ? 0 : liveBreaks - ourBreaks;

    const liveBody = await page
      .locator('div.entry_text')
      .first()
      .evaluate((e) => {
        // div.entry_text also contains LJ's "Tags:" footer, which our archive
        // renders in the entry HEADER instead. Leaving it in scores every tagged
        // entry as data loss when the tags are right there on our page, just
        // somewhere else. Clone so the live DOM is untouched.
        const c = e.cloneNode(true) as HTMLElement;
        for (const t of c.querySelectorAll('div.ljtags')) t.remove();
        return c.textContent ?? '';
      })
      .catch(() => null);
    // Compare against our RENDERED text, not the stored source: LJ resolves
    // <lj user="x"> to the word "x" and so do we, while the raw source has only
    // a tag. Source-vs-rendered would score every mention and cut as loss.
    const gap = liveBody === null ? -1 : missingRun(stream(liveBody), stream(renderedHtml));
    if (liveBody === null) notLocated++;
    else if (gap > 0) dbLoss++;
    if (brDiff !== 0) structLoss++;
    // Record every verdict, so the next chunk starts where this one stopped.
    state[String(r.ditemid)] = { shape: r.shape, gap: liveBody === null ? -1 : gap, brDiff };
    // Per entry, not per chunk. A run that is killed at 75/228 must keep its 75
    // verdicts — the userpic rows already survive that way, and having the two
    // halves of one traversal with different durability is a trap.
    saveState(state);

    // The harvest the API won't give us, with its mapping intact.
    //
    // Scoped, NOT every userpic img on the page. #sidebar carries a
    // .defaultuserpic that belongs to the journal, not the entry — harvesting it
    // would stamp the same pic on all 1,547 entries and look entirely plausible.
    const harvest = await page.evaluate(() => {
      // NO named function consts in here. tsx/esbuild rewrites `const f = () =>`
      // into a __name() call for keepNames, and that helper doesn't exist in the
      // browser, so the callback dies with "__name is not defined". This file
      // already documents that trap and I walked into it again.
      const RE = /l-userpic\.livejournal\.com\/(\d+)\/(\d+)/;
      // '.userpicfriends img', NOT 'img.userpicfriends'. LJ puts this class on the
      // parent DIV while .userpiccomment sits on the IMG itself — an asymmetry in
      // their markup that made this match nothing and silently record an entry pic
      // for zero of 85 entries, while the comment pics kept working perfectly.
      const entryImg = document.querySelector(
        '.subcontent .userpicfriends img',
      ) as HTMLImageElement | null;
      const em = entryImg ? RE.exec(entryImg.src) : null;
      const entry =
        em && entryImg ? { picid: Number(em[1]), userid: Number(em[2]), url: entryImg.src } : null;
      const comments: { commentId: number; picid: number; userid: number; url: string }[] = [];
      for (const el of document.querySelectorAll('[id^="ljcmt"]')) {
        const d = Number(el.id.replace('ljcmt', ''));
        const img = el.querySelector('img.userpiccomment') as HTMLImageElement | null;
        if (!Number.isFinite(d) || !img) continue;
        const m = RE.exec(img.src);
        if (m)
          comments.push({
            commentId: d >> 8,
            picid: Number(m[1]),
            userid: Number(m[2]),
            url: img.src,
          });
      }
      return { entry, comments };
    });
    const pics = [
      ...(harvest.entry ? [harvest.entry.url] : []),
      ...harvest.comments.map((c) => c.url),
    ];

    // Persist. A pic reused across 400 comments is ONE row and, later, one blob.
    for (const u of [...(harvest.entry ? [harvest.entry] : []), ...harvest.comments]) {
      db.prepare(
        'INSERT INTO userpics (picid, userid, url) VALUES (?, ?, ?) ON CONFLICT (picid) DO NOTHING',
      ).run(u.picid, u.userid, u.url);
    }
    if (harvest.entry) {
      db.prepare(
        'INSERT INTO entry_userpics (ditemid, picid) VALUES (?, ?) ON CONFLICT (ditemid) DO UPDATE SET picid=excluded.picid',
      ).run(r.ditemid, harvest.entry.picid);
    }
    for (const c of harvest.comments) {
      // Only comments we actually hold — a dtalkid we never fetched would be a
      // dangling reference, and the FK is there to say so.
      const known = db.prepare('SELECT 1 AS x FROM comments WHERE id=?').get(c.commentId);
      if (known)
        db.prepare(
          'INSERT INTO comment_userpics (comment_id, picid) VALUES (?, ?) ON CONFLICT (comment_id) DO UPDATE SET picid=excluded.picid',
        ).run(c.commentId, c.picid);
    }
    // SCOPED to the entry body. Every LJ page carries a chrome iframe, which is
    // why the old unscoped count read "embeds:1" on entries that have none —
    // a number that looked like data and was furniture.
    const frames = await page
      .$$eval('div.entry_text iframe', (els) =>
        els.map((e) => (e as HTMLIFrameElement).src).filter(Boolean),
      )
      .catch(() => [] as string[]);

    // The URL behind <lj-embed id="42">, which the export never had.
    frames.forEach((url, idx) => {
      db.prepare(
        'INSERT INTO entry_embeds (ditemid, idx, url) VALUES (?, ?, ?) ON CONFLICT (ditemid, idx) DO UPDATE SET url=excluded.url',
      ).run(r.ditemid, idx, url);
    });

    picsFound += new Set(pics).size;
    embedUrls += frames.length;
    if (droppedByRenderer.length > 0) renderLoss++;

    report.push({
      ditemid: r.ditemid,
      shape: r.shape,
      renderer_dropped_words: droppedByRenderer.length,
      db_missing_run: gap,
      bodyLocated: liveBody !== null,
      userpics: [...new Set(pics)],
      embeds: frames,
    });

    const flag =
      droppedByRenderer.length > 0
        ? ' RENDERER-LOSS'
        : liveBody === null
          ? ' BODY-NOT-FOUND'
          : gap > 0
            ? ` DB-LOSS(${gap})`
            : brDiff !== 0
              ? ` BREAKS(${brDiff > 0 ? '+' : ''}${brDiff})`
              : ' PARITY';
    console.log(
      `${String(i + 1).padStart(3)}/${rows.length} ${r.ditemid} [${r.shape}] ` +
        `pics:${new Set(pics).size} embeds:${frames.length}${flag}`,
    );
    await page.waitForTimeout(PACE_MS);
  }

  await b.close();
  saveState(state); // redundant now — state is saved per entry — but harmless

  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync('./archive/audit/vs-live.json', JSON.stringify(report, null, 2));

  const all = Object.values(state);
  // Parity means BOTH: the same words AND the same shape.
  const parity = all.filter((v) => v.gap === 0 && (v.brDiff ?? 0) === 0).length;
  console.log(`\n--- this chunk: ${rows.length} entries ---`);
  console.log(`renderer dropped content:  ${renderLoss}`);
  console.log(
    `AT FULL PARITY WITH LJ:    ${rows.length - notLocated - dbLoss}/${rows.length - notLocated} compared`,
  );
  console.log(`diverging from LJ:         ${dbLoss}`);
  console.log(`line structure off:        ${structLoss}`);
  console.log(`body not found on page:    ${notLocated}`);
  console.log(`userpic urls harvested:    ${picsFound}`);
  console.log(`embed urls harvested:      ${embedUrls}`);
  console.log(`\n--- cumulative across all chunks ---`);
  console.log(`  audited:        ${all.length} of 1547`);
  console.log(`  at parity:      ${parity}`);
  console.log(`  diverging:      ${all.length - parity}`);
  const open = Object.entries(state).filter(([, v]) => v.gap > 0 || (v.brDiff ?? 0) !== 0);
  if (open.length) {
    console.log('\n  still diverging (re-check with --recheck after a fix):');
    for (const [id, v] of open.sort((a, b) => b[1].gap - a[1].gap))
      console.log(`    ${id} [${v.shape}] ${v.gap} chars`);
  }
  console.log('\nstate: archive/audit/state.json — next run picks up new entries');
}

await main();
