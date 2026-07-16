# neo-lj-archive

Archive a LiveJournal — entries, threaded comments, and **local copies of every
image** — into a static site you can read offline, forever, **without this tool**.

> **Status: M0.** Scaffolding only. Nothing fetches yet. See
> [`DESIGN.md`](./DESIGN.md) for the full design and
> [§11](./DESIGN.md) for milestones.

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

## The two tiers

This is the load-bearing idea ([§13](./DESIGN.md)):

|                 | Needs                                                                                 |
| --------------- | ------------------------------------------------------------------------------------- |
| **The archive** | A browser. Nothing else. No server, no runtime, no install.                           |
| **The app**     | Builds the archive, and may add things the static tier can't (search over live FTS5). |

**Nothing baseline may be app-only.** The archive has to outlive its own tooling —
that's the failure mode ljArchive demonstrates. The app is allowed to be
disposable; the archive isn't.

There is deliberately **no search in the static archive**. It's plain HTML on
disk, so `grep -ril photobucket site/entries/` works forever with no index and no
runtime. A search UI is convenience, not capability.

## Usage

```
neo-lj fetch      # LiveJournal -> archive.db. Incremental and resumable.
neo-lj images     # Download every image, content-address it, classify placeholders.
neo-lj classify   # Optional: LLM pass over suspect image hashes.
neo-lj build      # archive.db -> site/. Plain HTML, opens from file://.
neo-lj status     # What's fetched, what's missing, what's dead.
```

Credentials come from a no-echo prompt or `LJ_USER` / `LJ_PASSWORD` at runtime.
**Never via flag** — flags land in shell history and `ps`. Nothing is stored: the
password is hashed on read and the plaintext dropped.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm test
```

Requires Node ≥ 22.13 (`node:sqlite` is unflagged from that version).

### The core/shell boundary

`src/core/` is a library that doesn't know how it's being driven — no `console`,
no `process`, no `argv`. It takes a config object and reports through a
`ProgressReporter`. `src/cli/` is a thin shell over it; `src/app/` will be a
second shell (Electron) at M5.

**This is enforced by lint rule, not convention.** It's what makes Electron an
addition rather than a rewrite. If you need to print something from core, emit a
progress event instead.

## License

MIT. The tool is for one person; the codebase is for whoever wants it.
