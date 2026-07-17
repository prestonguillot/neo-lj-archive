import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { SCHEMA } from './schema.js';
import { dirname, join } from 'node:path';
import type { CommentBody, CommentMeta, Entry, Mood, UserMap } from '../fetch/types.js';

/**
 * Columns added to a table AFTER archives already existed in the wild.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table's shape untouched, so a new
 * column never reaches an old archive.db and the first query dies with "no such
 * column". SQLite has no ADD COLUMN IF NOT EXISTS, so each is guarded by reading
 * pragma table_info first. Idempotent: a fresh db already has them and this does
 * nothing.
 */
const MIGRATIONS: { table: string; column: string; def: string }[] = [
  { table: 'entry_embeds', column: 'thumb_hash', def: 'TEXT' },
  { table: 'entry_embeds', column: 'fetched_at', def: 'TEXT' },
];

function migrate(db: DatabaseSync): void {
  for (const m of MIGRATIONS) {
    const cols = db.prepare(`PRAGMA table_info(${m.table})`).all() as { name: string }[];
    if (!cols.some((c) => c.name === m.column)) {
      db.exec(`ALTER TABLE ${m.table} ADD COLUMN ${m.column} ${m.def}`);
    }
  }
}

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

export interface ImageStats {
  readonly refs: number;
  readonly distinctUrls: number;
  readonly hosts: number;
  readonly pending: number;
  readonly blobs: number;
  readonly poison: number;
  readonly deadRefs: number;
}

export interface BodyRow {
  readonly context: 'entry' | 'comment';
  readonly id: number;
  readonly html: string;
  /** The permalink relative URLs resolve against. */
  readonly url: string;
}

export interface AssetRefRow {
  readonly sourceUrl: string;
  readonly host: string | undefined;
  readonly context: string;
  readonly contextId: number;
  readonly altText: string | undefined;
}

export interface AssetResult {
  readonly url: string;
  readonly hash: string | undefined;
  readonly mime: string | undefined;
  readonly byteLen: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly status: string;
  readonly localPath: string | undefined;
  readonly httpStatus: number | undefined;
  readonly reason: string | undefined;
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
    migrate(db);
    return new Store(db);
  }

  /** In-memory, for tests. */
  static openMemory(): Store {
    const db = new DatabaseSync(':memory:');
    db.exec(SCHEMA);
    migrate(db);
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

  // --- images (§5.2) -------------------------------------------------------

  /**
   * Every body to scan, with the permalink relative URLs resolve against.
   *
   * A comment's images resolve against the URL of the ENTRY it hangs off, not
   * the comment — a comment has no page of its own. Hence the join.
   */
  bodiesForExtraction(username: string): BodyRow[] {
    const base = (ditemid: number): string => `https://${username}.livejournal.com/${ditemid}.html`;

    const entries = this.#db.prepare('SELECT itemid AS id, ditemid, body FROM entries').all() as {
      id: number;
      ditemid: number;
      body: string;
    }[];

    const comments = this.#db
      .prepare(
        `SELECT c.id AS id, e.ditemid AS ditemid, c.body AS body
           FROM comments c JOIN entries e ON e.itemid = c.jitemid
          WHERE c.body IS NOT NULL`,
      )
      .all() as { id: number; ditemid: number; body: string }[];

    return [
      ...entries.map((r) => ({
        context: 'entry' as const,
        id: r.id,
        html: r.body,
        url: base(r.ditemid),
      })),
      ...comments.map((r) => ({
        context: 'comment' as const,
        id: r.id,
        html: r.body,
        url: base(r.ditemid),
      })),
    ];
  }

  /** Record references before anything is fetched. Idempotent on re-run. */
  putAssetRefs(refs: readonly AssetRefRow[]): void {
    const s = this.#db.prepare(`
      INSERT INTO asset_refs (source_url, host, context, context_id, alt_text)
      VALUES (?,?,?,?,?)
      ON CONFLICT (source_url, context, context_id) DO UPDATE SET
        host=excluded.host, alt_text=excluded.alt_text
    `);
    this.#tx(() => {
      for (const r of refs) s.run(r.sourceUrl, n(r.host), r.context, r.contextId, n(r.altText));
    });
  }

  /**
   * The work list: URLs never attempted.
   *
   * Derived from the DB rather than memory, so a killed run resumes and a
   * completed one is a no-op (§4.5). Nothing re-downloads the world.
   */
  pendingUrls(): string[] {
    return (
      this.#db
        .prepare('SELECT DISTINCT source_url AS u FROM asset_refs WHERE fetched_at IS NULL')
        .all() as { u: string }[]
    ).map((r) => r.u);
  }

  /**
   * Record one fetch outcome against every reference to that URL.
   *
   * `hash` is NULL for anything dead — there are no bytes to point at — but the
   * reason is kept, because the placeholder has to name what was lost (§4.3).
   */
  putAssetResult(a: AssetResult, now = new Date().toISOString()): void {
    this.#tx(() => {
      if (a.hash !== undefined && a.localPath !== undefined) {
        this.#db
          .prepare(
            `INSERT INTO assets (hash, mime, byte_len, width, height, status, local_path, fetched_at)
             VALUES (?,?,?,?,?,?,?,?)
             ON CONFLICT (hash) DO UPDATE SET
               mime=excluded.mime, byte_len=excluded.byte_len, width=excluded.width,
               height=excluded.height, local_path=excluded.local_path`,
          )
          .run(
            a.hash,
            a.mime ?? 'application/octet-stream',
            a.byteLen,
            n(a.width),
            n(a.height),
            a.status,
            a.localPath,
            now,
          );
      }
      this.#db
        .prepare(
          `UPDATE asset_refs SET hash = ?, http_status = ?, error = ?, fetched_at = ?
            WHERE source_url = ?`,
        )
        .run(n(a.hash), n(a.httpStatus), n(a.reason), now, a.url);
    });
  }

  /** Every fetched reference, for host-collapse detection. */
  poisonInput(): { hash: string; sourceUrl: string; host: string }[] {
    return this.#db
      .prepare(
        `SELECT hash, source_url AS sourceUrl, host
           FROM asset_refs WHERE hash IS NOT NULL AND host IS NOT NULL`,
      )
      .all() as { hash: string; sourceUrl: string; host: string }[];
  }

  /**
   * Demote blobs to poison.
   *
   * The bytes stay on disk. A verdict is a FLAG, never a deletion — which is
   * what makes automatic classification safe: a wrong call costs a rebuild, not
   * data (§5.2).
   */
  markPoison(hashes: readonly string[]): void {
    const s = this.#db.prepare("UPDATE assets SET status = 'poison' WHERE hash = ?");
    this.#tx(() => {
      for (const h of hashes) s.run(h);
    });
  }

  imageStats(): ImageStats {
    const one = (sql: string): number => (this.#db.prepare(sql).get() as { n: number }).n;
    return {
      refs: one('SELECT COUNT(*) AS n FROM asset_refs'),
      distinctUrls: one('SELECT COUNT(DISTINCT source_url) AS n FROM asset_refs'),
      hosts: one('SELECT COUNT(DISTINCT host) AS n FROM asset_refs'),
      pending: one(
        'SELECT COUNT(DISTINCT source_url) AS n FROM asset_refs WHERE fetched_at IS NULL',
      ),
      blobs: one("SELECT COUNT(*) AS n FROM assets WHERE status = 'ok'"),
      poison: one("SELECT COUNT(*) AS n FROM assets WHERE status = 'poison'"),
      deadRefs: one(
        'SELECT COUNT(*) AS n FROM asset_refs WHERE fetched_at IS NOT NULL AND hash IS NULL',
      ),
    };
  }

  /**
   * Link a userpic to the blob its bytes landed in.
   *
   * fetched_at is stamped even when the hash is undefined, so a pic that 404s is
   * recorded as tried rather than retried on every run.
   */
  linkUserpicBlob(picid: number, hash: string | undefined, now = new Date().toISOString()): void {
    this.#db
      .prepare('UPDATE userpics SET hash = ?, fetched_at = ? WHERE picid = ?')
      .run(hash ?? null, now, picid);
  }

  /** Link a video embed to its downloaded poster. Same tried-not-retried rule. */
  linkEmbedThumb(
    ditemid: number,
    idx: number,
    hash: string | undefined,
    now = new Date().toISOString(),
  ): void {
    this.#db
      .prepare(
        'UPDATE entry_embeds SET thumb_hash = ?, fetched_at = ? WHERE ditemid = ? AND idx = ?',
      )
      .run(hash ?? null, now, ditemid, idx);
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
