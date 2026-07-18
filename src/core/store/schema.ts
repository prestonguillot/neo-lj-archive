/**
 * The canonical store (DESIGN.md §6).
 *
 * Inlined as TypeScript rather than read from a .sql file at runtime. tsc does
 * not copy non-TS assets into dist/, so a readFileSync here builds green, tests
 * green (vitest resolves from src/), and then dies on first real use with
 * ENOENT. It did exactly that. A bundler (Electron, M5) would have the same
 * problem with more steps.
 */
export const SCHEMA = `
-- The canonical store (DESIGN.md §6).
--
-- Nullability here is not incidental. Every NULL below is a shape LiveJournal
-- actually sends, verified against a real capture — getting one wrong is a bug
-- on live data, not a style preference.
--
-- Idempotent: re-running is a no-op. §4 principle 5, "re-runs are free".

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS entries (
  itemid          INTEGER PRIMARY KEY,
  anum            INTEGER NOT NULL,
  -- From LJ directly. Not computed as itemid*256+anum (§7.3).
  ditemid         INTEGER NOT NULL,
  eventtime       TEXT    NOT NULL,
  logtime         TEXT,
  subject         TEXT,
  body            TEXT    NOT NULL,
  -- 'public' | 'private' | 'usemask'. LJ omits the field entirely for public.
  security        TEXT    NOT NULL,
  -- Only meaningful when security = 'usemask'.
  allowmask       INTEGER,
  -- mood and moodid are INDEPENDENT: either, both, or neither (§5.1).
  mood            TEXT,
  moodid          INTEGER,
  music           TEXT,
  location        TEXT,
  picture_keyword TEXT,
  -- Everything LJ sent that we don't model. Kept, not dropped — this archive is
  -- meant to be lossless.
  props_json      TEXT    NOT NULL DEFAULT '{}',
  fetched_at      TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_eventtime ON entries (eventtime);
-- UNIQUE: ditemid is logically unique and joined on throughout (userpics,
-- embeds, the build). A duplicate would silently multiply those joins; this makes
-- it an error instead. Applies on reopen; the data is already 1-to-1.
CREATE UNIQUE INDEX IF NOT EXISTS entries_ditemid ON entries (ditemid);

CREATE TABLE IF NOT EXISTS entry_tags (
  itemid INTEGER NOT NULL REFERENCES entries (itemid) ON DELETE CASCADE,
  tag    TEXT    NOT NULL,
  PRIMARY KEY (itemid, tag)
);

-- LJ's own mood vocabulary, fetched once via login+getmoods. Without it every
-- current_moodid is an unresolvable integer and those entries render no mood.
CREATE TABLE IF NOT EXISTS moods (
  moodid INTEGER PRIMARY KEY,
  name   TEXT    NOT NULL,
  parent INTEGER
);

-- Commenters, from the usermaps block of comment_meta.
-- No is_anon column: anonymity is the ABSENCE of a poster, not a kind of user.
-- Modelling it as a row invents an identity LJ never asserted (§6).
CREATE TABLE IF NOT EXISTS users (
  posterid INTEGER PRIMARY KEY,
  username TEXT    NOT NULL
);

CREATE TABLE IF NOT EXISTS comments (
  id       INTEGER PRIMARY KEY,
  jitemid  INTEGER NOT NULL,
  -- NULL = top-level. NEVER 0. LJ omits the attribute; reading absent-as-0
  -- makes every root comment a reply to a comment that doesn't exist and
  -- silently flattens every thread (§5.1).
  parentid INTEGER,
  -- NULL = anonymous. NEVER 0. LJ omits the attribute for anonymous comments;
  -- 22 of them in this journal. A NOT NULL FK throws on real data.
  posterid INTEGER REFERENCES users (posterid),
  subject  TEXT,
  -- NULL for deleted comments: they arrive self-closing, with no children.
  body     TEXT,
  date     TEXT,
  -- 'A' | 'D' | 'S' | 'F'. LJ only transmits it when NOT 'A'.
  state    TEXT    NOT NULL DEFAULT 'A',
  fetched_at TEXT  NOT NULL
);

-- No FK from comments.jitemid to entries.itemid on purpose: comment_meta
-- returns the whole journal's comments in one page, so comments can legitimately
-- arrive before the entry they hang off. Resolved at build time instead.
CREATE INDEX IF NOT EXISTS comments_jitemid ON comments (jitemid);
CREATE INDEX IF NOT EXISTS comments_parentid ON comments (parentid);

-- Resumability (§5.1). A killed run resumes; a completed run re-run is a no-op.
CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per distinct set of BYTES, keyed by their hash (§5.2).
--
-- Content-addressing is not a storage nicety — it is the poison detector. When
-- 142 distinct URLs on one host all hash to the same row, that host is serving a
-- placeholder, and this table is where that becomes visible for free.
CREATE TABLE IF NOT EXISTS assets (
  hash       TEXT PRIMARY KEY,        -- sha256 of the bytes
  mime       TEXT NOT NULL,           -- SNIFFED from the bytes, never the header
  byte_len   INTEGER NOT NULL,
  width      INTEGER,                 -- NULL when undecodable
  height     INTEGER,
  -- ok | dead | suspect | poison. The build stage renders dead and poison
  -- identically: a placeholder carrying the corpse (§5.2).
  -- (No backticks in here: this whole schema is a template literal, and a
  --  markdown habit terminates the string.)
  status     TEXT NOT NULL,
  local_path TEXT,                    -- NULL for dead: there are no bytes to keep
  fetched_at TEXT NOT NULL
);

-- One row per REFERENCE. Many-to-one against assets — and that cardinality IS
-- the dedup and the poison signal, not bookkeeping.
CREATE TABLE IF NOT EXISTS asset_refs (
  id          INTEGER PRIMARY KEY,
  hash        TEXT REFERENCES assets (hash),  -- NULL until fetched, or if unfetchable
  source_url  TEXT NOT NULL,
  host        TEXT,                   -- denormalised: every poison query groups by it
  context     TEXT NOT NULL,          -- entry | comment | userpic
  context_id  INTEGER NOT NULL,
  -- Present on only 24 of 608 refs. The dead-image placeholder is mostly URL +
  -- date, because 2000s LJ users didn't write alt text (§5.2).
  alt_text    TEXT,
  http_status INTEGER,
  error       TEXT,                   -- why it died, for the placeholder to carry
  fetched_at  TEXT,
  UNIQUE (source_url, context, context_id)
);

CREATE INDEX IF NOT EXISTS asset_refs_hash ON asset_refs (hash);
CREATE INDEX IF NOT EXISTS asset_refs_host ON asset_refs (host);

-- Userpics (DESIGN.md §3).
--
-- Not from the API: LJ's XML-RPC never returns picture_keyword — verified on all
-- 1,547 entries and on a live single-entry fetch — and the comment export carries
-- no picid at all. The rendered page has both, so these are scraped.
--
-- picid is LJ's own id and the natural key: the same pic reused across 400
-- comments is one row here and, once downloaded, one blob on disk.
CREATE TABLE IF NOT EXISTS userpics (
  picid       INTEGER PRIMARY KEY,
  userid      INTEGER NOT NULL,
  url         TEXT NOT NULL,
  -- Keyword is the AUTHOR'S OWN only: it comes from login's pickws, which
  -- describes this account's pics and says nothing about other people's.
  keyword     TEXT,
  -- Content-addressed, like every other image (§5.2). NULL until fetched.
  hash        TEXT,
  fetched_at  TEXT
);
CREATE INDEX IF NOT EXISTS userpics_userid ON userpics (userid);

-- Which pic an entry was posted under. Scraped, because the export omits it.
CREATE TABLE IF NOT EXISTS entry_userpics (
  ditemid  INTEGER PRIMARY KEY,
  picid    INTEGER NOT NULL REFERENCES userpics (picid)
);

-- Which pic a comment was left under. The page's #ljcmt<dtalkid> maps to our
-- comment id by dtalkid >> 8 — verified 5/5 on a real thread, not assumed.
CREATE TABLE IF NOT EXISTS comment_userpics (
  comment_id  INTEGER PRIMARY KEY REFERENCES comments (id),
  picid       INTEGER NOT NULL REFERENCES userpics (picid)
);

-- What a <lj-embed> actually pointed at.
--
-- The export gives only <lj-embed id="42"> — 28 of them, every one carrying an id
-- and nothing else. The real URL lived on LJ's servers, exactly like the polls.
-- Unlike the polls, LJ still renders it, so it is recoverable from the page.
-- Ordinal, because an entry can hold more than one and their order is the only
-- thing tying them back to the tags in the body.
CREATE TABLE IF NOT EXISTS entry_embeds (
  ditemid    INTEGER NOT NULL,
  idx        INTEGER NOT NULL,
  url        TEXT NOT NULL,
  -- The video's poster, downloaded locally so the card shows a real frame
  -- offline. A YouTube player itself cannot load from file:// (it needs a valid
  -- referrer and gets error 153), so the poster + a link out is the honest
  -- ceiling for an offline archive. NULL until fetched.
  thumb_hash TEXT,
  fetched_at TEXT,
  PRIMARY KEY (ditemid, idx)
);
`;
