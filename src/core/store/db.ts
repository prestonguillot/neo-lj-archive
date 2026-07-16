import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { SCHEMA } from './schema.js';
import { dirname, join } from 'node:path';
import type { CommentBody, CommentMeta, Entry, Mood, UserMap } from '../fetch/types.js';

/**
 * The canonical store. SQLite via node:sqlite — no native module, so an Electron
 * build (M5) needs no electron-rebuild (DESIGN.md §15).
 *
 * node:sqlite is a release candidate, so its API can shift. Everything that
 * touches it lives behind this module: churn costs one file, and the data is an
 * ordinary SQLite file either way.
 */

/**
 * node:sqlite rejects `undefined` as a bound parameter — it throws rather than
 * binding NULL. Every nullable column in this schema is a real LJ shape
 * (absent parentid, absent posterid, deleted comments with no body), so this
 * conversion is on the hot path for correct data, not an edge case.
 */
const n = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

export interface SyncStats {
  readonly entries: number;
  readonly comments: number;
  readonly users: number;
  readonly moods: number;
}

export class Store {
  readonly #db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.#db = db;
  }

  /**
   * Open (creating if needed) the archive at `outputDir/archive.db`.
   *
   * Also drops a `.gitignore` containing `*` into the output directory. The
   * repo's own .gitignore already excludes /archive/, but this directory holds a
   * decade of private entries and other people's comments, and the repo is
   * public — so it defends itself even if someone force-adds the parent, or
   * points --out somewhere else entirely (§8).
   */
  static open(outputDir: string): Store {
    mkdirSync(outputDir, { recursive: true });

    const guard = join(outputDir, '.gitignore');
    if (!existsSync(guard)) {
      writeFileSync(
        guard,
        '# Archive output: private entries and other people’s comments.\n' +
          '# Never commit any of it. Written by neo-lj (DESIGN.md §8).\n*\n',
        'utf8',
      );
    }

    const path = join(outputDir, 'archive.db');
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);
    db.exec(SCHEMA);
    return new Store(db);
  }

  /** In-memory, for tests. */
  static openMemory(): Store {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    return new Store(db);
  }

  close(): void {
    this.#db.close();
  }

  // --- writes --------------------------------------------------------------

  putEntries(entries: readonly Entry[], now = new Date().toISOString()): void {
    const entry = this.#db.prepare(`
      INSERT INTO entries (itemid, anum, ditemid, eventtime, logtime, subject, body,
                           security, allowmask, mood, moodid, music, location,
                           picture_keyword, props_json, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (itemid) DO UPDATE SET
        anum=excluded.anum, ditemid=excluded.ditemid, eventtime=excluded.eventtime,
        logtime=excluded.logtime, subject=excluded.subject, body=excluded.body,
        security=excluded.security, allowmask=excluded.allowmask, mood=excluded.mood,
        moodid=excluded.moodid, music=excluded.music, location=excluded.location,
        picture_keyword=excluded.picture_keyword, props_json=excluded.props_json,
        fetched_at=excluded.fetched_at
    `);
    const clearTags = this.#db.prepare('DELETE FROM entry_tags WHERE itemid = ?');
    const addTag = this.#db.prepare('INSERT OR IGNORE INTO entry_tags (itemid, tag) VALUES (?, ?)');

    this.#tx(() => {
      for (const e of entries) {
        entry.run(
          e.itemid,
          e.anum,
          e.ditemid,
          e.eventtime,
          n(e.logtime),
          n(e.subject),
          e.body,
          e.security,
          n(e.allowmask),
          n(e.mood),
          n(e.moodid),
          n(e.music),
          n(e.location),
          n(e.pictureKeyword),
          JSON.stringify(e.props),
          now,
        );
        // Re-run safe: tags are replaced wholesale rather than accumulated.
        clearTags.run(e.itemid);
        for (const t of e.tags) addTag.run(e.itemid, t);
      }
    });
  }

  putMoods(moods: readonly Mood[]): void {
    const s = this.#db.prepare(
      'INSERT INTO moods (moodid, name, parent) VALUES (?,?,?) ' +
        'ON CONFLICT (moodid) DO UPDATE SET name=excluded.name, parent=excluded.parent',
    );
    this.#tx(() => {
      for (const m of moods) s.run(m.moodid, m.name, n(m.parent));
    });
  }

  putUsers(users: readonly UserMap[]): void {
    const s = this.#db.prepare(
      'INSERT INTO users (posterid, username) VALUES (?,?) ' +
        'ON CONFLICT (posterid) DO UPDATE SET username=excluded.username',
    );
    this.#tx(() => {
      for (const u of users) s.run(u.posterid, u.username);
    });
  }

  /**
   * Write the comment index from comment_meta. Text arrives later via
   * putCommentBodies — so this must NOT clobber a body already fetched.
   */
  putCommentMeta(meta: readonly CommentMeta[], now = new Date().toISOString()): void {
    const s = this.#db.prepare(`
      INSERT INTO comments (id, jitemid, posterid, state, fetched_at)
      VALUES (?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET
        jitemid=excluded.jitemid, posterid=excluded.posterid, state=excluded.state
    `);
    this.#tx(() => {
      for (const c of meta) s.run(c.id, c.jitemid, n(c.posterid), c.state, now);
    });
  }

  putCommentBodies(bodies: readonly CommentBody[], now = new Date().toISOString()): void {
    const s = this.#db.prepare(`
      INSERT INTO comments (id, jitemid, parentid, posterid, subject, body, date, state, fetched_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET
        jitemid=excluded.jitemid, parentid=excluded.parentid, posterid=excluded.posterid,
        subject=excluded.subject, body=excluded.body, date=excluded.date,
        state=excluded.state, fetched_at=excluded.fetched_at
    `);
    this.#tx(() => {
      for (const c of bodies) {
        s.run(
          c.id,
          c.jitemid,
          n(c.parentid),
          n(c.posterid),
          n(c.subject),
          n(c.body),
          n(c.date),
          c.state,
          now,
        );
      }
    });
  }

  // --- sync state ----------------------------------------------------------

  getState(key: string): string | undefined {
    const row = this.#db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.#db
      .prepare(
        'INSERT INTO sync_state (key, value) VALUES (?,?) ON CONFLICT (key) DO UPDATE SET value=excluded.value',
      )
      .run(key, value);
  }

  // --- reads ---------------------------------------------------------------

  stats(): SyncStats {
    const one = (sql: string): number => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      entries: one('SELECT COUNT(*) AS n FROM entries'),
      comments: one('SELECT COUNT(*) AS n FROM comments'),
      users: one('SELECT COUNT(*) AS n FROM users'),
      moods: one('SELECT COUNT(*) AS n FROM moods'),
    };
  }

  /** Escape hatch for tests and the build stage. */
  query(sql: string, ...params: (string | number | null)[]): unknown[] {
    return this.#db.prepare(sql).all(...params);
  }

  #tx(fn: () => void): void {
    this.#db.exec('BEGIN');
    try {
      fn();
      this.#db.exec('COMMIT');
    } catch (err) {
      this.#db.exec('ROLLBACK');
      throw err;
    }
  }
}
