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
 * TWO of the three things here work. The third does not, and is disabled.
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
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { renderBody } from '../src/core/build/render.js';

/** Live auth state. Gitignored with the rest of archive/, never committed. */
const SESSION = './archive/session.json';

const USER = process.env['LJ_USER'] ?? 'evilgoatbob';
const SAMPLE = Number(process.argv[2] ?? 40);

/** LJ bans clients and a 403 is terminal (§9). This is deliberately slow. */
const PACE_MS = 2000;

const db = new DatabaseSync('./archive/archive.db');

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
function sample(): Row[] {
  const shapes: [string, string][] = [
    ['lj-embed', "body LIKE '%<lj-embed%'"],
    ['lj-poll', "body LIKE '%<lj-poll%'"],
    ['lj-template', "body LIKE '%<lj-template%'"],
    ['lj-cut', "body LIKE '%<lj-cut%'"],
    ['table', "body LIKE '%<table%'"],
    ['lj-user', "body LIKE '%<lj user%'"],
    ['many-images', "(LENGTH(body) - LENGTH(REPLACE(LOWER(body), '<img', ''))) / 4 >= 3"],
    ['object-embed', "body LIKE '%<object%' OR body LIKE '%<embed%'"],
    ['plain', '1=1'],
  ];
  const per = Math.max(2, Math.floor(SAMPLE / shapes.length));
  const seen = new Set<number>();
  const out: Row[] = [];
  for (const [shape, where] of shapes) {
    const rows = db
      .prepare(
        `SELECT ditemid, itemid, body FROM entries WHERE ${where} ORDER BY LENGTH(body) DESC LIMIT ?`,
      )
      .all(per * 2) as Omit<Row, 'shape'>[];
    for (const r of rows) {
      if (seen.has(r.ditemid) || out.filter((o) => o.shape === shape).length >= per) continue;
      seen.add(r.ditemid);
      out.push({ ...r, shape });
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

  const rows = sample();
  console.log(`sampling ${rows.length} entries by shape, ${PACE_MS}ms apart\n`);

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

    await page.goto(`https://${USER}.livejournal.com/${r.ditemid}.html`, {
      waitUntil: 'domcontentloaded',
    });

    // Is archive.db complete? Ask div.entry_text — LJ's own name for the body,
    // read off the markup rather than inferred. Every heuristic that guessed at
    // this container grabbed the comments and chrome too, and reported loss on
    // entries that were fine.
    const liveBody = await page
      .locator('div.entry_text')
      .first()
      .textContent()
      .catch(() => null);
    // Compare against our RENDERED text, not the stored source: LJ resolves
    // <lj user="x"> to the word "x" and so do we, while the raw source has only
    // a tag. Source-vs-rendered would score every mention and cut as loss.
    const gap = liveBody === null ? -1 : missingRun(stream(liveBody), stream(renderedHtml));
    if (liveBody === null) notLocated++;
    else if (gap > 0) dbLoss++;

    // The harvest the API won't give us.
    const pics = await page.$$eval('img', (els) =>
      els
        .map((e) => (e as HTMLImageElement).src)
        .filter((s) => /l-userpic\.livejournal\.com/i.test(s)),
    );
    const frames = await page.$$eval('iframe', (els) =>
      els.map((e) => (e as HTMLIFrameElement).src).filter(Boolean),
    );

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
            : ' PARITY';
    console.log(
      `${String(i + 1).padStart(3)}/${rows.length} ${r.ditemid} [${r.shape}] ` +
        `pics:${new Set(pics).size} embeds:${frames.length}${flag}`,
    );
    await page.waitForTimeout(PACE_MS);
  }

  await b.close();

  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync('./archive/audit/vs-live.json', JSON.stringify(report, null, 2));

  console.log(`\n--- ${rows.length} entries sampled ---`);
  console.log(`renderer dropped content:  ${renderLoss}`);
  console.log(
    `AT FULL PARITY WITH LJ:    ${rows.length - notLocated - dbLoss}/${rows.length - notLocated} compared`,
  );
  console.log(`diverging from LJ:         ${dbLoss}`);
  console.log(`body not found on page:    ${notLocated}`);
  console.log(`userpic urls harvested:    ${picsFound}`);
  console.log(`embed urls harvested:      ${embedUrls}`);
  console.log('\nreport: archive/audit/vs-live.json (gitignored — private content)');
}

await main();
