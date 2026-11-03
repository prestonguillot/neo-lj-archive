# neo-lj-archive — Design Document

> **Status: APPROVED — implementation started 2026-07-16; M0–M4 complete.**
> Supersedes the pre-design brief (`PLAN.md`, removed; see git history). Every
> "open decision" and "open question" from it is resolved below. Milestones and
> progress: §11.

## §1. What this is

A tool that archives a single LiveJournal — entries, their threaded comments,
and local copies of every image — into a static site you can open and read
offline, forever, without the tool that made it.

The last clause is the design's spine. Everything below bends toward it.

## §2. What the spike proved

Before designing anything we verified the protocol still works, on Preston's
account, in July 2026 (`spike_lj_api.py`, five requests, all green — removed once
M1 superseded it; see git history). The findings are load-bearing:

| Fact                                      | Value                      | Consequence                                       |
| ----------------------------------------- | -------------------------- | ------------------------------------------------- |
| XML-RPC interface                         | alive                      | Fetch layer is viable as briefed                  |
| Challenge-response auth                   | works                      | No fallback to HTML scraping needed               |
| Challenge lifetime                        | single-use, ~60s           | **No session token exists to hold**               |
| `getevents`                               | returns entries + security | Locked entries confirmed, not assumed             |
| `sessiongenerate` → `export_comments.bml` | works                      | Comment export path intact                        |
| Max itemid                                | 1589                       | ~1,500 entries — upper bound, gaps from deletions |
| Comment `maxid`                           | 6,570                      | Total comments ever                               |
| Distinct commenters                       | 194+ in first page alone   | Userpic dedup matters                             |
| Last entry                                | 2010-09-07                 | **The corpus is frozen**                          |

Two of these reshape the project:

**The journal is small.** ~8,000 documents total — about 2 MB of text. A browser
scans that in milliseconds with no index at all (measured: §7.4). Search is not a
performance problem, so we choose its design on durability grounds alone. Likewise, batched `getevents` plus paginated comment
export means the entire fetch is on the order of forty requests to LJ. The
month-long-ban risk documented by ArchiveTeam applies to clients making
thousands of requests. We can be maximally polite at zero cost, so we will be.

**The corpus is frozen.** Nothing has been posted since September 2010.
"Incremental sync" therefore means _resumability and idempotent re-runs_, not
freshness. This is a simplification, and the design should not carry machinery
for a stream of new posts that will never arrive.

## §3. Scope

**In:** Preston's own entries, and the comment threads on those entries.
Entries at every security level. Images inline in entries and comments, images
linked via `<a href>`, and userpics.

**Out, deliberately:** comments Preston left on other people's journals; posts
in communities; friends' journals; Scrapbook galleries (deferred, §11).

The `login` response advertises posting access to nine communities. The fetcher
**must never send the `usejournal` parameter.** ljdump supports that path; if we
were vendoring it we'd have to close the door, which is one of several reasons
we are not (§5.1). This is enforced by test, not by convention.

## §4. Principles

1. **The archive outlives the tool.** Output is plain HTML with relative paths.
   Reading it requires a browser and nothing else. If this repo is deleted and
   Node stops existing, the archive still opens.
2. **The tool never stores credentials.** Not on disk, not in config, not ever.
3. **The archive is honest about its gaps.** A lost image is recorded as lost,
   with everything we knew about it, not silently dropped or silently faked.
4. **Owner's content, owner's rules.** Private entries are archived and marked,
   never gated. There is no permission system in the output because there is no
   one to keep out.
5. **Re-runs are free.** Every stage is idempotent. Nothing re-downloads the
   world.

## §5. Architecture

Three stages over one SQLite database, each independently re-runnable:

```
  LiveJournal ──fetch──> archive.db ──images──> archive.db + blobs/
                                                      │
                                                    build
                                                      ▼
                                                    site/
```

`archive.db` is the canonical store; `site/` is a disposable render of it. You
can delete `site/` and rebuild. You cannot delete `archive.db` — that's the
archive.

### 5.1 Fetch

**Decision: reimplement, do not vendor ljdump.** The brief left this open. The
spike settles it: the entire protocol — auth, entries, cookie session, comment
export — came to ~150 lines using no libraries at all. ljdump is 2005-era Python
carrying support we've explicitly scoped out (`usejournal`, community fetching).
Vendoring it means owning code we didn't write, in a language we haven't chosen,
to save an afternoon. We reimplement, and treat ljdump as reference
documentation for the protocol — which is exactly what the brief said it was
good for.

**Auth.** `LJ.XMLRPC.getchallenge` → `md5(challenge + md5(password))`, sent as
`auth_method=challenge`. Challenges are single-use and expire in about sixty
seconds, so **a fresh challenge is fetched per request.** There is no session to
establish and nothing to cache. This is settled fact from the spike, not a
guess.

**Entries.** `LJ.XMLRPC.getevents` with `selecttype=syncitems`, batched. Records
`itemid`, `anum`, `ditemid`, `eventtime`, `logtime`, `subject`, `event` (body
HTML), `security`, `allowmask`, and props.

`ditemid` is **returned directly** — no need to compute `itemid * 256 + anum`
(an earlier draft had us deriving it; verified against a real capture).

**Mood is two fields, not one.** `current_mood` is free text; `current_moodid`
is a reference into LJ's own mood vocabulary. An entry can have **either or
both** — in a 2004 sample, 4 of 20 entries carried `current_moodid` and only 2
carried `current_mood`. Recording only `current_mood` silently drops the mood
from entries that used a picklist mood, and §7.1 calls mood one of the things
people actually miss. `LJ.XMLRPC.login` with `getmoods` returns the id→name
table (~30KB); fetch it once and store it.

Other props: `current_music`, `current_location`, `taglist`, `picture_keyword`.

**Comments.** Not XML-RPC. `LJ.XMLRPC.sessiongenerate` mints an `ljsession`
cookie, handed to plain GETs against `export_comments.bml` in two passes:

- `?get=comment_meta&startid=N` → every comment's `id`, `jitemid`, `posterid`,
  `state`, plus `maxid` and `usermaps` (posterid → username). Page size 10,000.
- `?get=comment_body&startid=N` → `subject`, `body`, `date`, and `parentid`.
  Page size 1,000.

**Pagination: meta is the index; body fills in text.** For this journal, meta
returns all 6,550 comments in a single page, giving the complete id set up
front. Body is then paged by `startid = highest id received + 1` until the
highest id reaches `maxid`.

Do **not** page by a fixed stride. Comment ids have gaps — 6,550 comments span
ids 1–6,570 — so `startid += 1000` skips real comments. And do **not** rely on
the `nextid` element: the archived LJ server source emits one, but the live
server does not send it (verified — absent from a full 999-comment body page).
That mirror is a snapshot of the old open-source LJ and has diverged.

**Shape facts, verified against a real capture** — every one of these is a bug
if assumed otherwise:

| Fact                                                                                            | Consequence if ignored                                                             |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Attributes are **single-quoted** (`id='2200'`), and the XML declaration mixes both quote styles | A regex/parser assuming `"` silently matches nothing                               |
| `state` is emitted **only when not `A`**                                                        | Absent ≠ missing data; absent means Active                                         |
| `parentid` is emitted **only when non-zero**, body mode only                                    | Absent means top-level. It is never `0`. Reading absent-as-0 flattens every thread |
| `posterid` is **omitted for anonymous comments** (22 in this journal)                           | A non-null FK to `users` throws on real data                                       |
| Deleted comments are **self-closing with no children** (44 of 999 in one page)                  | A parser expecting `<body>` on every comment dies                                  |
| `event` bodies are **selectively base64-encoded** (1 of 20 recent entries)                      | Occasional mojibake, or a hard failure                                             |

States: `A`ctive, `D`eleted, `S`creened, `F`rozen — all archived, all rendered,
each labeled. Observed in this journal: 6,331 active, 217 deleted, 2 screened,
0 frozen. (Screening was expected to be absent; it isn't. Rare ≠ never.)

**`&props=1` is deliberately not requested.** It returns `<property>` elements
carrying commenters' IP addresses — 194 other people's, and §4 is "owner's
content, owner's rules."

**Pacing.** Fixed conservative delay between LJ requests, configurable, default
deliberately slow. At forty requests this is free insurance. On HTTP 403 the
fetcher **stops immediately** and says so in plain language — a 403 from LJ
means a ban, and retrying makes it worse. On 5xx, bounded exponential backoff.

**Resumability.** `sync_state` holds the last synced itemid and last comment
`startid`. A killed run resumes; a completed run re-run is a no-op.

### 5.2 Images

Extraction parses entry and comment HTML with a forgiving HTML5 parser — the
bodies are hand-written tag soup from 2000–2010, and error-tolerant parsing is
not optional. Collects `<img src>`, `<a href>` where the target looks like an
image, and records embeds (`<iframe>`, `<object>`, `lj-embed`) as links with
metadata rather than trying to localize video.

LJ-hosted images (`pics.livejournal.com`, userpic hosts) are not a special case
— they're ordinary images that happen to be the most likely to still resolve.

**Measured against the real archive** (1,547 entries, 6,333 comment bodies), so
these are facts rather than estimates:

|                                 | Count                       |
| ------------------------------- | --------------------------- |
| Inline `<img>`                  | 608 refs, 421 distinct URLs |
| `<a href>` straight at an image | 41 refs                     |
| Embeds (kept as links)          | 34                          |
| Entries containing images       | 122 of 1,547                |
| Comments containing images      | 107                         |
| Distinct hosts                  | **161**                     |
| `alt` text present              | **24 of 608**               |

Two consequences. The corpus is **much smaller than the brief implied** — 421
distinct images, not thousands, so M2's runtime is minutes. And the
"dead-image placeholder carries the corpse" plan is thinner than hoped: 2000s LJ
users didn't write `alt` text, so the placeholder is mostly URL + date.

**Host concentration is what makes poison detection work**, and the shape of it
is the whole design input:

| Rank | Refs    | What it is                                                       |
| ---- | ------- | ---------------------------------------------------------------- |
| 1    | 183     | A webcomic site                                                  |
| 2    | **142** | A free image host of the era — the canonical hotlink-ransom case |
| 3    | 33      | An ISP's personal-pages service, long since shut down            |
| 4    | 25      | LJ's own image host — the most likely to still resolve           |

Hostnames are deliberately **not** recorded here. The design needs the
distribution — one host carrying 142 refs is what makes collapse detectable —
and never the names. A list of the sites someone linked images from across a
decade is a fingerprint of what they read, and it buys this document nothing.
Same rule as the fixtures (§5.4): the detector keys on collapse, never on
identity, so nothing that describes it should know a hostname either.

### 5.3 LJ's own markup

**Not in the original design at all, and found only by surveying the real
corpus.** 111 bodies carry LJ-namespace tags that mean nothing to a browser:

| Tag             | Uses                         | If ignored                             |
| --------------- | ---------------------------- | -------------------------------------- |
| `<lj user="…">` | 204, **193 distinct people** | 204 mentions of people silently vanish |
| `<lj-cut>`      | 73                           | The read-more marker is lost           |
| `<lj-embed>`    | 28                           | Embed reference lost                   |
| `<lj-poll->`    | 3                            | Poll lost                              |
| `<lj-template>` | 1                            | —                                      |

**179 of the 193 `<lj user>` targets are already in the `users` table**, because
they also commented. So most resolve to people the archive already knows, and
can link to their commenter page — the value-add commenter index (§13) gains a
second entry point for free. The other 14 never commented and can only become
plain external links.

**`<lj-cut>` is usually unclosed: 54 of 69 entries.** LJ treated an unclosed cut
as "cut to the end of the entry". An implementation that requires matched pairs
mangles those 54.

### 5.4 The fixture problem this creates

M1's fixtures cannot test any of the above, and the reason generalises.

They're 40 entries captured for _protocol_ shapes. Images live in 122 of 1,547
entries, so a 40-entry slice yields 8 images, 4 hosts, zero `<lj user>`, zero
`<lj-cut>`, and none of the concentrated hosts poison detection exists for.
**A fixture selected for one milestone's needs is not automatically an oracle for
the next one's.**

So M2's oracle is built from the local archive instead — real bodies, selected
for coverage, redacted structure-preserving (prose, usernames and URL paths out;
tags, nesting, quoting and **hosts** kept, because host distribution _is_ the
poison signal). Selection is not authorship; the bytes remain LiveJournal's.

**Known trap: parse5 auto-closes unclosed tags on round-trip.** Verified: an
unclosed `<lj-cut>` goes in as open=1/close=0 and comes out open=1/close=1. A
fixture built by parse-and-reserialize therefore _repairs_ the exact
malformation M2 must survive, and would silently test a well-formed corpus that
does not exist. The redactor must edit in place rather than round-trip — the
same reason the M1 scrubber does surgical text replacement instead of
reserializing (§10).

**Storage is content-addressed.** Fetch the bytes, hash them, store at
`blobs/<sha256[:2]>/<sha256>.<ext>`. A manifest maps source URL → hash. Dedup
across entries, across commenters, and across users sharing an icon falls out
for free. Someone who swapped their "default" userpic in 2004 gets both versions
kept, each comment pointing at the bytes actually shown at the time.

**Poison detection.** This is the one genuinely non-obvious part of the stage.
**It is fully automatic. There is no human in the loop.**

You cannot trust HTTP 200. When Photobucket killed third-party hotlinking in
2017 it did not start returning 404s — it served a placeholder image demanding a
paid plan, at 200, with a valid image content-type. Dead domains now sit behind
wildcard DNS serving ad pages, also at 200. A naive "if it works, store it" loop
stores hundreds of copies of a ransom note, reports near-total success, and
produces an archive that looks healthy and is full of garbage. Status codes
cannot see this.

**Nothing is ever deleted, which is what makes automatic verdicts safe.** Blobs
are content-addressed and `site/` is disposable, so a verdict is a _flag_ on
`assets.status`, never a deletion. A wrong call costs a rebuild, not data.

**Tier 1 — structural. Always on, no network, no LLM.**

1. **Content-type sniff.** `text/html` where an image was requested → dead.
2. **Degenerate images.** 1×1 pixels, zero-byte bodies → dead.
3. **Host collapse → poison.** If N distinct URLs _on the same host_ hash to
   identical bytes, the host is serving a placeholder. This is conclusive at
   scale: 200 distinct Photobucket paths, uploaded across a decade, do not
   legitimately contain identical bytes. It also cleanly avoids the obvious
   false positive — a meme reposted forty times is _one_ URL hashing to one
   blob, which never trips the rule, and a meme hotlinked from several
   different hosts doesn't concentrate on any one host. Threshold
   configurable; confidence scales with N.

Tier 1 alone kills Photobucket, ImageShack, and Tinypic — the actual
mass-extinction events — with no judgment call required.

**Tier 2 — LLM classification. Optional, post-hoc, off by default.**

Runs against an already-built archive, re-flags assets, and triggers a rebuild.
Never required; if it isn't run or isn't available, **images are kept as-is**.

The economics are a consequence of content-addressing: you ask once per distinct
_hash_, not per reference. Thousands of dead images collapse into a few dozen
distinct questions. Opus 4.8 (`claude-opus-4-8`) vision with a structured output
schema, so the verdict is a validated object rather than parsed prose. At this
corpus size that's on the order of 50 calls over small 2000s-era images — under
a dollar, once, for the whole archive. There is no reason to economize on model
tier here; the cost isn't real at this scale.

Note this is the **only** part of the project that needs an API key — a second
credential in a tool that otherwise needs nothing but your LJ password, and the
only dependency that reaches a network other than LiveJournal's. It reuses the
`Secret` machinery (§8), and it stays optional precisely so the core never
depends on it.

**Dead images.** Rendered as a visible placeholder carrying the corpse: original
URL, alt text, entry date. The archive documents what it lost. No Wayback
fallback — explicitly cut from scope.

Third-party hosts get their own politeness budget, per-host, with timeouts and
bounded retries. Image failures never fail the run; they are data.

### 5.5 Build

Templates → static HTML. String-concatenating HTML across a dozen page types is
how you get injection bugs and unmaintainable output; use a real template
engine. That's EJS (§15), and EJS `<%=` is the single owner of escaping — the
build never pre-escapes what it hands a template.

Output is entirely relative-pathed and opens from `file://`.

## §6. Data model

Nullability here is not incidental — every `NULL` below is a real shape LJ sends
(§5.1), and getting one wrong is a bug on live data.

```sql
entries      itemid PK, anum, ditemid, eventtime, logtime, subject, body,
             security, allowmask, mood, moodid, music, location,
             picture_keyword, props_json, fetched_at
             -- ditemid comes from LJ; not computed
             -- mood NULL-able, moodid NULL-able, independently
moods        moodid PK, name, parent      -- LJ's vocabulary, fetched once
entry_tags   itemid FK, tag                      -- (itemid, tag) PK
users        posterid PK, username, is_deleted, identity_type
comments     id PK, jitemid FK->entries.itemid,
             parentid NULL,        -- NULL = top-level. Never 0.
             posterid NULL FK,     -- NULL = anonymous. 22 in this journal.
             subject NULL, body NULL,   -- both NULL when state='D'
             date, state, fetched_at
assets       hash PK, mime, byte_len, width, height, status, local_path
             -- status: ok | dead | suspect | poison
asset_refs   id PK, hash FK, source_url, context, context_id,
             alt_text, http_status, fetched_at
             -- context: entry | comment | userpic
sync_state   key PK, value
```

Notes:

- **`comments.parentid` is NULL for top-level, never 0.** LJ omits the attribute
  entirely; an earlier draft of this document said `0` and would have made every
  top-level comment look like a reply, flattening every thread.
- **`comments.posterid` is nullable** — anonymous comments carry no `posterid` at
  all (not `0`). A non-null FK throws on real data.
- **`users` has no `is_anon`.** Anonymity is the absence of a poster, not a kind
  of user — modelling it as a row invents an identity LJ never asserted.
- `entries.mood` and `entries.moodid` are independent; either, both, or neither.
  Resolve `moodid` through `moods` at build time, prefer `mood` when present.
- `assets.status` carries the poison verdict; `build` renders `dead` and
  `poison` identically (placeholder + corpse metadata).
- `asset_refs` is many-to-one against `assets` — that relationship _is_ the
  dedup, and its cardinality _is_ the poison signal.
- No `deleted` flag on entries. The corpus is frozen; what's there is what there
  is. (Comments are different — they carry LJ's own `state`.)

## §7. The site

### 7.1 Reading experience

Modern, clean, readable. **We do not reproduce LJ's styling** — nobody misses
the layout. What people miss is the texture, so metadata is first-class content,
not chrome: mood, music, location, the userpic chosen for that specific post,
the security level, tags, timestamp.

**Themable** means CSS custom properties over semantic markup, with one
swappable stylesheet: the build writes `site/style.css` (light/dark via
`prefers-color-scheme`) and every page links it. To restyle, replace that file.
Not a plugin system, and no `--theme` flag — a second theme was planned to prove
the seam, but one file every page loads already proves it.

### 7.2 Navigation

**Baseline — table stakes, built first:**

- Entry pages, one per entry, permalinked by ditemid.
- **Calendar.** Year → month → day. Pick a date, see its entries.
- **Prev/next spine.** Read the whole journal forward like a book.
- Tag index.

**Value-add — good, but explicitly not baseline:**

- "On this day" across the years (same month-day, every year).
- Commenter index — every thread a given person touched, across a decade. For a
  social archive this is arguably the best thing in it.
- Userpic gallery.
- Activity heatmap.
- Search over entries and comments (§7.4).
- Related entries on every entry page (§7.5).

### 7.3 Link rewriting

A build-time pass, no server involved. Links inside entries pointing at
Preston's own journal are rewritten to local relative paths.

An LJ permalink carries the `ditemid` (`username.livejournal.com/12345.html`
→ ditemid 12345), and `entries.ditemid` is stored directly from LJ (§5.1), so
this is a lookup, not arithmetic. `itemid = ditemid >> 8` holds, but deriving it
is unnecessary and would be one more place to be subtly wrong.

Self-references stop dead-ending.

Links to _other_ people's LiveJournals are left alone. They're external, they're
probably dead, and that's not ours to fix.

### 7.4 Search — in the static site

**Decision: search lives in the archive itself, as a page that runs in the
browser from `file://`. No app, no server.** This reverses the earlier decision
to make search app-only (Electron + FTS5). That decision was the only real job
the app had, and the reason given for it — that a browser can't search local
files — turned out to be about _how_ data is loaded, not whether it can be.

**`file://`, measured, not assumed** (Playwright, November 2026: Chromium 149,
Firefox 151, WebKit 26.5):

| From a `file://` page                | Chromium | Firefox | WebKit |
| ------------------------------------ | -------- | ------- | ------ |
| classic `<script src>`               | ✓        | ✓       | ✓      |
| `fetch()` / XHR of a local file      | ✗        | ✓       | ✗      |
| ES modules (static or `import()`)    | ✗        | ✓       | ✗      |
| `new Worker('file.js')`              | ✗        | ✓       | ✗      |
| Worker from a `blob:` URL            | ✓        | ✓       | ✓      |
| WebAssembly from in-memory bytes     | ✓        | ✓       | ✓      |
| WebAssembly via `fetch()`            | ✗        | ✓       | ✗      |
| `crossOriginIsolated` (wasm threads) | ✗        | ✗       | ✗      |

So everything the search page loads is a **classic script**. Never
`type="module"`, never `fetch()`.

**How it works.** The build writes `search/data.js` — one record per entry and
per comment with words, assigning a global — and `search/search.js`, the engine.
`search/index.html` loads both. The engine is a straight scan: no index, no
library. On the real journal (1,547 entries, 6,550 comments) `data.js` is 3.0 MB,
the page is ready in under 200 ms, and a query takes 1–13 ms in all three engines.

- **What's indexed is what's shown.** Records come from the _rendered_ body
  (after `renderBody`), never the raw LJ markup, so a hit can't point at text the
  page doesn't show — `lj user="…"` attributes, a cut's raw tag — and can't miss
  text it does. Checked in the browser against every record (§10).
- **Matching:** every word must appear (AND); `"quoted phrases"` stay together;
  case, accents, and curly quotes are folded. Scope: everything / entries /
  comments. Sort: best match, newest, oldest. A comment is not matched by the
  title of the entry it sits under.
- **Results are built with DOM nodes, never `innerHTML`.** The indexed text is
  the journal's own words, and an entry that says `<b>` has to show it.
- **Query state lives in the URL hash**, so a search is linkable and the back
  button works.
- **With JS off** the form stays hidden and the page says how to `grep`. Search
  is value-add (§13); the floor is still the filesystem.

**Semantic search: planned, not built.** Searching by meaning ("when was I
fighting with my roommate") needs an embedding model to encode the query in the
browser. The table above says it's feasible — WebAssembly from in-memory bytes
and `blob:` workers work everywhere — but it is unverified end to end: an
existing open-weight model (MiniLM-class, ~25 MB quantized) and its runtime
would have to load as classic scripts, and keep working for decades. A spike
comes before any design. Keyword search stays as the fallback either way.

### 7.5 Related entries

Each entry page lists up to five others it has the most in common with, with
the shared words that put each one there. Computed at build time, rendered as
plain links — no script, no model, as durable as the rest of the HTML.

**TF-IDF cosine**, deliberately lexical. Two entries are related when they share
words that are _rare_ in the journal — a friend's name, a band, a place. A tag
counts as a strongly weighted word. Rules, each one a bug it prevents:

- Terms in one entry or in over half of them are left out: they can't link two
  entries, or can't distinguish any.
- Vectors are L2-normalised, so a long entry doesn't relate to everything.
- A link needs **at least two** shared words. One is a coincidence.
- Only the author's words count. Text the renderer writes — "▶ Watch on
  YouTube", lost-image markers, LJ-feature notices — is searchable but never
  makes two entries related (`RENDERER_TEXT_CLASSES` in `render.ts`).
- Ties break on id, so the same `archive.db` builds the same bytes.

On the real journal, 1,137 of 1,547 entries get at least one link; the rest are
too short to say what they're about, and get no list rather than a guess. If
semantic embeddings arrive (§7.4), they replace the vectors; the output stays
the same.

## §8. Security posture

**Credentials are never stored.** Prompted interactively with no echo, or
injected at runtime via env var (injection, not storage — popped from the
environment immediately on read). Plaintext is hashed and dropped at once.

**`md5(password)` is password-equivalent and must be treated as the secret
itself.** LJ computes `md5(challenge + md5(password))`, so anyone holding the
hash authenticates as you indefinitely without ever learning your password.
There is nothing to crack. Collision resistance is irrelevant here; this is not
a hashed derivative, it is a bearer credential. (It is also unsalted, so a
rainbow table surrenders the plaintext too — which matters if the password is
reused anywhere.)

**Mitigations that are real:**

- A `Secret` wrapper whose string and debug representations redact, so the
  credential cannot be printed, logged, or rendered into a stack trace. This is
  the leak that actually happens.
- `reveal()` is the only accessor, so every use site is greppable.
- `LJ_PASSWORD` is deleted from the environment on read, so a child process
  can't inherit it.

**Mitigations we are not pretending to have:** in-process encryption of the
secret — whatever key we wrapped it with would sit in the same memory, so that's
theater. Nor do we disable coredumps: Node has no `setrlimit`, so the tool relies
on the OS default (core size 0 on macOS). Only `fetch` ever holds the secret, for
a run of about forty requests.

**Repo hygiene.** Public repo, MIT licensed, no data or credentials in source
control, ever. Default output is `./archive/`, which is gitignored — and the
generated directory gets its own `.gitignore` containing `*`, so an archive can
never be committed even if someone force-adds the parent. Belt and suspenders,
because the failure mode is publishing a decade of private entries to GitHub.

## §9. Error handling

| Condition                         | Response                                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| LJ 403                            | **Stop immediately.** Plain-language message. 403 means ban; retrying deepens it.            |
| LJ 5xx                            | Bounded exponential backoff, then stop and checkpoint.                                       |
| LJ auth failure                   | Stop. Distinguish "bad password" from "client too old" (the latter is a version-string fix). |
| Killed mid-run                    | `sync_state` checkpoint; next run resumes.                                                   |
| Image 404 / timeout / DNS failure | Record as dead, keep going. Never fails the run.                                             |
| Image 200 with wrong content-type | Record as dead.                                                                              |
| Image is a suspected placeholder  | Flag `suspect`, surface for review.                                                          |
| Malformed entry HTML              | Parse forgivingly (parse5), never drop an entry.                                             |

## §10. Testing

### The rule: oracle provenance

**A test's expected value must not be derived from the code under test.** That is
the whole discipline, and every failure mode below is a violation of it.

Tests written by reading the implementation can only ever assert "the code does
what the code does" — a tautology with a green checkmark. They execute lines, so
coverage looks superb. They notice edits, so they survive mutation testing. They
catch nothing, because a bug in the code was faithfully copied into the
expectation.

So: **prefer oracles nobody here authored.**

| Layer      | Oracle                                                                                                           | Why it can't go tautological                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Fetch      | Recorded real LJ XML, captured once, scrubbed                                                                    | LiveJournal wrote it in 2005. The fixture can't be bent to match a bug                        |
| Build      | Playwright driving the built archive at `file://`                                                                | Asserts the artifact, not the code. There is no fake version of "the journal opens and reads" |
| Images     | Local server: known-good bytes, 404s, timeouts, `text/html`-at-200, identical placeholder bytes across many URLs | Known-right answers, chosen adversarially rather than to match the implementation             |
| Invariants | Stated properties (below)                                                                                        | Facts about the system, not lines to cover                                                    |

**CI never touches LiveJournal** — it's someone else's server, it bans clients,
and a suite depending on a 2010-era API being up fails for reasons unrelated to
our code.

**Build tests use a synthetic corpus**: a hand-built `archive.db` with known
contents, including the nasty cases — deleted commenter, anonymous comment,
screened comment, private entry, dead image, 2000-era tag soup.

### Name the defect

**Every nontrivial test ships with the specific break that makes it fail, named
in the PR.** Not a random mutation — _the_ defect the test exists to catch:

> catches: comment `parentid` read as `jitemid`, silently flattening every thread

**If you can't name the defect, the test is decorative. Don't write it.**

This is mutation testing with a chosen mutant instead of an arbitrary one: zero
runtime, no equivalent-mutant noise, no ratchet, and the artifact is one sentence
a reviewer can call bullshit on.

### Why not Stryker

Mutation testing measures whether tests are _sensitive_, not whether they're
_meaningful_. It catches "asserts nothing." It cannot catch "asserts the
implementation back at itself" — implementation-derived tests kill mutants
perfectly well. Applied to coverage-farmed tests it makes them longer and more
brittle, not better, and charges runtime plus a ratchet chore for the privilege.
It earns its keep as a _discovery_ tool on code you didn't write and don't
understand; as a quality gate on new code it optimizes a proxy.

Reversible: if the tests in a milestone don't survive review, `npm i -D
@stryker-mutator/core` and this section was wrong.

### Coverage is not measured

No coverage script, no coverage gate, no coverage report. It is the incentive
that grows the disease; reporting it feeds it. A number that rewards executing
lines will get lines executed.

### Enforced by test, not convention

- `usejournal` is never sent (§3) — scope violation, would archive nine
  communities nobody asked for.
- `Secret` never renders its value (§8) — `md5(password)` is password-equivalent.
- Core never reaches `console`/`process` (§15) — enforced by lint, which CI runs.

## §11. Milestones

| #   | Deliverable                                                                            | Done when                                                |
| --- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| M0  | Repo scaffolding, CI, `Secret`, config, CLI skeleton                                   | `neo-lj --help` works, CI green                          |
| M1  | Fetch: entries + comments → SQLite, resumable                                          | Full journal fetched; re-run is a no-op                  |
| M2  | Images: extract, download, content-address, auto-classify                              | Every image localized or honestly marked dead            |
| M3  | Build: entry pages, calendar, prev/next, tags, themeable                               | **Static archive complete and greppable from `file://`** |
| M4  | Static value-adds: commenter index, userpic gallery, heatmap, on-this-day-across-years | Shipped, plus Retrospect (moods, music, hours)           |
| M5  | Keyword search (§7.4) and related entries (§7.5), both static                          | Shipped                                                  |
| M6  | Semantic search in the browser (§7.4)                                                  | Spike first: an open-weight model running at `file://`   |

**Status: M0–M5 done.** M1–M3 met their done-when on the real journal. The live
audit (`scripts/audit-vs-live.mts`) has checked all 1,547 entries against
LiveJournal; 1,540 match on text, and the divergent ones stay in
`archive/audit/state.json` for `--recheck`. M6 has not started.

**M3 is the finish line for tablestakes** — everything §13 calls baseline, done,
in the tier that outlives the tooling. M1 and M2 are plumbing; M0–M3 are strictly
ordered, each depending on the last. Everything after M3 is value-add, and none of
it may become a prerequisite for reading the archive (§13).

**Retired: the Electron app.** The original M5 was an Electron shell with FTS5
search and the pipeline behind a UI. Search was its only real job, and it now
lives in the static site (§7.4). Running a pipeline from a UI has no value for a
journal that stopped changing in 2010. Retired 2026-11-03.

Scrapbook / Fotobilder is out of scope — Preston has no memory of using it, and
if any LJ-hosted images do turn up they're ordinary images (§5.2), not a
milestone.

## §12. CLI

```
neo-lj fetch         [--user U] [--delay MS]           # LJ -> archive.db, resumable
neo-lj images        [--concurrency N] [--timeout MS]  # download, hash, auto-classify (tier 1)
neo-lj userpics                                        # download userpics the audit scraped
neo-lj video-posters                                   # poster frames for scraped YouTube embeds
neo-lj classify                                        # reserved, unscheduled: LLM pass over suspects
neo-lj build         [--user U]                        # archive.db -> site/
neo-lj status                                          # what's fetched
```

Every command takes `--out DIR` (default `./archive`). The userpic → picid
mapping and embed URLs aren't in the XML-RPC API, so they're scraped from the
live pages by `scripts/audit-vs-live.mts`, which must run before `userpics` and
`video-posters`.

Credentials via no-echo prompt, or `LJ_USER` / `LJ_PASSWORD` env injection for
non-interactive runs. Never via flag — flags land in shell history and `ps`.

## §13. Tiers and priority

Two **independent** axes. Conflating them is the failure mode this section exists
to prevent:

- **Priority** — _tablestakes_ (baseline; the archive isn't worth having without
  it) vs _value-add_ (good, wanted, not required).
- **Needs** — _HTML only_ (a browser with script off reads it) vs _script_
  (needs JavaScript in the page).

**The invariant: nothing tablestakes may need script.** Value-add may use it,
and must still leave the page usable without it — the search page explains how
to `grep`; "On this day" falls back to a fixed date. A baseline feature drifting
into script is how the archive quietly becomes something that needs a runtime,
and the durability argument collapses.

There is no app tier any more (§11, retired). Nothing in the archive needs
anything but a browser.

| Feature                                                                      | Priority    | Needs      |
| ---------------------------------------------------------------------------- | ----------- | ---------- |
| Entry pages, full metadata, threaded comments                                | tablestakes | HTML only  |
| Local images + userpics; dead-image placeholders                             | tablestakes | HTML only  |
| Calendar (year/month/day), prev/next spine, tag index                        | tablestakes | HTML only  |
| Commenter index, userpic gallery, activity heatmap, on-this-day-across-years | value-add   | HTML only  |
| Related entries (§7.5)                                                       | value-add   | HTML only  |
| Search — entries + comments, scoped (§7.4)                                   | value-add   | **script** |

Note what's _absent_: search is not tablestakes. The archive is plain HTML on
disk, so `grep` already meets the floor — a search page is convenience, not
capability.

**When a feature's classification is ambiguous, ask — don't infer.** That
ambiguity is exactly where the invariant gets broken by accident.

## §14. Requirements on the stack

What the design imposes, independent of any particular choice. Recorded so §15
is arguable rather than asserted.

- **A forgiving HTML5 parser.** Non-negotiable, and the single most
  stack-constraining requirement here. Entry bodies are hand-written tag soup
  from 2000–2010; a strict parser will choke on real data.
- **An HTTP client with concurrency**, for image fetching against slow and dead
  third-party hosts, with per-host politeness and timeouts.
- **MD5, and the ability to POST XML.** LJ's XML-RPC is not exotic — the spike
  hand-rolled the entire protocol with no libraries. Native XML-RPC support is a
  convenience, not a requirement.
- **SQLite bindings**, for the canonical store.
- **A template engine.**
- **A no-echo credential prompt.**
- **A distribution story.** **Settled: the tool is for Preston; the codebase is
  for whoever wants it.** There is no real distribution, so code signing and
  notarization never apply. The only bar is that a technical stranger shouldn't
  have to move mountains to run it. This doesn't weaken §13 — the _archive_
  still has to outlive the toolchain; it's the _app_ that's allowed to be
  disposable.

## §15. The stack

**Node + TypeScript. A CLI.**

### Why Node

The original reason was Electron: pipeline code written for a Node CLI runs
unchanged in an Electron main process. Electron is retired (§11), and the choice
still holds on its own:

- **parse5** is the reference-grade implementation of the HTML5 parsing
  algorithm — §14's hardest requirement, well served.
- Concurrent fetching against thousands of slow-or-dead image hosts is what an
  event loop is for.
- **`node:sqlite` is built in** — no native module (below).
- The site's search engine is JavaScript, so the build and the browser share one
  language, and unit tests run the exact script the browser runs.

### The core/shell split — the actual mechanism

The pipeline is a library that knows nothing about how it's driven:

```
src/core/   fetch, images, build. No console, no process, no argv, no exit.
            Takes a config object and a progress callback. Returns results.
src/cli/    thin shell: argv, no-echo prompt, progress rendering, exit codes.
```

**Enforced by lint rule, not convention** — `no-console` and a `process` ban
under `src/core/**`. Same posture as the `usejournal` ban (§3).

It was introduced so Electron could be a second shell. It earns its keep without
that: tests drive core directly — an in-memory store, a reporter that records
events — with no process to spawn and no output to scrape.

### `node:sqlite`, not `better-sqlite3`

`node:sqlite` is built into Node (unflagged since v22.13.0). `better-sqlite3` is a
native addon, which has to be rebuilt against each Node ABI and won't build
against a 2032 Node without work; a built-in ages better. Performance is a
non-issue at ~8,000 rows (§2).

**Honest caveat:** `node:sqlite` is experimental on the LTS lines (release
candidate as of v25.7.0); the API can still shift. Contained by design — it lives
behind the store module the core/shell split already requires, and the _data_ is
an ordinary SQLite file. API churn costs one file; the archive is untouched.

### Toolchain — inherited from `prestonguillot/vibes`

Default to what `vibes` already uses; deviations require justification.

| Concern         | Choice                                                                                                    | Source                                 |
| --------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Package manager | npm                                                                                                       | vibes                                  |
| Language        | TypeScript (strict), ESM                                                                                  | vibes                                  |
| Tests           | Vitest                                                                                                    | vibes                                  |
| E2E             | Playwright — drives the built archive at `file://`, testing the tablestakes tier directly                 | vibes                                  |
| Lint / format   | ESLint + Prettier                                                                                         | vibes                                  |
| Templates       | EJS                                                                                                       | vibes                                  |
| Interactivity   | Native elements (`<details>`, `<dialog>`) over JS — `<details>` is near-purpose-built for comment threads | vibes                                  |
| CLI parsing     | commander                                                                                                 | no vibes precedent (it's a server app) |
| HTML parsing    | parse5                                                                                                    | no precedent                           |
| HTTP            | undici                                                                                                    | no precedent                           |
| XML             | fast-xml-parser                                                                                           | no precedent                           |
| Store           | `node:sqlite`                                                                                             | no precedent                           |

**Deviation — Bootstrap.** `vibes` uses Bootstrap 5 (CSS-only); this doesn't.
Justification: `vibes` has chrome (navbars, forms, modals) and earns it. The
archive is a _reading surface_ — typography, a calendar grid, threaded comments —
with almost no chrome. Bootstrap also works against §7.1's theming requirement:
"swap one stylesheet" is real with ~150 lines of hand-written CSS over custom
properties, and awkward when overriding a large opinionated framework. This is a
preference, not a correctness claim — reversible on request.

**Open — Stryker.** `vibes` runs mutation testing; not proposed here. The value
in this codebase concentrates in fixture-replay tests for the fetcher and
synthetic-corpus tests for the generator, and mutation-testing a batch pipeline is
a lot of runtime for modest signal. Adopt on request.

### "Doesn't suck" for a solo user, CLI-first

Real progress across the image download; prints the path to the finished
archive's `index.html`. `npx neo-lj` clears §14's mountains bar.

## Unresolved

Nothing blocking. Open questions are recorded inline: Bootstrap (§15) and Stryker
(§15) are both reversible preferences awaiting a word either way.
