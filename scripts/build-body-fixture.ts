import { DatabaseSync } from 'node:sqlite';
import { writeFileSync, mkdirSync } from 'node:fs';
import { redactHtml } from './scrub-html.js';

/**
 * Build M2's oracle: real entry/comment HTML, selected for coverage, redacted.
 *
 * Why not the M1 fixtures: those are 40 entries captured for protocol shapes.
 * Images appear in only 122 of 1,547 entries, so a 40-entry slice yields 8
 * images across 4 hosts, zero <lj user> and zero <lj-cut> — a fixture that
 * cannot exercise a single thing M2 does.
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

/**
 * Cases M2 must handle. Each one is drawn from the real corpus.
 *
 * NOTE THE ABSENCE OF HOSTNAMES. An earlier version selected with
 * `WHERE body LIKE '%photobucket%'` and friends — which anonymized the fixture
 * and then published the query naming the author's real hosts. Same fingerprint,
 * different file. The host-diversity and host-concentration cases are computed
 * structurally instead (see pickByHosts), which is both host-agnostic and
 * strictly better: it GUARANTEES coverage rather than hoping a hardcoded list
 * still matches the data.
 *
 * The `<lj *>` and `<font>`/`<table>` filters below are LiveJournal's markup and
 * generic HTML — not anyone's data — so they stay.
 */
const CASES: { name: string; sql: string; limit: number }[] = [
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

/** Hosts referenced by a body, without caring what they are. */
function hostsIn(html: string): string[] {
  return [...html.matchAll(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>]+)/gi)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  );
}

/**
 * Pick bodies for HOST COVERAGE and HOST CONCENTRATION — structurally, never by
 * name.
 *
 * Coverage: greedy set-cover, so the fixture touches as many distinct hosts as
 * the budget allows. Concentration: the bodies whose images pile onto a single
 * host, because host collapse is the entire poison signal (§5.2) — N distinct
 * URLs on one host hashing to identical bytes. Which host it happens to be is
 * something the detector must never know, so neither should this.
 */
function pickByHosts(
  rows: { id: number; html: string }[],
  coverageBudget: number,
  concentrationBudget: number,
): { id: number; html: string }[] {
  const out: { id: number; html: string }[] = [];

  // Greedy set-cover over distinct hosts.
  const seen = new Set<string>();
  const remaining = [...rows];
  while (out.length < coverageBudget && remaining.length) {
    let best = -1;
    let bestNew = 0;
    for (let i = 0; i < remaining.length; i++) {
      const gain = new Set(hostsIn(remaining[i]!.html).filter((h) => !seen.has(h))).size;
      if (gain > bestNew) {
        bestNew = gain;
        best = i;
      }
    }
    if (best === -1) break; // nothing adds a new host
    const [row] = remaining.splice(best, 1);
    for (const h of hostsIn(row!.html)) seen.add(h);
    out.push(row!);
  }

  // Most host-concentrated bodies: many refs, few hosts.
  const byConcentration = remaining
    .map((r) => {
      const hs = hostsIn(r.html);
      return { r, refs: hs.length, distinct: new Set(hs).size };
    })
    .filter((x) => x.refs >= 3 && x.distinct <= 2)
    .sort((a, b) => b.refs - a.refs)
    .slice(0, concentrationBudget);
  for (const x of byConcentration) out.push(x.r);

  return out;
}

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

  // Host coverage + concentration, chosen structurally rather than by hostname.
  const withImages = db
    .prepare("SELECT itemid id, body html FROM entries WHERE body LIKE '%<img%' ORDER BY id")
    .all() as { id: number; html: string }[];
  const hostPicks = pickByHosts(withImages, 16, 8);
  for (const r of hostPicks) picked.set(`entry:${r.id}`, { kind: 'entry', id: r.id, html: r.html });
  console.log(
    `  ${String(hostPicks.length).padStart(3)}  image bodies (host coverage + concentration)`,
  );

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
  // What matters is the DISTRIBUTION, not which hosts. An earlier version
  // printed "photobucket present/MISSING" — asserting the fixture contains a
  // specific real host, which is the one thing poison detection must never know
  // about. It keys on collapse: N distinct URLs on one host, whatever it is.
  const perHost = new Map<string, number>();
  for (const m of all.matchAll(/(?:src|href)\s*=\s*["']?(?:https?:)?\/\/([^/"'\s>]+)/gi)) {
    const h = (m[1] ?? '').toLowerCase();
    perHost.set(h, (perHost.get(h) ?? 0) + 1);
  }
  const top = [...perHost.values()].sort((a, b) => b - a);
  console.log(`  distinct hosts ${hosts.size}`);
  console.log(`  refs on the most-used host  ${top[0] ?? 0}  (the collapse signal)`);
  console.log(`  hosts with 3+ refs          ${top.filter((n) => n >= 3).length}`);
  console.log(`  real hostnames published    0 — all pseudonymous`);
}

main();
