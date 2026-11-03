#!/usr/bin/env tsx
/**
 * Diff the built archive against the live journal (DESIGN.md §10).
 *
 * This exists because the test suite cannot find this class of bug. The fixtures
 * are ones I wrote, so they encode what I already believed; 145 unit tests and 12
 * browser tests were green while entry 406397 silently rendered 1 of its 3
 * images. Preston found it in a minute by opening the live page. LiveJournal is
 * the only oracle here that doesn't share the author's blind spots.
 *
 * All three of these work — text parity, structure parity, and the harvest.
 *
 *   WORKS  Harvest the userpics and embed URLs the XML-RPC API refuses to give
 *          up — per-entry AND per-comment, keyed by picid/userid. Verified
 *          against an oracle it didn't author: every userid scraped is either
 *          the author or a commenter already in our users table. Zero unknown.
 *
 *   WORKS  Does the renderer drop what archive.db holds? Offline, no network.
 *          This is the <lj-embed> class.
 *
 *   WORKS  Is archive.db complete? Compares LJ's rendering of the body against
 *          ours. Seven heuristics tried to infer the body container and every
 *          one cried wolf on entries that were provably intact. Then I looked at
 *          the markup: it is div.entry_text, identical on every entry. The
 *          lesson is the whole project's lesson — look at the thing rather than
 *          reason about it from a distance.
 *
 * NO BROWSER. The pages are plain server-rendered HTML, fetched over HTTP and
 * parsed with parse5 — the same HTML5 algorithm a browser runs. Auth is one
 * login through LJ's own login form per run, with a cookie jar following the
 * redirects (including the handoff that gives the journal subdomain its own
 * session). Password from a no-echo prompt or LJ_PASSWORD; nothing stored.
 *
 * Why not the API's session (sessiongenerate)? Measured: www accepts it, the
 * journal subdomain doesn't — it bounces to login.bml, which bounces back, in a
 * loop; and the subdomain handoff needs a real web master session, so LJ clears
 * the cookies. Why not a browser? Playwright's Chromium stopped getting any
 * response from LJ in November 2026, and saved sessions expire.
 *
 *   npx tsx scripts/audit-vs-live.mts [n] [--recheck]
 *
 * CALIBRATED EVERY RUN. Before auditing anything, it re-audits a few entries the
 * browser-based audit already verified — parity, plus their userpics and embed
 * URLs. If parse5-over-HTTP doesn't reproduce those exactly (JS-built content, a
 * different layout for a non-browser client, a session that only half works),
 * the run stops before recording a single verdict. The instrument is checked
 * against an oracle it didn't produce, every time.
 *
 * The report lands under archive/, which is gitignored: it is private content.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parse } from 'parse5';
import { renderBody } from '../src/core/build/render.js';
import { SCHEMA } from '../src/core/store/schema.js';
import { readHidden } from '../src/cli/credentials.js';
import { Secret } from '../src/core/secret.js';

/**
 * What has already been audited, and how it came out.
 *
 * The point of chunking: each run must spend its requests on entries nobody has
 * looked at yet. Re-auditing the same 14 would rediscover the same bugs and find
 * no new ones, while still paying the full ban risk. Entries that reached parity
 * are retired; the ones that diverged stay listed so a fix can be re-checked on
 * purpose (--recheck) rather than by accident.
 */
const STATE = './archive/audit/state.json';

interface Verdict {
  shape: string;
  gap: number; // 0 = parity, >0 = chars LJ shows that we don't, -1 = body not found
  /**
   * Line breaks LJ renders minus line breaks we render.
   *
   * The whole reason this field exists: `gap` compares letters and digits only,
   * deliberately, because whitespace and tokenisation produced constant false
   * positives. Immune to whitespace turned out to mean BLIND to whitespace — it
   * certified 1,541 entries "at parity" while 73% of the journal rendered as one
   * wall of text, every paragraph break gone. An oracle that cannot see the
   * defect will happily sign off on it forever. Content loss and formatting loss
   * are different failures and need different instruments.
   */
  brDiff: number;
  note?: string;
}
type State = Record<string, Verdict>;

const loadState = (): State =>
  existsSync(STATE) ? (JSON.parse(readFileSync(STATE, 'utf8')) as State) : {};

const saveState = (s: State): void => {
  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync(STATE, JSON.stringify(s, null, 2));
};

const USER = process.env['LJ_USER'] ?? 'evilgoatbob';
const SAMPLE = Number(process.argv[2] ?? 40);

/** LJ bans clients and a 403 is terminal (§9). This is deliberately slow. */
const PACE_MS = 2000;

const db = new DatabaseSync('./archive/archive.db');
// This opens sqlite directly rather than through Store, so the schema has to be
// applied by hand — the userpic tables are new and every statement is
// CREATE ... IF NOT EXISTS, so this is idempotent on an existing archive.
db.exec(SCHEMA);

interface Row {
  ditemid: number;
  itemid: number;
  body: string;
  shape: string;
}

/**
 * Sample by SHAPE, not at random. The bugs live in the weird markup — an
 * unclosed embed, a cut wrapping a table, a poll — and a uniform random sample
 * of 40 from 1,547 would very likely contain none of them.
 */
function sample(seen: Set<string>): Row[] {
  const shapes: [string, string][] = [
    ['lj-embed', "body LIKE '%<lj-embed%'"],
    // lj-poll and lj-template are DELIBERATELY not sampled. Four of them audited
    // and all four diverge identically: LJ renders questions it kept on its own
    // servers, the export has only <lj-poll-NNN>, and the page already says so.
    // Auditing more would re-confirm a known, unrecoverable class at 2s a request
    // and find nothing new. 25 entries carry them; none is checkable this way.
    ['lj-cut', "body LIKE '%<lj-cut%'"],
    ['table', "body LIKE '%<table%'"],
    ['lj-user', "body LIKE '%<lj user%'"],
    ['many-images', "(LENGTH(body) - LENGTH(REPLACE(LOWER(body), '<img', ''))) / 4 >= 3"],
    ['object-embed', "body LIKE '%<object%' OR body LIKE '%<embed%'"],
    ['plain', '1=1'],
  ];
  const per = Math.max(2, Math.floor(SAMPLE / shapes.length));
  const picked = new Set<number>();
  const out: Row[] = [];
  for (const [shape, where] of shapes) {
    // Pull a wide net, then skip what's already audited. Ordering by length
    // DESC and taking the top N would hand every run the SAME longest entries
    // forever — the chunking would explore nothing.
    const rows = db
      .prepare(
        `SELECT ditemid, itemid, body FROM entries WHERE ${where} ORDER BY LENGTH(body) DESC`,
      )
      .all() as Omit<Row, 'shape'>[];
    for (const r of rows) {
      if (picked.has(r.ditemid) || seen.has(String(r.ditemid))) continue;
      if (out.filter((o) => o.shape === shape).length >= per) break;
      picked.add(r.ditemid);
      out.push({ ...r, shape });
    }
  }

  // Top up from whatever is left over.
  //
  // The per-shape cap is what makes the FIRST chunks find bugs: it forces the
  // weird markup in front of the check instead of letting a uniform sample miss
  // every poll and unclosed embed. But once a shape is exhausted its bucket just
  // goes empty, and the cap silently throttles the run to a fraction of the
  // target — 664 of 1547 audited, 883 left, and a chunk asked for 1600 doing 228.
  // The shape quota is a floor on variety, not a ceiling on work.
  if (out.length < SAMPLE) {
    const rest = db
      .prepare('SELECT ditemid, itemid, body FROM entries ORDER BY eventtime DESC')
      .all() as Omit<Row, 'shape'>[];
    for (const r of rest) {
      if (out.length >= SAMPLE) break;
      if (picked.has(r.ditemid) || seen.has(String(r.ditemid))) continue;
      picked.add(r.ditemid);
      out.push({ ...r, shape: 'fill' });
    }
  }
  return out;
}

/**
 * Tags out, entities decoded, whitespace collapsed. Contiguous, order intact.
 *
 * NUMERIC entities matter as much as the named ones. LJ stores apostrophes as
 * &#39;, so the source reads `don&#39;t` while the renderer correctly emits
 * `don't` \u2014 and comparing those raw strings scores a CORRECT render as data
 * loss. That was the entirety of the "RENDERER-LOSS" on entry 403272: six
 * apostrophes. A measurement that flags correct behaviour is worse than none,
 * because it spends a human's attention on nothing.
 */
const plain = (s: string): string =>
  s
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    // &amp; LAST: decoding it first turns a literal "&amp;#39;" into "&#39;" and
    // then into an apostrophe, inventing a character the source never had.
    .replace(/&amp;/g, '&')
    .replace(/[\s\u00A0]+/g, ' ')
    .trim();

/** For set-comparison only. Short words are dropped as noise. */
const words = (s: string): string[] =>
  plain(s)
    .split(' ')
    .filter((w) => w.length > 3);

/**
 * Letters and digits only. Immune to tags, whitespace and tokenisation — the
 * three things that made every earlier comparison lie.
 *
 * Word-splitting could never work here: plain() turns tags into SPACES while the
 * DOM's textContent turns them into NOTHING, so LJ's `<b>hello</b><i>world</i>`
 * is one token and ours is two. On a 20k entry that manufactured 533 phantom
 * "missing words" on an entry that was perfectly intact.
 */
const stream = (s: string): string =>
  plain(s)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The longest run of LJ's letters that is absent from ours, in order.
 *
 * Subsequence, not containment: the archive deliberately ADDS text LJ never had
 * — cut labels, "image lost" markers, poll notices — and those insertions break
 * contiguity while losing nothing. Loss is the reverse: LJ having letters we
 * don't. Over thousands of characters, matching by coincidence is impossible.
 */
const missingRun = (lj: string, ours: string): number => {
  let i = 0;
  let worst = 0;
  let run = 0;
  for (const ch of lj) {
    const at = ours.indexOf(ch, i);
    if (at === -1) {
      run++;
      worst = Math.max(worst, run);
    } else {
      i = at + 1;
      run = 0;
    }
  }
  return worst;
};

/**
 * Log in with the password and SAVE the session.
 *
 * The saving is the point. Re-authenticating per run is what got LJ's web login
 * throttled while the account stayed perfectly healthy on XML-RPC — so this runs
 * at most once, then every later run reuses the cookies.
 */
// --- the page, as parse5 sees it -------------------------------------------
//
// Each helper mirrors one DOM call the browser audit made, with the same
// semantics: document order, first match, URLs resolved against the page.

interface PNode {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: PNode[];
}

const attrOf = (n: PNode, name: string): string | undefined =>
  n.attrs?.find((a) => a.name === name)?.value;
const hasClass = (n: PNode, c: string): boolean =>
  (attrOf(n, 'class') ?? '').split(/\s+/).includes(c);

/** Every element below n, document order, each with its ancestors (nearest last). */
function* walk(n: PNode, anc: PNode[] = []): Generator<[PNode, PNode[]]> {
  for (const c of n.childNodes ?? []) {
    yield [c, anc];
    yield* walk(c, [...anc, c]);
  }
}
const first = (n: PNode, pred: (d: PNode, anc: PNode[]) => boolean): PNode | undefined => {
  for (const [d, anc] of walk(n)) if (pred(d, anc)) return d;
  return undefined;
};
const all = (n: PNode, pred: (d: PNode, anc: PNode[]) => boolean): PNode[] =>
  [...walk(n)].filter(([d, anc]) => pred(d, anc)).map(([d]) => d);

/** LJ's "Tags:" footer inside the body — excluded, as the browser audit did. */
const isTags = (n: PNode): boolean => n.nodeName === 'div' && hasClass(n, 'ljtags');
/** textContent, minus the tags footer. */
const textOf = (n: PNode): string =>
  n.nodeName === '#text'
    ? (n.value ?? '')
    : isTags(n)
      ? ''
      : (n.childNodes ?? []).map(textOf).join('');
const brsOf = (n: PNode): number =>
  isTags(n)
    ? 0
    : (n.nodeName === 'br' ? 1 : 0) + (n.childNodes ?? []).reduce((s, c) => s + brsOf(c), 0);

/** img.src / iframe.src: the browser hands back an absolute URL; so do we. */
const srcOf = (n: PNode, base: string): string => {
  const raw = attrOf(n, 'src');
  if (raw === undefined || raw === '') return '';
  try {
    return new URL(raw, base).href;
  } catch {
    return '';
  }
};

interface Page {
  body: PNode | undefined;
  liveBody: string | null;
  liveBreaks: number;
  entryPic: { picid: number; userid: number; url: string } | null;
  commentPics: { commentId: number; picid: number; userid: number; url: string }[];
  frames: string[];
}

const PIC_RE = /l-userpic\.livejournal\.com\/(\d+)\/(\d+)/;

function readPage(html: string, url: string): Page {
  const doc = parse(html) as unknown as PNode;
  // div.entry_text: LJ's own name for the body, read off the markup.
  const body = first(doc, (d) => d.nodeName === 'div' && hasClass(d, 'entry_text'));

  // '.subcontent .userpicfriends img' — an img under .userpicfriends under
  // .subcontent. NOT 'img.userpicfriends': LJ puts that class on the parent div.
  const entryImg = first(doc, (d, anc) => {
    if (d.nodeName !== 'img') return false;
    const k = anc.findIndex((a) => hasClass(a, 'subcontent'));
    return k !== -1 && anc.slice(k + 1).some((a) => hasClass(a, 'userpicfriends'));
  });
  const eSrc = entryImg ? srcOf(entryImg, url) : '';
  const em = PIC_RE.exec(eSrc);
  const entryPic = em ? { picid: Number(em[1]), userid: Number(em[2]), url: eSrc } : null;

  // [id^="ljcmt"], then the first img.userpiccomment inside each.
  const commentPics: Page['commentPics'] = [];
  for (const el of all(doc, (d) => (attrOf(d, 'id') ?? '').startsWith('ljcmt'))) {
    const dtalkid = Number((attrOf(el, 'id') ?? '').replace('ljcmt', ''));
    const img = first(el, (d) => d.nodeName === 'img' && hasClass(d, 'userpiccomment'));
    if (!Number.isFinite(dtalkid) || !img) continue;
    const src = srcOf(img, url);
    const m = PIC_RE.exec(src);
    if (m)
      commentPics.push({
        commentId: dtalkid >> 8,
        picid: Number(m[1]),
        userid: Number(m[2]),
        url: src,
      });
  }

  // 'div.entry_text iframe' — scoped to the body; every page has chrome iframes.
  const frames = all(
    doc,
    (d, anc) =>
      d.nodeName === 'iframe' && anc.some((a) => a.nodeName === 'div' && hasClass(a, 'entry_text')),
  )
    .map((f) => srcOf(f, url))
    .filter(Boolean);

  return {
    body,
    liveBody: body ? textOf(body) : null,
    liveBreaks: body ? brsOf(body) : -1,
    entryPic,
    commentPics,
    frames,
  };
}

class Banned extends Error {}

/**
 * The smallest browser that works: a cookie jar and hand-followed redirects.
 *
 * LJ's web auth is three cookies it signs ITSELF — ljsession (v1), and
 * ljloggedin and ljmastersession (v2), each with its own timestamp and
 * signature — so a client can't assemble them from the API's session; the first
 * version of this script tried, and every private page bounced to login.bml.
 * The way in is to hold whatever LJ sets and send it back, as a browser would.
 */
class Jar {
  readonly #c = new Map<string, { value: string; domain: string }>();

  header(url: URL): string {
    return [...this.#c]
      .filter(([, c]) => url.hostname === c.domain || url.hostname.endsWith(`.${c.domain}`))
      .map(([name, c]) => `${name}=${c.value}`)
      .join('; ');
  }

  set(name: string, value: string, domain: string): void {
    this.#c.set(`${name}`, { value, domain: domain.replace(/^\./, '') });
  }

  take(res: Response, url: URL): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = '', ...attrs] = line.split(';').map((x) => x.trim());
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const dom = attrs.find((a) => /^domain=/i.test(a))?.slice(7) ?? url.hostname;
      const exp = attrs.find((a) => /^expires=/i.test(a))?.slice(8);
      const maxAge = attrs.find((a) => /^max-age=/i.test(a))?.slice(8);
      const gone =
        value === '' || maxAge === '0' || (exp !== undefined && Date.parse(exp) < Date.now());
      if (gone) this.#c.delete(name);
      else this.set(name, value, dom);
    }
  }

  /** Names only — never values — for the diagnosis when auth fails. */
  names(): string[] {
    return [...this.#c.keys()].sort();
  }
}

const UA = 'Mozilla/5.0 (compatible; neo-lj-archive audit)';

/**
 * GET (or POST a form, for the first hop only), following redirects by hand so
 * every hop's cookies land in the jar. A redirect after a POST is a GET, as a
 * browser does it.
 */
async function getVia(
  jar: Jar,
  start: string,
  form?: URLSearchParams,
): Promise<{ html: string; hops: string[] }> {
  let url = new URL(start);
  let body = form;
  const hops: string[] = [];
  for (let n = 0; n < 10; n++) {
    const res = await fetch(url, {
      method: body ? 'POST' : 'GET',
      headers: {
        Cookie: jar.header(url),
        'User-Agent': UA,
        ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', Referer: url.href } : {}),
      },
      ...(body ? { body: body.toString() } : {}),
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
    });
    body = undefined;
    if (res.status === 403)
      throw new Banned(`HTTP 403 from ${url.href} — LiveJournal says stop. Wait before retrying.`);
    jar.take(res, url);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc !== null) {
      url = new URL(loc, url);
      hops.push(`${res.status} -> ${url.origin}${url.pathname}`);
      continue;
    }
    return { html: await res.text(), hops };
  }
  throw new Error(`redirect loop from ${start}: ${hops.slice(0, 6).join(' | ')}`);
}

/** One page, retried on a network blip. A 403 is a ban: stop, never retry (§9). */
async function getPage(jar: Jar, url: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return (await getVia(jar, url)).html;
    } catch (err) {
      if (err instanceof Banned) throw err;
      if (attempt === 3) {
        console.log(`  ${url} SKIPPED — ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
      await new Promise((res) => setTimeout(res, 3000 * attempt));
    }
  }
  return null;
}

const pause = (): Promise<void> => new Promise((res) => setTimeout(res, PACE_MS));

/**
 * Log in through LJ's own login form, over HTTP — what a browser does, minus the
 * browser. The form takes the password itself (no challenge-response) plus a
 * CSRF token, lj_form_auth, which is why a bare POST used to get the form handed
 * back: it has to come from this page, with this page's cookies.
 *
 * Exactly ONE attempt. LJ throttles repeated web logins, and retrying a rejected
 * one is how the account's web login got locked out for a while in July.
 */
async function webLogin(jar: Jar, user: string, password: Secret): Promise<void> {
  const LOGIN = 'https://www.livejournal.com/login.bml';
  const page = await getVia(jar, LOGIN);
  await pause();
  const doc = parse(page.html) as unknown as PNode;
  const form = first(
    doc,
    (d) =>
      d.nodeName === 'form' &&
      (attrOf(d, 'action') ?? '').endsWith('//www.livejournal.com/login.bml'),
  );
  if (form === undefined) throw new Error('LJ login form not found — the page has changed');
  const fields = new URLSearchParams();
  for (const el of all(form, (d) => d.nodeName === 'input' && attrOf(d, 'name') !== undefined)) {
    const name = attrOf(el, 'name')!;
    const type = (attrOf(el, 'type') ?? 'text').toLowerCase();
    // Hidden fields (lj_form_auth, ref, returnto) go back as LJ sent them.
    if (type === 'hidden' || attrOf(el, 'type') === undefined)
      fields.set(name, attrOf(el, 'value') ?? '');
  }
  fields.set('user', user);
  fields.set('password', password.reveal());
  const submit = first(form, (d) => attrOf(d, 'name') === 'action:login');
  fields.set('action:login', (submit && attrOf(submit, 'value')) ?? 'Log in');
  if (!fields.get('lj_form_auth'))
    throw new Error('no lj_form_auth on the login form — not posting');

  const res = await getVia(jar, LOGIN, fields);
  await pause();
  if (!jar.names().includes('ljloggedin')) {
    throw new Error(
      `LiveJournal did not accept the login (holding ${jar.names().join(', ')}; ` +
        `${res.hops.join(' | ') || 'no redirect'}). Not retrying — repeated web logins get throttled.`,
    );
  }
}

async function main(): Promise<void> {
  const state = loadState();
  const recheck = process.argv.includes('--recheck');
  // --recheck re-runs only the entries that DIVERGED, to confirm a fix. The
  // default run skips everything already audited and spends the chunk on new
  // ground, which is the entire point of chunking.
  const havePic = new Set(
    (db.prepare('SELECT ditemid FROM entry_userpics').all() as { ditemid: number }[]).map((r) =>
      String(r.ditemid),
    ),
  );

  // An entry is only RETIRED when every job that visits it is done: its text
  // checked, its line structure checked, and its userpic captured. Tracking just
  // "audited" is how the entry-pic selector recorded nothing for 85 entries and
  // they were never revisited, and how a brDiff-less verdict would masquerade as
  // a verified one — the oracle grew an eye and every old verdict predates it.
  const retired = (k: string): boolean =>
    havePic.has(k) && state[k]?.brDiff !== undefined && state[k]?.gap !== -1;

  const seen = recheck
    ? new Set(
        Object.entries(state)
          .filter(([k, v]) => v.gap === 0 && (v.brDiff ?? 0) === 0 && retired(k))
          .map(([k]) => k),
      )
    : new Set(Object.keys(state).filter(retired));
  const rows = sample(seen);
  if (rows.length === 0) {
    console.log(`nothing new to audit — ${Object.keys(state).length} entries already done.`);
    return;
  }
  const done = Object.keys(state).length;
  console.log(
    `${done} entries audited so far. This chunk: ${rows.length} ${recheck ? 'RE-CHECKS' : 'NEW'}, ` +
      `${PACE_MS}ms apart\n`,
  );

  // Log in once through LJ's own form; the jar then holds what a browser would.
  // The password comes from the no-echo prompt (or LJ_PASSWORD, deleted on read)
  // and is used for that one POST, nothing else, and never stored.
  const fromEnv = process.env['LJ_PASSWORD'];
  delete process.env['LJ_PASSWORD'];
  const password = new Secret(fromEnv ?? (await readHidden('LiveJournal password (not echoed): ')));
  const jar = new Jar();
  await webLogin(jar, USER, password);
  console.log(`logged in: holding ${jar.names().join(', ')}`);
  const pageUrl = (ditemid: number): string => `https://${USER}.livejournal.com/${ditemid}.html`;

  // CALIBRATE before trusting anything (see top). Controls are entries the
  // browser audit verified end to end: parity on text and breaks, and the
  // userpics and embeds it harvested. Every entry is private, so a control also
  // proves the API session really opens private pages — an anonymous page has no
  // div.entry_text and fails here, before any verdict is recorded.
  const controls = (
    db
      .prepare(
        `SELECT e.ditemid, e.itemid, e.body, u.picid,
           (SELECT COUNT(*) FROM entry_embeds x WHERE x.ditemid = e.ditemid) AS nEmbeds,
           (SELECT COUNT(*) FROM comment_userpics cu JOIN comments c ON c.id = cu.comment_id
             WHERE c.jitemid = e.itemid) AS nCommentPics
         FROM entries e JOIN entry_userpics u ON u.ditemid = e.ditemid`,
      )
      .all() as {
      ditemid: number;
      itemid: number;
      body: string;
      picid: number;
      nEmbeds: number;
      nCommentPics: number;
    }[]
  )
    .filter((c) => state[String(c.ditemid)]?.gap === 0 && state[String(c.ditemid)]?.brDiff === 0)
    // The richest first: embeds and comment pics are where a parser would differ.
    .sort(
      (a, b) => b.nEmbeds - a.nEmbeds || b.nCommentPics - a.nCommentPics || a.ditemid - b.ditemid,
    )
    .slice(0, 5);
  console.log(`calibrating against ${controls.length} entries the browser audit verified…`);
  const offControl: string[] = [];
  for (const c of controls) {
    // Errors propagate: a 403 must stop the run, and a failure must say what it was.
    const got = await getVia(jar, pageUrl(c.ditemid));
    await pause();
    const html = got.html;
    if (offControl.length === 0 && !html.includes('entry_text')) {
      // The first failure says why: where LJ sent us, and what we were holding.
      console.log(`  redirects: ${got.hops.join(' | ') || 'none'}`);
      console.log(`  holding: ${jar.names().join(', ')}`);
    }
    const pg = readPage(html, pageUrl(c.ditemid));
    const ours = renderBody(c.body, {
      localFor: () => 'blobs/x/y.jpg',
      deadReason: () => 'gone',
      username: USER,
      entryHref: () => undefined,
      root: '../',
    });
    const why: string[] = [];
    if (pg.liveBody === null) why.push('no div.entry_text (not logged in?)');
    else {
      const gap = missingRun(stream(pg.liveBody), stream(ours));
      if (gap !== 0) why.push(`text gap ${gap}`);
      const brDiff = pg.liveBreaks - (ours.match(/<br>/g) ?? []).length;
      if (brDiff !== 0) why.push(`breaks ${brDiff}`);
    }
    if (pg.entryPic?.picid !== c.picid) why.push(`entry pic ${pg.entryPic?.picid} != ${c.picid}`);
    const wantEmbeds = (
      db.prepare('SELECT url FROM entry_embeds WHERE ditemid = ? ORDER BY idx').all(c.ditemid) as {
        url: string;
      }[]
    ).map((r) => r.url);
    // Compared by identity, not string: every embed URL carries an auth_token LJ
    // mints per session, and the parameter order varies between visits, so the
    // same video never has the same URL twice. The calibration's first run with
    // a working login failed on exactly that — 4 embeds vs 4, all "different".
    const embedKey = (u: string): string => {
      const x = new URL(u);
      x.searchParams.delete('auth_token');
      x.searchParams.sort();
      return `${x.host}${x.pathname}?${x.searchParams.toString()}`;
    };
    if (JSON.stringify(pg.frames.map(embedKey)) !== JSON.stringify(wantEmbeds.map(embedKey)))
      why.push(`embeds ${pg.frames.length} vs ${wantEmbeds.length}`);
    const wantPics = new Set(
      (
        db
          .prepare(
            'SELECT cu.comment_id AS id, cu.picid FROM comment_userpics cu JOIN comments c ON c.id = cu.comment_id WHERE c.jitemid = ?',
          )
          .all(c.itemid) as { id: number; picid: number }[]
      ).map((r) => `${r.id}:${r.picid}`),
    );
    const gotPics = new Set(pg.commentPics.map((p) => `${p.commentId}:${p.picid}`));
    if ([...wantPics].some((k) => !gotPics.has(k)))
      why.push(`comment pics ${gotPics.size} vs ${wantPics.size}`);
    console.log(
      `  control ${c.ditemid}: ${why.length === 0 ? 'matches' : 'OFF — ' + why.join(', ')}`,
    );
    if (why.length > 0) offControl.push(String(c.ditemid));
  }
  if (controls.length === 0 || offControl.length > 0) {
    throw new Error(
      controls.length === 0
        ? 'no verified entries to calibrate against'
        : `the HTTP audit does not reproduce the browser audit on ${offControl.join(', ')} — nothing recorded`,
    );
  }
  console.log('calibrated: HTTP + parse5 reproduces the browser audit\n');

  const report: Record<string, unknown>[] = [];
  let renderLoss = 0;
  let dbLoss = 0;
  let structLoss = 0;
  let notLocated = 0;
  let picsFound = 0;
  let embedUrls = 0;

  for (const [i, r] of rows.entries()) {
    const ctxRender = {
      localFor: () => 'blobs/x/y.jpg',
      deadReason: () => 'gone',
      username: USER,
      entryHref: () => undefined,
      root: '../',
    };

    // Q2, offline: does the renderer keep what the DB holds?
    const stored = words(r.body);
    const renderedHtml = renderBody(r.body, ctxRender);
    const renderedWords = new Set(words(renderedHtml));
    const droppedByRenderer = stored.filter((w) => !renderedWords.has(w));

    // Retry, then skip. A single transient network error used to end the whole
    // run: ERR_NETWORK_CHANGED on one page threw out of the loop and killed a
    // 400-entry chunk with 1,355 done and 192 to go. Over ~40 minutes of paced
    // requests a blip is not an edge case, it is a certainty — wifi moves, a VPN
    // reconnects, a laptop lid dips. The entry that failed simply comes back on
    // the next chunk, because an entry is only retired once it has a verdict.
    const html = await getPage(jar, pageUrl(r.ditemid));
    // No verdict, no state row: it stays unaudited and a later chunk picks it up.
    if (html === null) {
      await pause();
      continue;
    }
    const pg = readPage(html, pageUrl(r.ditemid));

    // Is archive.db complete? Ask div.entry_text — LJ's own name for the body,
    // read off the markup rather than inferred. Every heuristic that guessed at
    // this container grabbed the comments and chrome too, and reported loss on
    // entries that were fine.
    // Structure, not just characters. Counted on the same cloned subtree the text
    // comes from, so the tags footer is excluded from both.
    const liveBreaks = pg.liveBreaks;
    const ourBreaks = (renderedHtml.match(/<br>/g) ?? []).length;
    const brDiff = liveBreaks < 0 ? 0 : liveBreaks - ourBreaks;

    // div.entry_text also contains LJ's "Tags:" footer, which our archive renders
    // in the entry HEADER instead — excluded in readPage, or every tagged entry
    // would score as data loss with its tags right there on our page.
    const liveBody = pg.liveBody;
    // Compare against our RENDERED text, not the stored source: LJ resolves
    // <lj user="x"> to the word "x" and so do we, while the raw source has only
    // a tag. Source-vs-rendered would score every mention and cut as loss.
    const gap = liveBody === null ? -1 : missingRun(stream(liveBody), stream(renderedHtml));
    if (liveBody === null) notLocated++;
    else if (gap > 0) dbLoss++;
    if (brDiff !== 0) structLoss++;
    // Record every verdict, so the next chunk starts where this one stopped.
    state[String(r.ditemid)] = { shape: r.shape, gap: liveBody === null ? -1 : gap, brDiff };
    // Per entry, not per chunk. A run that is killed at 75/228 must keep its 75
    // verdicts — the userpic rows already survive that way, and having the two
    // halves of one traversal with different durability is a trap.
    saveState(state);

    // The harvest the API won't give us, with its mapping intact.
    //
    // Scoped, NOT every userpic img on the page. #sidebar carries a
    // .defaultuserpic that belongs to the journal, not the entry — harvesting it
    // would stamp the same pic on all 1,547 entries and look entirely plausible.
    const harvest = { entry: pg.entryPic, comments: pg.commentPics };
    const pics = [
      ...(harvest.entry ? [harvest.entry.url] : []),
      ...harvest.comments.map((c) => c.url),
    ];

    // Persist. A pic reused across 400 comments is ONE row and, later, one blob.
    for (const u of [...(harvest.entry ? [harvest.entry] : []), ...harvest.comments]) {
      db.prepare(
        'INSERT INTO userpics (picid, userid, url) VALUES (?, ?, ?) ON CONFLICT (picid) DO NOTHING',
      ).run(u.picid, u.userid, u.url);
    }
    if (harvest.entry) {
      db.prepare(
        'INSERT INTO entry_userpics (ditemid, picid) VALUES (?, ?) ON CONFLICT (ditemid) DO UPDATE SET picid=excluded.picid',
      ).run(r.ditemid, harvest.entry.picid);
    }
    for (const c of harvest.comments) {
      // Only comments we actually hold — a dtalkid we never fetched would be a
      // dangling reference, and the FK is there to say so.
      const known = db.prepare('SELECT 1 AS x FROM comments WHERE id=?').get(c.commentId);
      if (known)
        db.prepare(
          'INSERT INTO comment_userpics (comment_id, picid) VALUES (?, ?) ON CONFLICT (comment_id) DO UPDATE SET picid=excluded.picid',
        ).run(c.commentId, c.picid);
    }
    // SCOPED to the entry body. Every LJ page carries a chrome iframe, which is
    // why the old unscoped count read "embeds:1" on entries that have none —
    // a number that looked like data and was furniture.
    const frames = pg.frames;

    // The URL behind <lj-embed id="42">, which the export never had.
    frames.forEach((url, idx) => {
      db.prepare(
        'INSERT INTO entry_embeds (ditemid, idx, url) VALUES (?, ?, ?) ON CONFLICT (ditemid, idx) DO UPDATE SET url=excluded.url',
      ).run(r.ditemid, idx, url);
    });

    picsFound += new Set(pics).size;
    embedUrls += frames.length;
    if (droppedByRenderer.length > 0) renderLoss++;

    report.push({
      ditemid: r.ditemid,
      shape: r.shape,
      renderer_dropped_words: droppedByRenderer.length,
      db_missing_run: gap,
      bodyLocated: liveBody !== null,
      userpics: [...new Set(pics)],
      embeds: frames,
    });

    const flag =
      droppedByRenderer.length > 0
        ? ' RENDERER-LOSS'
        : liveBody === null
          ? ' BODY-NOT-FOUND'
          : gap > 0
            ? ` DB-LOSS(${gap})`
            : brDiff !== 0
              ? ` BREAKS(${brDiff > 0 ? '+' : ''}${brDiff})`
              : ' PARITY';
    console.log(
      `${String(i + 1).padStart(3)}/${rows.length} ${r.ditemid} [${r.shape}] ` +
        `pics:${new Set(pics).size} embeds:${frames.length}${flag}`,
    );
    await pause();
  }

  saveState(state); // redundant now — state is saved per entry — but harmless

  mkdirSync('./archive/audit', { recursive: true });
  writeFileSync('./archive/audit/vs-live.json', JSON.stringify(report, null, 2));

  const all = Object.values(state);
  // Parity means BOTH: the same words AND the same shape.
  const parity = all.filter((v) => v.gap === 0 && (v.brDiff ?? 0) === 0).length;
  console.log(`\n--- this chunk: ${rows.length} entries ---`);
  console.log(`renderer dropped content:  ${renderLoss}`);
  console.log(
    `AT FULL PARITY WITH LJ:    ${rows.length - notLocated - dbLoss}/${rows.length - notLocated} compared`,
  );
  console.log(`diverging from LJ:         ${dbLoss}`);
  console.log(`line structure off:        ${structLoss}`);
  console.log(`body not found on page:    ${notLocated}`);
  console.log(`userpic urls harvested:    ${picsFound}`);
  console.log(`embed urls harvested:      ${embedUrls}`);
  console.log(`\n--- cumulative across all chunks ---`);
  console.log(`  audited:        ${all.length} of 1547`);
  console.log(`  at parity:      ${parity}`);
  console.log(`  diverging:      ${all.length - parity}`);
  const open = Object.entries(state).filter(([, v]) => v.gap > 0 || (v.brDiff ?? 0) !== 0);
  if (open.length) {
    console.log('\n  still diverging (re-check with --recheck after a fix):');
    for (const [id, v] of open.sort((a, b) => b[1].gap - a[1].gap))
      console.log(`    ${id} [${v.shape}] ${v.gap} chars`);
  }
  console.log('\nstate: archive/audit/state.json — next run picks up new entries');
}

await main();
