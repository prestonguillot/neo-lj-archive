import { test, expect } from '@playwright/test';
import { rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { buildFixture, type Fixture } from './fixture.js';

/**
 * The archive's promise is "open index.html, offline, forever" (DESIGN.md §13).
 *
 * A real browser is the only oracle for that. The link checker proves files
 * exist; it cannot prove Chromium renders them, that the stylesheet applies, or
 * that an image decodes. Everything here runs over file:// with no server, which
 * is the condition the promise is actually made under.
 */

let fx: Fixture;
const url = (rel: string): string => pathToFileURL(join(fx.site, rel)).href;

test.beforeAll(async () => {
  fx = await buildFixture();
});
test.afterAll(() => {
  rmSync(fx.dir, { recursive: true, force: true });
});

// A JS error, a failed stylesheet, a 404'd image — all of it is invisible in the
// HTML source and loud in the browser. Nothing in the archive may need JS at all.
test('opens from file:// with no console errors and no network', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(String(e)));
  // Anything leaving the machine breaks "works offline". There is no server to
  // fall back to, so a remote font or script is a permanent hole.
  await page.route('http://**', (r) => r.abort());
  await page.route('https://**', (r) => r.abort());

  await page.goto(url('index.html'));
  await expect(page.locator('h1')).toBeVisible();
  expect(problems).toEqual([]);
});

// catches: the stylesheet not loading. Relative paths from a nested page are the
// exact thing that breaks under file://, and an unstyled archive still "works"
// in every check that only reads HTML.
test('the stylesheet applies on a page nested three deep', async ({ page }) => {
  await page.goto(url('calendar/2004/03/15.html'));
  const body = page.locator('body');
  // A default UA background is white/transparent; the theme sets its own.
  const bg = await body.evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgba(0, 0, 0, 0)');
  const font = await body.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(font).toMatch(/serif/i);
});

// catches: a recovered image that exists on disk but never renders. naturalWidth
// is 0 unless Chromium actually decoded the bytes, so this cannot pass on a
// broken or unreadable file the way existsSync can.
test('a recovered image decodes from its local copy', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  const img = page.locator('.body img').first();
  await expect(img).toBeVisible();
  const decoded = await img.evaluate((el: HTMLImageElement) => el.naturalWidth > 0 && el.complete);
  expect(decoded).toBe(true);
  // And it points inside the site, not at a 2004 host that no longer answers.
  expect(await img.getAttribute('src')).toContain('blobs/');
});

// catches: a dead image rendering as a silent grey box. 254 refs in the real
// journal are gone; §4.3 says each one has to say so where it stood.
test('a lost image says what was lost and why', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  const marker = page.locator('.dead-image');
  await expect(marker).toBeVisible();
  await expect(marker).toContainText('the lost one');
  await expect(marker).toContainText('gone.invalid');
  await expect(marker).toContainText('404');
});

// catches: <lj user> rendering as nothing — a browser drops the unknown tag and
// keeps its text, and <lj user="x"> has no text. Two in a row also nest, which
// silently ate the second name in production.
test('both people in a row render as links', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  // Scoped to the entry body: comment authors are lj-user links too, so an
  // unscoped count measures the commenters and not the thing under test.
  const mentions = page.locator('.entry .body .lj-user');
  await expect(mentions).toHaveCount(2);
  await expect(mentions.nth(0)).toHaveText('alice');
  await expect(mentions.nth(1)).toHaveText('bob');
  await expect(mentions.nth(0)).toHaveAttribute('href', 'https://alice.livejournal.com/');
});

// catches: a poll rendering as silence. The entry reads "So LiveJournal, I ask
// you:" and then nothing — the reader can't tell anything is missing.
test('a poll LJ kept server-side is named, not dropped', async ({ page }) => {
  await page.goto(url('entries/277.html'));
  await expect(page.locator('.lj-lost')).toContainText('poll');
  await expect(page.locator('.lj-lost')).toContainText('1438708');
  // The prose after the unclosed tag survives it.
  await expect(page.locator('.body')).toContainText('And life went on');
});

// catches: an unclosed cut swallowing or hiding the rest of the entry. 54 of 69
// real cuts never close, and <details> without `open` hides the body behind a
// click the archive never asked for.
test('an unclosed cut expands to the end of the entry, already open', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  const cut = page.locator('details.lj-cut');
  await expect(cut).toHaveAttribute('open', '');
  // Visible without interaction: the text is readable as the page loads.
  await expect(page.locator('details.lj-cut')).toContainText('Everything after the cut');
  await expect(cut.locator('summary')).toHaveText('the rest of it');
});

// catches: threading flattened to a list. parentid NULL means top-level; reading
// it as 0 would put all 8 replies at the root and lose who answered whom.
test('comments nest as a real thread', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  await expect(page.locator('article.comment')).toHaveCount(8);
  // The deepest reply is a DOM descendant of every reply above it.
  const depth = await page
    .locator('article.comment', { hasText: 'Reply at depth 8' })
    .last()
    .evaluate((el) => {
      let d = 0;
      for (let n = el.parentElement; n; n = n.parentElement) {
        if (n.matches('article.comment')) d++;
      }
      return d;
    });
  expect(depth).toBe(7);
});

// catches: a private entry gated behind something. It's the author's own journal
// — private entries are kept and MARKED, never hidden.
test('a private entry is marked but fully readable', async ({ page }) => {
  await page.goto(url('entries/277.html'));
  await expect(page.locator('.security-private')).toContainText('private');
  await expect(page.locator('.body')).toContainText('So LiveJournal, I ask you');
});

// catches: navigation that dead-ends. The calendar is tablestakes (§7.2), and a
// day page that can't reach its entry is decoration.
test('you can walk index -> year -> day -> entry by clicking', async ({ page }) => {
  await page.goto(url('index.html'));
  await page.getByRole('link', { name: /2004/ }).first().click();
  await expect(page).toHaveURL(/calendar\/2004\/index\.html/);
  await page.locator('table.cal a').first().click();
  await expect(page).toHaveURL(/calendar\/2004\/03\/15\.html/);
  await page.getByRole('link', { name: /A day with everything/ }).click();
  await expect(page.locator('h1')).toHaveText('A day with everything in it');
});

// catches: the schemeless 2003 href resolving as a relative path into a file://
// 404 rather than pointing at the site the author meant.
test('a bare hostname link points off-site, not at a local file', async ({ page }) => {
  await page.goto(url('entries/266.html'));
  const href = await page.getByRole('link', { name: 'that site' }).getAttribute('href');
  expect(href).toBe('http://www.somethingawful.com');
});

// catches: the mood vocabulary not resolving. 307 real entries carry a moodid
// and no text; showing nothing loses what the author actually said they felt.
test('a mood stored only as an id resolves to its name', async ({ page }) => {
  await page.goto(url('entries/277.html'));
  await expect(page.locator('.mood')).toContainText('exhausted');
});
