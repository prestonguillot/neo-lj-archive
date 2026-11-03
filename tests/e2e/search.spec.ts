import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildFixture, type Fixture } from './fixture.js';

/**
 * Search in the static archive (DESIGN.md §7.4), driven at file:// — the only
 * condition it has to work under, and the one that rules out fetch(), modules,
 * and workers in Chromium and WebKit.
 *
 * The oracle is the browser's own DOM. What the search index says a page holds
 * is checked against what the page, rendered, actually holds.
 */

interface Rec {
  k: 'e' | 'c';
  u: string;
  t: string;
  s?: string;
  x: string;
}

let fx: Fixture;
const url = (rel: string): string => pathToFileURL(join(fx.site, rel)).href;
const squash = (s: string): string => s.replace(/\s+/g, '');

test.beforeAll(async () => {
  fx = await buildFixture();
});
test.afterAll(() => {
  rmSync(fx.dir, { recursive: true, force: true });
});

async function records(page: import('@playwright/test').Page): Promise<Rec[]> {
  await page.goto(url('search/index.html'));
  return page.evaluate(() => (window as unknown as { NEO_SEARCH: Rec[] }).NEO_SEARCH);
}

// catches: the index disagreeing with the page — indexing raw LJ markup (so
// `lj user="alice"` or a cut's attribute is findable but not on the page), or
// dropping text the page shows (the cut body, a lost-image marker), or a link
// that points at the wrong page or anchor. Every record, checked against the
// rendered DOM it links to. textContent, not innerText: a closed <details> still
// holds the reader's words.
test('every indexed text is exactly the text on the page it links to', async ({ page }) => {
  const recs = await records(page);
  expect(recs.length).toBeGreaterThan(0);
  for (const r of recs) {
    const [file, anchor] = r.u.split('#');
    await page.goto(url(file!));
    const sel = r.k === 'e' ? '.entry .body' : `#${anchor} > .body`;
    const onPage = await page.locator(sel).evaluate((el) => el.textContent ?? '');
    expect(squash(r.x), r.u).toBe(squash(onPage));
    if (r.k === 'c' && r.s !== undefined) {
      await expect(page.locator(`#${anchor} > h3`), r.u).toHaveText(r.s);
    }
  }
});

// catches: an entry or comment silently missing from search — e.g. collecting
// records only for top-level comments, or for entries that have comments.
// Counted against the rendered pages, not against the build's own bookkeeping.
test('every entry and every comment with words is searchable, once', async ({ page }) => {
  const recs = await records(page);
  const urls = recs.map((r) => r.u);
  expect(new Set(urls).size).toBe(urls.length);

  for (const entry of ['entries/266.html', 'entries/277.html']) {
    await page.goto(url(entry));
    expect(urls).toContain(entry);
    const withWords = await page
      .locator('article.comment')
      .evaluateAll((els) =>
        els
          .filter((el) => (el.querySelector(':scope > .body')?.textContent ?? '').trim() !== '')
          .map((el) => el.id),
      );
    for (const id of withWords) expect(urls).toContain(`${entry}#${id}`);
  }
  // The deleted comment has no words, and must not surface as an empty hit.
  expect(urls).not.toContain('entries/277.html#c10');
});

// catches: results that link nowhere from a nested page — the search page lives
// in search/, so a link built without the ../ root resolves to search/entries/…
test('typing a query finds the entry, and the result opens it', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));

  await page.goto(url('search/index.html'));
  // With JS on, the how-to-grep note gives way to the real form.
  await expect(page.locator('#nojs')).toBeHidden();
  await page.locator('#q').fill('after the cut');
  const hits = page.locator('#results li');
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText('A day with everything in it');
  await hits.first().locator('a').click();
  await expect(page).toHaveURL(/entries\/266\.html$/);
  await expect(page.locator('h1')).toHaveText('A day with everything in it');
  expect(problems).toEqual([]);
});

// catches: snippets built with innerHTML. The comment's words ARE markup; a
// result has to show them as text, not bold them or wire up their handler.
test('a comment that says <b> shows "<b>" in its result, inert', async ({ page }) => {
  let dialogs = 0;
  page.on('dialog', (d) => {
    dialogs++;
    void d.dismiss();
  });
  await page.goto(url('search/index.html'));
  await page.locator('#q').fill('not bold');
  const snip = page.locator('#results li .snippet');
  await expect(snip).toHaveCount(1);
  await expect(snip).toContainText('<b onmouseover=alert(1)>');
  await expect(snip.locator('b')).toHaveCount(0);
  await snip.hover();
  expect(dialogs).toBe(0);
});

// catches: accents and entity-encoded subjects defeating search. "cafe" must find
// a comment that says café, under a subject LJ stored as Caf&#233;.
test('a search ignores accents, and scope narrows to comments', async ({ page }) => {
  // Appended after pathToFileURL, which would percent-encode the '#'.
  await page.goto(url('search/index.html') + '#q=cafe&in=comments');
  const hits = page.locator('#results li');
  await expect(hits).toHaveCount(1);
  await expect(hits.first()).toContainText('Café thoughts');
  await expect(hits.first().locator('mark').first()).toHaveText('café');

  await page.locator('input[name="in"][value="entries"]').check();
  await expect(page.locator('#status')).toHaveText('Nothing matches.');
});

// catches: the search page requiring script to explain itself. With JS off the
// form is useless, so it stays hidden and the reader is told how to grep.
test.describe('with JavaScript off', () => {
  test.use({ javaScriptEnabled: false });
  test('the page says how to search without it', async ({ page }) => {
    await page.goto(url('search/index.html'));
    await expect(page.locator('#search')).toBeHidden();
    await expect(page.locator('#nojs')).toBeVisible();
    await expect(page.locator('#nojs')).toContainText('grep');
  });
});

// Search by meaning, built with a tiny model through the real browser engine.
// What's checked is the plumbing at file:// — scripts load, the model decodes
// and runs, results link to real pages, the toggle falls back to exact words —
// not the quality of a 4-dimensional model.
test.describe('search by meaning', () => {
  let sem: Fixture;
  const semUrl = (rel: string): string => pathToFileURL(join(sem.site, rel)).href;
  test.beforeAll(async () => {
    sem = await buildFixture({ semantic: true });
  });
  test.afterAll(() => rmSync(sem.dir, { recursive: true, force: true }));

  // catches: the model or vectors failing to load from file:// — a classic-script
  // global missing, a decode error — which would leave "by meaning" broken.
  test('runs offline and returns results that open', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (m) => {
      if (m.type() === 'error') problems.push(m.text());
    });
    page.on('pageerror', (e) => problems.push(String(e)));
    await page.route('http*://**', (r) => r.abort());

    await page.goto(semUrl('search/index.html'));
    await expect(page.locator('#meaning')).toBeChecked();
    await page.locator('#q').fill('snack chips');
    await expect(page.locator('#status')).toContainText('closest in meaning');
    const first = page.locator('#results li a').first();
    await expect(first).toBeVisible();
    const href = await first.getAttribute('href');
    expect(href).toMatch(/^\.\.\/entries\/\d+\.html/);
    await first.click();
    await expect(page.locator('h1')).toBeVisible();
    expect(problems).toEqual([]);
  });

  // catches: the toggle doing nothing — unticked, it must be exact-word search
  // again, AND semantics included.
  test('unticking it goes back to exact words', async ({ page }) => {
    await page.goto(semUrl('search/index.html'));
    await page.locator('#meaning').uncheck();
    await page.locator('#q').fill('after the cut');
    await expect(page.locator('#results li')).toHaveCount(1);
    await expect(page.locator('#status')).toContainText('match');
  });
});

// catches: the meaning toggle, or its scripts, appearing on a site built without
// vectors. The default build must be the keyword page it always was.
test('without vectors, the search page is keyword-only', async ({ page }) => {
  await page.goto(url('search/index.html'));
  await expect(page.locator('#meaning')).toHaveCount(0);
  const scripts = await page
    .locator('script[src]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('src')));
  expect(scripts).toEqual(['data.js', 'search.js']);
});
