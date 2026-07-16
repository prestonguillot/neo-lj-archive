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
 * It answers two DIFFERENT questions, which must not be conflated:
 *
 *   1. Is archive.db complete?      Only the live page can say. A fetch/parse bug
 *                                   loses content before the renderer ever runs.
 *   2. Does the renderer drop what
 *      archive.db holds?           Answerable offline, by rendering the stored
 *                                   body and comparing. This is the <lj-embed>
 *                                   class, and it needs no network at all.
 *
 * It also harvests what the XML-RPC API refuses to give up: the per-entry and
 * per-comment userpics, and the embed URLs behind LJ's bare <lj-embed id="42">.
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
import { chromium, type Page } from '@playwright/test';
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

const words = (s: string): string[] =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w.length > 3);

/**
 * Find LJ's rendering of the entry body WITHOUT a hardcoded CSS selector.
 *
 * LJ journals use S2 styles, so .entry-content / .asset-body / .entryText all
 * vary by theme and a wrong guess silently returns the page chrome instead of
 * the entry — a probe that can't fail for the reason we care about. Instead:
 * locate the deepest element that still contains a distinctive phrase from the
 * stored body. That element IS the body, whatever it's called.
 */
async function ljBodyText(page: Page, needle: string): Promise<string | null> {
  return page.evaluate((n: string) => {
    if (n.length < 8) return null;
    const hits = [...document.querySelectorAll('div,td,article,section,p')].filter((e) =>
      (e.textContent ?? '').includes(n),
    );
    if (hits.length === 0) return null;
    // Deepest match = tightest wrapper around the text.
    const deepest = hits.reduce((a, b) => (b.contains(a) ? a : b));
    return deepest.textContent ?? null;
  }, needle);
}

/**
 * Open a real window and wait for a human to log in. No password in the code, no
 * scripted auth to throttle, and whatever LJ asks for — captcha, 2FA, Sber ID —
 * a person can just answer.
 */
async function interactiveLogin(): Promise<void> {
  const b = await chromium.launch({ headless: false });
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  await page.goto('https://www.livejournal.com/login.bml');
  console.log('Log in in the window that just opened. Waiting (5 min timeout)...');
  // Wait for LJ itself to say we're in, rather than for a page/URL that might
  // just be the form again.
  await page
    .waitForFunction(() => document.cookie.includes('ljloggedin='), undefined, { timeout: 300_000 })
    .catch(() => {
      throw new Error('timed out waiting for login');
    });
  mkdirSync('./archive', { recursive: true });
  await ctx.storageState({ path: SESSION });
  await b.close();
  console.log(`session saved -> ${SESSION} (gitignored)`);
  console.log('now run: npx tsx scripts/audit-vs-live.mts 40');
}

async function main(): Promise<void> {
  if (process.argv.includes('--login')) return interactiveLogin();

  if (!existsSync(SESSION)) {
    throw new Error(`no saved session. Run first:\n  npx tsx scripts/audit-vs-live.mts --login`);
  }

  const rows = sample();
  console.log(`sampling ${rows.length} entries by shape, ${PACE_MS}ms apart\n`);

  const b = await chromium.launch();
  const ctx = await b.newContext({ storageState: SESSION });
  const page = await ctx.newPage();

  // Prove the session is live BEFORE auditing. An expired one silently serves
  // anonymous pages, and every entry would look like catastrophic "db loss"
  // when the truth is we were logged out.
  await page.goto(`https://${USER}.livejournal.com/`, { waitUntil: 'domcontentloaded' });
  const authed = (await ctx.cookies()).some((c) => c.name === 'ljloggedin' && c.value.length > 3);
  if (!authed) {
    await b.close();
    throw new Error('session expired — re-run with --login');
  }
  console.log('session is live\n');

  const report: Record<string, unknown>[] = [];
  let dbLoss = 0;
  let renderLoss = 0;
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
    const rendered = new Set(words(renderBody(r.body, ctxRender)));
    const droppedByRenderer = stored.filter((w) => !rendered.has(w));

    // Q1, live: does the DB hold what LJ shows?
    await page.goto(`https://${USER}.livejournal.com/${r.ditemid}.html`, {
      waitUntil: 'domcontentloaded',
    });
    const needle = words(r.body).slice(0, 4).join(' ');
    const live = await ljBodyText(page, needle);
    const liveWords = live === null ? [] : words(live);
    const storedSet = new Set(stored);
    // Words LJ renders that our stored body has no trace of.
    const missingFromDb = live === null ? [] : liveWords.filter((w) => !storedSet.has(w));

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
    if (missingFromDb.length > 3) dbLoss++;

    report.push({
      ditemid: r.ditemid,
      shape: r.shape,
      bodyLocated: live !== null,
      renderer_dropped_words: droppedByRenderer.length,
      db_missing_words: missingFromDb.length,
      userpics: [...new Set(pics)],
      embeds: frames,
    });

    const flag =
      droppedByRenderer.length > 0 ? ' RENDERER-LOSS' : missingFromDb.length > 3 ? ' DB-LOSS' : '';
    console.log(
      `${String(i + 1).padStart(3)}/${rows.length} ${r.ditemid} [${r.shape}] ` +
        `pics:${new Set(pics).size} embeds:${frames.length}${flag}`,
    );
    await page.waitForTimeout(PACE_MS);
  }

  await b.close();

  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync('./archive/audit/vs-live.json', JSON.stringify(report, null, 2));

  console.log(`\n--- ${rows.length} entries audited ---`);
  console.log(`renderer dropped content:  ${renderLoss}`);
  console.log(`db missing what LJ shows:  ${dbLoss}`);
  console.log(`userpic urls harvested:    ${picsFound}`);
  console.log(`embed urls harvested:      ${embedUrls}`);
  console.log(`bodies not located:        ${report.filter((r) => !r['bodyLocated']).length}`);
  console.log('\nreport: archive/audit/vs-live.json (gitignored — private content)');
}

await main();
