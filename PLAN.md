# neo-lj-archive — Project Brief & Handoff Context

> **Status: PRE-DESIGN.** This document is a handoff brief from a prior planning
> conversation, not a design doc. **The first task in this repo is to produce a
> complete design document and implementation plan** (see "Immediate Next Step"
> below). Do not start building components until that design doc exists and has
> been reviewed by Preston.

## Goal

A tool that archives an entire LiveJournal — entries, threaded comments, and
**local copies of all images** (not hotlinks that will eventually 404) — into a
**locally browsable static site**: open `index.html`, navigate by calendar,
tags, and search, fully offline.

## Why this exists (prior-art findings, verified July 2026)

- **ljArchive** (Erik Frey, .NET WinForms): abandoned 2006. Broke when LJ
  changed auth (ljmastersession/ljloggedin cookies). A GitHub fork
  (`sharpden/ljarchive`) has minimal fixes as of 2022 but requires building a
  2005-era VS solution. Notably, ljArchive **never downloaded images** — it
  hotlinked them. So even a working ljArchive wouldn't meet the goal.
- **ljdump** (`ghewgill/ljdump`, Python): still functional. Downloads entries,
  comments, and userpics via LJ's XML-RPC API with challenge-response auth.
  Incremental (re-runnable). Output is raw XML files — no browsable frontend,
  no inline-image capture. **Its protocol handling is the reference
  implementation for our fetch layer** — either vendor it or reimplement
  against it (design-doc decision).
- **Dreamwidth importer**: migration, not local archive; images stay remote.
- **BlogBooker**: PDF output, metered, not the desired format.

Conclusion: nothing existing does the full job; the fetch protocol is a solved
problem we can crib; the image localization and static-site frontend are the
new work.

## Proposed architecture (sketch — to be validated in design doc)

Three components, one pipeline:

1. **Fetcher** (Python): LJ XML-RPC (`getevents` / `syncitems`,
   `getcomments` via export_comments.bml) with challenge-response auth,
   modeled on ljdump. Incremental sync into a local store. Must handle LJ
   rate limits gracefully — ArchiveTeam documents ~month-long IP bans (403s)
   for aggressive scraping, so throttling and resumability are requirements,
   not nice-to-haves.
2. **Image localizer**: parse entry/comment HTML, download every `<img>`
   (plus userpics), rewrite `src` to local paths, and keep a manifest logging
   successes, already-dead links, and skips. Idempotent on re-run.
3. **Static site generator**: plain HTML output. Calendar view (year/month),
   tag index, threaded comments preserved, client-side full-text search
   (prebuilt index + small JS, no server). No build-time framework required
   to _view_ the archive — the output is self-contained.

## Open decisions (resolve in the design doc)

- **Storage layer**: SQLite vs. JSON-on-disk for the canonical fetched data.
  (SQLite likely wins for incremental sync bookkeeping and search-index
  generation, but decide explicitly.)
- **Vendor ljdump vs. reimplement** the XML-RPC protocol layer.
- **Comment fetch strategy**: XML-RPC vs. the `export_comments.bml` flat
  endpoint (ljdump uses the latter for comments; verify it still works).
- **Auth handling**: challenge-response (MD5-based, what ljdump uses) vs.
  password-over-HTTPS; where credentials live (config file? keychain? env?).
- **Scope of image capture**: inline `<img>` only, or also `<a href>` targets
  pointing at images, embedded media, LJ photo albums?
- **Frontend generation approach**: string templates vs. a template engine;
  search index format (e.g., lunr-style prebuilt JSON vs. simpler grep-in-JS).
- **Security-filtered entries**: how friends-locked/private entries are marked
  in the output (they'll be in the archive if fetched while authenticated —
  should the UI badge them?).

## Open questions for Preston (answers pending)

1. **Journal size** — approximate entry count. Drives rate-limit strategy and
   whether fetch needs checkpoint/resume within a single run.
2. **Locked entries in scope?** — private/friends-only entries come through
   authenticated XML-RPC fine; confirm they should be included.

## Constraints & cautions

- LJ bans aggressive clients (403, ~1 month). Default to conservative request
  pacing; make it configurable.
- Fetch must be **incremental and resumable** — never re-download the world.
- The generated site must work from `file://` (no server assumptions: no
  fetch() of local JSON without checking file:// CORS behavior — may need to
  inline the search index as a JS file).
- Third-party image hosts (Photobucket et al.) are lossy/hostile; expect
  dead links and log them rather than failing.
- Credentials are sensitive; never commit them. `.gitignore` from day one.

## Immediate next step

Write `DESIGN.md`: full design doc covering the open decisions above, data
model, module boundaries, error-handling/retry policy, CLI interface, testing
strategy (synthetic-data tests for the generator; recorded-fixture tests for
the fetcher), and a milestone-ordered implementation plan. Review with Preston
before writing implementation code.
