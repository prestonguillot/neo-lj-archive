import { describe, it, expect } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { Store } from './db.js';
import { parseCommentBody, parseCommentMeta, parseEvents } from '../fetch/parse.js';

/**
 * The oracle is the real journal, round-tripped: LJ's own bytes → parser →
 * SQLite → back out. Nothing here was authored by us (DESIGN.md §10).
 *
 * This is where the nullable shapes either survive or quietly become zeroes.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');

const entries = () => parseEvents(fixture('getevents-2004.xml'));
const meta = () => parseCommentMeta(fixture('export-comment-meta.xml'));
const bodies = () => parseCommentBody(fixture('export-comment-body.xml'));

/**
 * Users before comments — the order the real sync uses, because comment_meta
 * returns the usermaps and the index together. Foreign keys are ON, so a store
 * that skips this throws. Verified against the fixtures that every posterid in
 * both passes resolves in usermaps (7,523 of them, zero orphans), so the FK is
 * integrity rather than a landmine.
 */
const store = (): Store => {
  const s = Store.openMemory();
  s.putUsers(meta().usermaps);
  return s;
};

describe('Store — nullable shapes survive the round trip', () => {
  // catches: `undefined` bound straight into node:sqlite. It does not coerce to
  // NULL — it throws. Every nullable column here is a real LJ shape, so this is
  // the common path, not an edge case: the whole write dies on comment 1.
  it('writes comments whose parentid/posterid/body are absent', () => {
    const s = store();
    expect(() => s.putCommentBodies(bodies())).not.toThrow();
    expect(s.stats().comments).toBe(999);
  });

  // catches: writing comments before the users they reference. comment_meta
  // carries usermaps and the index together, so the real flow always has users
  // first — but nothing in the type system says so, and a reordered sync would
  // die on live data with an opaque "FOREIGN KEY constraint failed".
  it('rejects comments whose poster has not been recorded yet', () => {
    const empty = Store.openMemory(); // deliberately no putUsers
    expect(() => empty.putCommentBodies(bodies())).toThrow(/FOREIGN KEY/);
  });

  // catches: parentid stored as 0 for top-level comments. Flattens every thread,
  // silently, and nothing errors — you'd find out years later.
  it('stores absent parentid as NULL, never 0', () => {
    const s = store();
    s.putCommentBodies(bodies());
    const nulls = s.query('SELECT COUNT(*) AS n FROM comments WHERE parentid IS NULL') as {
      n: number;
    }[];
    const zeros = s.query('SELECT COUNT(*) AS n FROM comments WHERE parentid = 0') as {
      n: number;
    }[];
    expect(nulls[0]?.n).toBe(582);
    expect(zeros[0]?.n).toBe(0);
  });

  // catches: posterid stored as 0 for anonymous comments — inventing a user 0
  // that the FK cannot resolve, for 22 real comments.
  it('stores absent posterid as NULL, never 0', () => {
    const s = store();
    s.putUsers(meta().usermaps);
    s.putCommentMeta(meta().comments);
    const nulls = s.query('SELECT COUNT(*) AS n FROM comments WHERE posterid IS NULL') as {
      n: number;
    }[];
    expect(nulls[0]?.n).toBe(22);
  });

  // catches: a NOT NULL body column, or defaulting a deleted comment's body to
  // ''. Both erase the distinction between "deleted" and "said nothing".
  it('stores deleted comments with a NULL body, distinct from empty', () => {
    const s = store();
    s.putCommentBodies(bodies());
    const rows = s.query(
      "SELECT COUNT(*) AS n FROM comments WHERE state = 'D' AND body IS NULL",
    ) as { n: number }[];
    expect(rows[0]?.n).toBe(44);
  });

  // catches: a foreign key from comments.posterid that rejects anonymous
  // comments. FKs are ON, so if this were NOT NULL the write throws.
  it('accepts anonymous comments with foreign keys enforced', () => {
    const s = store();
    s.putUsers(meta().usermaps);
    expect(() => s.putCommentMeta(meta().comments)).not.toThrow();
    expect(s.stats().comments).toBe(6550);
  });
});

describe('Store — entries', () => {
  it('round-trips every entry', () => {
    const s = store();
    s.putEntries(entries());
    expect(s.stats().entries).toBe(20);
  });

  // catches: mood and moodid collapsed into one column. 2 of these entries have
  // a moodid and no mood text; folding them loses the mood entirely (§7.1).
  it('stores mood and moodid independently', () => {
    const s = store();
    s.putEntries(entries());
    const rows = s.query(
      'SELECT COUNT(*) AS n FROM entries WHERE moodid IS NOT NULL AND mood IS NULL',
    ) as { n: number }[];
    expect(rows[0]?.n).toBeGreaterThan(0);
  });

  // catches: props dropped on the floor. The archive is meant to be lossless —
  // LJ's odd props are still Preston's data.
  it('keeps unmodelled props as JSON', () => {
    const s = store();
    s.putEntries(entries());
    const rows = s.query("SELECT props_json FROM entries WHERE props_json != '{}'") as {
      props_json: string;
    }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(() => JSON.parse(rows[0]!.props_json)).not.toThrow();
  });
});

describe('Store — re-runs are free (§4.5)', () => {
  // catches: a second run duplicating rows, or accumulating tags. §4 principle 5
  // says re-runs are free; a fetcher that doubles the archive on every run is
  // the opposite of resumable.
  it('is idempotent across repeated writes', () => {
    const s = store();
    for (let i = 0; i < 3; i++) {
      s.putEntries(entries());
      s.putUsers(meta().usermaps);
      s.putCommentBodies(bodies());
    }
    expect(s.stats()).toMatchObject({ entries: 20, comments: 999, users: 194 });

    const tags = s.query('SELECT COUNT(*) AS n FROM entry_tags') as { n: number }[];
    const once = store();
    once.putEntries(entries());
    const tagsOnce = once.query('SELECT COUNT(*) AS n FROM entry_tags') as { n: number }[];
    expect(tags[0]?.n).toBe(tagsOnce[0]?.n);
  });

  // catches: comment_meta clobbering bodies already fetched. Meta arrives with
  // no text; if it overwrote, every re-run would blank 999 comment bodies.
  it('does not let the comment index blank out already-fetched bodies', () => {
    const s = store();
    s.putUsers(meta().usermaps);
    s.putCommentBodies(bodies());
    s.putCommentMeta(meta().comments); // index pass runs after bodies

    const rows = s.query(
      "SELECT COUNT(*) AS n FROM comments WHERE state = 'A' AND body IS NOT NULL",
    ) as { n: number }[];
    expect(rows[0]?.n).toBe(955);
  });
});

describe('Store — sync state', () => {
  it('round-trips checkpoints', () => {
    const s = store();
    expect(s.getState('comments.startid')).toBeUndefined();
    s.setState('comments.startid', '1000');
    expect(s.getState('comments.startid')).toBe('1000');
    s.setState('comments.startid', '2000');
    expect(s.getState('comments.startid')).toBe('2000');
  });
});

/**
 * Migration (DESIGN.md §10). CREATE TABLE IF NOT EXISTS never changes a live
 * table's shape, so a column added later never reaches an existing archive.db and
 * the first query dies with "no such column" — the defect migrate() exists to
 * stop, named in its own comment. That sentence is the test spec.
 */
describe('migrate: additive columns reach a pre-existing table', () => {
  const withOldDb = (fn: (dir: string) => void): void => {
    const dir = mkdtempSync(join(tmpdir(), 'neolj-mig-'));
    // Materialize an archive.db whose entry_embeds predates thumb_hash/fetched_at.
    const raw = new DatabaseSync(join(dir, 'archive.db'));
    raw.exec(
      'CREATE TABLE entry_embeds (ditemid INTEGER NOT NULL, idx INTEGER NOT NULL, url TEXT NOT NULL, PRIMARY KEY (ditemid, idx))',
    );
    raw.exec("INSERT INTO entry_embeds (ditemid, idx, url) VALUES (1, 0, 'http://x/')");
    raw.close();
    try {
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  // catches: migrate() failing to add a column to an existing table — the exact
  // "no such column: thumb_hash" that shipped and broke video-posters on a real db.
  it('adds thumb_hash to an old entry_embeds so a query using it works', () => {
    withOldDb((dir) => {
      const store = Store.open(dir); // runs SCHEMA (no-op here) then migrate()
      // Would throw "no such column: thumb_hash" if migrate did nothing.
      const rows = store.query('SELECT thumb_hash FROM entry_embeds') as {
        thumb_hash: string | null;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.thumb_hash).toBeNull();
      store.close();
    });
  });

  // catches: migrate() dropping the row's existing data while adding the column.
  it('preserves existing rows through the migration', () => {
    withOldDb((dir) => {
      const store = Store.open(dir);
      const rows = store.query('SELECT url FROM entry_embeds') as { url: string }[];
      expect(rows[0]?.url).toBe('http://x/');
      store.close();
    });
  });

  it('is idempotent — reopening a migrated db does not fail', () => {
    withOldDb((dir) => {
      Store.open(dir).close();
      // Second open must not throw "duplicate column name".
      expect(() => Store.open(dir).close()).not.toThrow();
    });
  });
});
