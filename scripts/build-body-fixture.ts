import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { redactHtml } from './scrub-html.js';

/**
 * Build M2's oracle: real entry/comment HTML, selected for coverage, redacted.
 *
 * Why not the M1 fixtures: those are 40 entries captured for protocol shapes.
 * Images appear in only 122 of 1,547 entries, so a 40-entry slice yields 8
 * images across 4 hosts, zero <lj user>, zero <lj-cut>, and no photobucket —
 * a fixture that cannot exercise a single thing M2 does.
 *
 * Why not synthesise tag soup: an oracle you wrote yourself is a tautology
 * (DESIGN.md §10). This is still LiveJournal's bytes and 2005 Preston's markup.
 * Only the selection is ours, and selection is not authorship.
 *
 * Reads ./archive/archive.db (gitignored, private) and writes
 * tests/fixtures/bodies.json (committed, public) with prose, usernames and URL
 * paths redacted — hosts and structure kept, because they ARE the thing under
 * test (§5.2).
 *
 *   npx tsx scripts/build-body-fixture.ts
 */

interface Row {
  readonly kind: 'entry' | 'comment';
  readonly id: number;
  readonly html: string;
}

const DB = './archive/archive.db';
const OUT = new URL('../tests/fixtures/bodies.json', import.meta.url);

/** Cases M2 must handle. Each one is drawn from the real corpus. */
const CASES: { name: string; sql: string; limit: number }[] = [
  {
    name: 'photobucket images (the canonical poison host: 142 refs)',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%photobucket%'",
    limit: 12,
  },
  {
    name: 'other rotting hosts (comcast/quizilla/tripod/yimg)',
    sql: `SELECT itemid id, body html FROM entries WHERE body LIKE '%home.comcast.net%'
          OR body LIKE '%quizilla%' OR body LIKE '%tripod%' OR body LIKE '%yimg.com%'`,
    limit: 8,
  },
  {
    name: 'LJ-hosted images (most likely still alive)',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%pics.livejournal.com%'",
    limit: 4,
  },
  {
    name: '<lj user> references (204 uses, 193 distinct people)',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%<lj user%'",
    limit: 8,
  },
  {
    name: '<lj-cut> — including the 53 that are never closed',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%<lj-cut%'",
    limit: 8,
  },
  {
    name: 'embeds kept as links, not localized',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%<lj-embed%' OR body LIKE '%<iframe%' OR body LIKE '%<object%'",
    limit: 4,
  },
  {
    name: 'era tag soup: font/table layouts',
    sql: "SELECT itemid id, body html FROM entries WHERE body LIKE '%<font%' AND body LIKE '%<table%'",
    limit: 4,
  },
  {
    name: '<a href> pointing straight at an image',
    sql: `SELECT itemid id, body html FROM entries
          WHERE body LIKE '%href=%.jpg%' OR body LIKE '%href=%.gif%' OR body LIKE '%href=%.png%'`,
    limit: 4,
  },
];

const COMMENT_CASES: { name: string; sql: string; limit: number }[] = [
  {
    name: 'images inside comments (107 comments have them)',
    sql: "SELECT id, body html FROM comments WHERE body LIKE '%<img%'",
    limit: 10,
  },
  {
    name: '<lj user> inside comments',
    sql: "SELECT id, body html FROM comments WHERE body LIKE '%<lj user%'",
    limit: 4,
  },
];

function main(): void {
  const db = new DatabaseSync(DB, { readOnly: true });
  const picked = new Map<string, Row>();

  const take = (cases: typeof CASES, kind: Row['kind']): void => {
    for (const c of cases) {
      const rows = db.prepare(`${c.sql} ORDER BY id LIMIT ${c.limit}`).all() as {
        id: number;
        html: string;
      }[];
      for (const r of rows) picked.set(`${kind}:${r.id}`, { kind, id: r.id, html: r.html });
      console.log(`  ${String(rows.length).padStart(3)}  ${c.name}`);
    }
  };

  console.log('selecting from the real archive:');
  take(CASES, 'entry');
  take(COMMENT_CASES, 'comment');

  const bodies = [...picked.values()]
    .map((r) => ({ kind: r.kind, id: r.id, html: redactHtml(r.html).html }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id);

  mkdirSync(new URL('.', OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(bodies, null, 2) + '\n', 'utf8');

  const all = bodies.map((b) => b.html).join('\n');
  const n = (re: RegExp): number => (all.match(re) || []).length;
  const hosts = new Set([...all.matchAll(/(?:src|href)="https?:\/\/([^/"]+)/gi)].map((m) => m[1]));

  console.log(`\nwrote ${bodies.length} bodies -> tests/fixtures/bodies.json`);
  console.log(`  <img>          ${n(/<img\b/gi)}`);
  console.log(`  <lj user>      ${n(/<lj user/gi)}`);
  console.log(`  <lj-cut>       ${n(/<lj-cut/gi)}  (closed: ${n(/<\/lj-cut>/gi)})`);
  console.log(`  distinct hosts ${hosts.size}`);
  console.log(
    `  photobucket    ${[...hosts].some((h) => /photobucket/i.test(h)) ? 'present' : 'MISSING'}`,
  );
}

main();
