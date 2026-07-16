/**
 * Turn raw LJ captures into committable test fixtures.
 *
 * ./fixtures-raw/  real private entries, real usernames   — GITIGNORED
 *        ↓ scrub
 * ./tests/fixtures/  LJ's structure, redacted payload      — COMMITTED, PUBLIC
 *
 * What survives is exactly what the parser is tested against and nothing else:
 * element nesting, attribute quoting, which attributes are present or omitted,
 * ids, dates, security levels, comment states, base64 encoding. LiveJournal
 * authored all of that in 2005 — we're not inventing an oracle, we're redacting
 * the prose inside one (DESIGN.md §10).
 *
 * What does NOT survive: entry text, subjects, comment text, usernames, moods,
 * music, locations, tags, URLs. Anything a human wrote.
 *
 * This fails CLOSED. A verification pass re-reads the output and aborts if any
 * scrubbed value leaks through. Scrub bugs must not become publications.
 *
 *   npx tsx scripts/scrub-fixtures.ts
 */

import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { redactHtml } from './scrub-html.js';

const RAW = new URL('../fixtures-raw/', import.meta.url);
const OUT = new URL('../tests/fixtures/', import.meta.url);

const Q = String.fromCharCode(39);

const unescapeXml = (s: string): string =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Redact a body while KEEPING its HTML structure (scrub-html.ts).
 *
 * Bodies arrive as XML-escaped HTML, so: unescape -> redact -> re-escape. The
 * fixture keeps the tag soup, the <lj user> tags, the unclosed <lj-cut>s and the
 * image hosts; it loses every word a human wrote.
 */
function redactBodyHtml(escaped: string): string {
  const { html, removed } = redactHtml(unescapeXml(escaped));
  remember(...removed);
  return escapeXml(html);
}

/**
 * Stable pseudonym per real value, so cross-references stay consistent.
 *
 * A COUNTER, not a hash. A hash pseudonym is confirmable — anyone with this file
 * can hash a guess and compare — and LJ usernames are an enumerable dictionary,
 * so all 194 commenters would fall out immediately. Salting wouldn't help: the
 * salt would be committed right here, and a published salt is not a secret.
 * A counter has no function from the real name to the fake one, so there is
 * nothing to compute and nothing to confirm.
 */
const pseudonyms = new Map<string, string>();
function pseudonym(real: string, prefix: string): string {
  const existing = pseudonyms.get(real.toLowerCase());
  if (existing) return existing;
  const fake = `${prefix}${pseudonyms.size + 1}`;
  pseudonyms.set(real.toLowerCase(), fake);
  return fake;
}

/** Everything we redacted, so the verifier can prove none of it survived. */
const redacted = new Set<string>();
function remember(...values: (string | undefined)[]): void {
  for (const v of values) if (v && v.trim().length > 2) redacted.add(v);
}

/**
 * Replace an element's contents with something derived from them.
 *
 * (There used to be a sibling that substituted a fixed placeholder — "Redacted
 * comment body 3." That's what made the M1 fixtures useless as an oracle for
 * M2: they contained no tag soup, no <lj user>, no image hosts. Bodies now go
 * through structure-preserving redaction instead, so the fixed-string version
 * is gone.)
 */
function transformElement(xml: string, tag: string, fn: (inner: string) => string): string {
  return xml.replace(
    new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`, 'g'),
    (_m, open: string, inner: string, close: string) => `${open}${fn(inner)}${close}`,
  );
}

/** Replace an XML-RPC <member><name>KEY</name><value>…</value> payload. */
function redactMember(xml: string, key: string, replacement: string): string {
  const re = new RegExp(
    `(<name>${key}</name>\\s*<value>\\s*)(?:<string>([\\s\\S]*?)</string>|<base64>([\\s\\S]*?)</base64>)(\\s*</value>)`,
    'g',
  );
  return xml.replace(re, (_m, head, str, b64, tail) => {
    remember(str, b64);
    const body =
      b64 !== undefined
        ? `<base64>${Buffer.from(replacement).toString('base64')}</base64>`
        : `<string>${replacement}</string>`;
    return `${head}${body}${tail}`;
  });
}

/** Like redactMember, but the replacement is derived from the payload. */
function transformMember(xml: string, key: string, fn: (inner: string) => string): string {
  const re = new RegExp(
    `(<name>${key}</name>\\s*<value>\\s*)(?:<string>([\\s\\S]*?)</string>|<base64>([\\s\\S]*?)</base64>)(\\s*</value>)`,
    'g',
  );
  return xml.replace(re, (_m, head: string, str: string, b64: string, tail: string) => {
    const isB64 = b64 !== undefined;
    const raw = isB64 ? Buffer.from(b64, 'base64').toString('utf8') : str;
    const out = fn(isB64 ? escapeXml(raw) : raw);
    const body = isB64
      ? `<base64>${Buffer.from(unescapeXml(out)).toString('base64')}</base64>`
      : `<string>${out}</string>`;
    return `${head}${body}${tail}`;
  });
}

// --- per-file scrubbers ----------------------------------------------------

function scrubComments(xml: string): string {
  // Usernames → stable pseudonyms. These are real people.
  xml = xml.replace(new RegExp(`user=${Q}([^${Q}]*)${Q}`, 'g'), (_m, u: string) => {
    remember(u);
    return `user=${Q}${pseudonym(u, 'commenter')}${Q}`;
  });
  xml = transformElement(xml, 'body', redactBodyHtml);
  xml = transformElement(xml, 'subject', redactBodyHtml);
  return xml;
}

function scrubEvents(xml: string): string {
  xml = transformMember(xml, 'event', redactBodyHtml);
  xml = redactMember(xml, 'subject', 'Redacted subject');
  xml = redactMember(xml, 'url', 'https://example.invalid/0.html');
  for (const k of ['current_mood', 'current_music', 'current_location', 'taglist']) {
    xml = redactMember(xml, k, `redacted ${k}`);
  }
  return xml;
}

function scrubLogin(xml: string): string {
  for (const k of ['fullname', 'identity_url', 'identity_value', 'identity_display', 'name']) {
    xml = redactMember(xml, k, 'redacted');
  }
  xml = redactMember(xml, 'username', 'testuser');
  return xml;
}

function scrubChallenge(xml: string): string {
  // The challenge is a credential input. Not secret once expired, but no reason to ship it.
  return redactMember(xml, 'challenge', 'c0:1234567890:123:60:redacted:0000000000000000');
}

const SCRUBBERS: Record<string, (xml: string) => string> = {
  'export-comment-meta.xml': scrubComments,
  'export-comment-body.xml': scrubComments,
  'getevents-lastn.xml': scrubEvents,
  'getevents-2004.xml': scrubEvents,
  'login.xml': scrubLogin,
  'getchallenge.xml': scrubChallenge,
};

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const files = (await readdir(RAW)).filter((f) => f.endsWith('.xml'));
  if (!files.length)
    throw new Error('no captures in ./fixtures-raw/ — run capture-fixtures.ts first');

  // Scrub in MEMORY. Nothing reaches tests/fixtures/ until every check passes.
  //
  // This used to write each file and verify afterwards, then print "Nothing
  // published" on failure — while the files sat on disk, already stageable. The
  // fail-closed guarantee was a lie, and the one thing standing between a
  // private journal and a public repo is not a place for a comforting message
  // that isn't true.
  const scrubbed = new Map<string, string>();

  for (const f of files) {
    const scrub = SCRUBBERS[f];
    if (!scrub) {
      // Fail closed: an unrecognised capture is not silently published.
      throw new Error(
        `no scrubber for ${f} — add one or delete the capture. Refusing to publish it blind.`,
      );
    }
    const raw = await readFile(new URL(f, RAW), 'utf8');
    const clean = scrub(raw);
    scrubbed.set(f, clean);
    console.log(
      `  scrubbed  ${f}  ${raw.length.toLocaleString()} → ${clean.length.toLocaleString()} bytes`,
    );
  }

  const written = [...scrubbed.keys()];

  // --- verification: re-read what we wrote and prove nothing leaked --------
  //
  // Search the DATA only — text nodes and attribute values — never the markup.
  // A naive search of the whole document collides with LJ's own vocabulary:
  // a 3-char friendgroup name called "_di" "leaks" into <identity_display>.
  // That's a false positive, and a verifier that cries wolf gets muted, which
  // is how a real leak ships.
  console.log('\n  verifying…');

  // Sentinel that cannot occur in XML text. Named, because a bare NUL literal is
  // invisible in an editor and unmatchable by tooling.
  const SEP = '\u0000';

  const dataOf = (xml: string): string[] => [
    ...xml
      // XML-RPC carries field names in TEXT, not tags: <name>identity_display</name>.
      // That vocabulary is structure, so strip it before looking for data — otherwise a
      // 3-char friendgroup name ("_di") collides with <name>identity_display</name> and
      // reports a leak that is not one. A verifier that cries wolf gets muted, and a
      // muted verifier is how a real leak ships.
      .replace(/<name>[^<]*<\/name>/g, SEP)
      .replace(/<[^>]*>/g, SEP)
      .split(SEP), // one token per text node
    ...[...xml.matchAll(/=["']([^"']*)["']/g)].map((m) => m[1] ?? ''), // attribute values
  ];

  let leaks = 0;

  // --- Pass 1: blacklist. Did anything we redacted survive? ---------------
  for (const f of written) {
    const data = dataOf(scrubbed.get(f) ?? '');
    for (const secret of redacted) {
      if (data.some((d) => d.includes(secret))) {
        console.error(`  LEAK in ${f}: ${JSON.stringify(secret.slice(0, 60))}`);
        if (++leaks > 5) break;
      }
    }
  }

  // --- Pass 2: whitelist. Is every payload element ACTUALLY a placeholder? -
  //
  // Pass 1 alone has a blind spot sitting exactly on top of the regex's failure
  // mode. redactElement remembers only what it *matched*. If a lazy match ever
  // terminated early — say a body containing a literal `</body>` — the
  // remainder is never matched, so never remembered, so never checked. A
  // blacklist can only find leaks it already knows about.
  //
  // This pass inverts it: every WORD a human could have written must be gone.
  // Anything unredacted fails, whatever the cause.
  //
  // Bodies now keep their HTML structure (tag soup, <lj user>, <lj-cut>, image
  // hosts) so M2's extractor has a real oracle — so the check can't be "equals a
  // placeholder" any more. It's "every text node is the filler word": structure
  // may survive, prose may not.
  //
  // (Today LJ escapes content — `&lt;`, not `<` — so a lazy match can't
  // terminate early on a literal `</body>`. This pass means we don't have to
  // keep being right about that.)
  // "<3" and "<333" are hearts, not markup — 2000s LJ is full of them. After
  // tag-stripping they leave tokens like "redacted<3", which are filler with a
  // heart stuck to them, not surviving prose.
  //
  // Strip filler and any remaining punctuation; if nothing alphabetic is left,
  // no prose survived. This is why: "<3" and "<333" are hearts, not markup —
  // 2000s LJ is full of them — and after tag-stripping they leave tokens like
  // "<redacted<3", which is filler with hearts stuck to it, not surviving text.
  const isFiller = (w: string): boolean => !/[a-z]/i.test(w.replace(/redacted/gi, ''));

  for (const f of written) {
    const out = scrubbed.get(f) ?? '';
    for (const tag of ['body', 'subject'] as const) {
      for (const m of out.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))) {
        // Unescape FIRST, then strip markup. Bodies are escaped HTML, so a
        // regex matching &lt;...&gt; cannot cross the & in &gt; and leaves
        // "gt;" fragments that look like surviving prose.
        const prose = unescapeXml(m[1] ?? '')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&\w+;/g, ' ');
        const survivor = prose.split(/\s+/).find((w) => w && !isFiller(w));
        if (survivor !== undefined) {
          console.error(`  UNREDACTED <${tag}> in ${f}: ${JSON.stringify(survivor.slice(0, 40))}`);
          if (++leaks > 5) break;
        }
      }
    }
  }
  if (leaks) throw new Error(`${leaks} redacted value(s) survived scrubbing. Nothing published.`);

  // Verified. NOW publish.
  for (const [f, clean] of scrubbed) await writeFile(new URL(f, OUT), clean, 'utf8');

  console.log(`  ok — ${redacted.size.toLocaleString()} distinct values redacted, 0 leaked`);
  console.log(`\n  ${written.length} fixtures in tests/fixtures/ — safe to commit.\n`);
}

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
