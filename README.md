# neo-lj-archive

Archive a LiveJournal — entries, threaded comments, and **local copies of every
image** — into a static site you can read offline, forever, **without this tool**.

> **Status: M0–M6 done.** The static archive is complete: entry pages, threaded
> comments, local images and userpics, calendar, tags, people, on-this-day, a
> Retrospect of the decade, search (by words, and optionally by meaning), and
> related entries. See [`DESIGN.md`](./DESIGN.md) for the
> design and [§11](./DESIGN.md) for milestones.

## Why

Nothing existing does the whole job:

- **ljArchive** — abandoned in 2006, broke when LJ changed auth, and never
  downloaded images. It hotlinked them, so even a working copy wouldn't meet the
  goal.
- **ljdump** — still works, and its protocol handling is the reference for our
  fetch layer. But it emits raw XML: no frontend, no image capture.
- **Dreamwidth import** — a migration, not an archive. Images stay remote.

The fetch protocol is a solved problem worth cribbing. Image localization and the
static site are the actual work.

## The archive needs a browser, and nothing else

This is the load-bearing idea ([§13](./DESIGN.md)). No server, no runtime, no
install, no app: open `site/index.html` from disk. The archive has to outlive its
own tooling — that's the failure mode ljArchive demonstrates. The tool is allowed
to be disposable; the archive isn't.

**Nothing baseline may need JavaScript.** Entries, comments, images, calendar,
tags — all plain HTML. Script is allowed only for value-add, and only where the
page still works without it:

- **Search** runs in the page, from `file://`, over every entry and comment
  ([§7.4](./DESIGN.md)) — by exact words, or optionally by meaning. With script off, it tells you to `grep`, and that works
  forever: `grep -ril photobucket site/entries/`.
- **Related entries** on every entry page are worked out at build time and
  rendered as plain links ([§7.5](./DESIGN.md)). No script at all.

## Usage

```sh
npm install && npm run build   # then: node dist/cli/index.js <command>, or npm link for `neo-lj`
```

The full pipeline, in order. Every stage is idempotent and resumable; re-run any of
them freely.

```
neo-lj fetch           # LiveJournal -> archive.db. The only stage that needs credentials.
neo-lj images          # Download every entry/comment image, content-address it, flag placeholders.
npx tsx scripts/audit-vs-live.mts --login   # once: log in by hand, session saved
npx tsx scripts/audit-vs-live.mts 200       # scrape what the API won't give: userpics, embeds
neo-lj userpics        # Download the userpics the scrape found.
neo-lj video-posters   # Poster frames for recovered YouTube embeds.
neo-lj build           # archive.db -> site/. Plain HTML, opens from file://.
neo-lj build --embed   # optional: also search by meaning (see below).
neo-lj status          # What's fetched.
```

Everything lands in `./archive/` (override with `-o`): `archive.db` is the archive,
`blobs/` holds the images, and `site/` is a disposable render you can delete and
rebuild. Open `archive/site/index.html`.

`neo-lj classify` (an optional LLM pass over suspect images) is reserved and
unscheduled; it exits with "not implemented yet".

**Search by meaning** is optional. `neo-lj build --embed` needs the optional
package `@huggingface/transformers` (installed by default; `npm install
--omit=optional` skips it), downloads the model once, and embeds the journal in a
few minutes. The vectors and the model are stored in `archive.db`, so every later
`neo-lj build` includes it with no model run and no network. In the browser it's
plain JavaScript, no runtime. Without `--embed`, search is keyword-only.

**Credentials** come from a no-echo prompt or `LJ_USER` / `LJ_PASSWORD` at runtime.
**Never via flag** — flags land in shell history and `ps`. Nothing is stored: the
password is hashed on read and the plaintext dropped. The audit script uses a
browser session you create by hand, saved under the gitignored `archive/`.

**Be polite to LiveJournal.** A 403 is a ban, possibly month-long. `fetch` waits 2s
between requests by default and stops dead (exit code 3) on a 403.

## Development

```sh
npm install
npm run type-check   # src, tests, and e2e
npm run lint
npm run test:run     # vitest, once (`npm test` watches)
npm run test:e2e     # Playwright against a built synthetic archive at file://
npm run format:check
```

Requires Node ≥ 22.13 (`node:sqlite` is unflagged from that version).

### Layout

```
src/core/fetch/    LJ XML-RPC + comment export -> store
src/core/images/   extract, download, classify; userpics; video embeds
src/core/build/    render LJ markup, templates, theme, search, related -> site/
src/core/store/    node:sqlite schema and queries
src/cli/           the shell: argv, prompts, progress output
scripts/           one-off tooling (below)
tests/             e2e (Playwright), scrubbed fixtures, upgrade guards
```

### Scripts

| Script                  | What it's for                                                                |
| ----------------------- | ---------------------------------------------------------------------------- |
| `audit-vs-live.mts`     | Diff the built archive against the live journal; scrape userpics and embeds. |
| `capture-fixtures.ts`   | Capture raw LJ responses into gitignored `fixtures-raw/`.                    |
| `scrub-fixtures.ts`     | Redact those captures into committed `tests/fixtures/`. Fails closed.        |
| `build-body-fixture.ts` | Pull real, redacted entry HTML from `archive.db` into `tests/fixtures/`.     |
| `scrub-html.ts`         | Structure-preserving HTML redaction shared by the two above.                 |

### Testing

The rule is **oracle provenance**: a test's expected value must never be derived
from the code under test. Oracles come from recorded LiveJournal bytes, a real
browser, adversarial local servers, and stated invariants. Every test names the
specific defect it catches. No coverage is measured, on purpose. CI never touches
LiveJournal. See [§10](./DESIGN.md).

### The core/shell boundary

`src/core/` is a library that doesn't know how it's being driven — no `console`,
no `process`, no `argv`. It takes a config object and reports through a
`ProgressReporter`. `src/cli/` is a thin shell over it, and tests drive core
directly with an in-memory store and a reporter that records events.

**This is enforced by lint rule, not convention.** If you need to print something
from core, emit a progress event instead.

## License

MIT. The tool is for one person; the codebase is for whoever wants it.
