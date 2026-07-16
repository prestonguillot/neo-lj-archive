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
import { createHash } from 'node:crypto';

const RAW = new URL('../fixtures-raw/', import.meta.url);
const OUT = new URL('../tests/fixtures/', import.meta.url);

const Q = String.fromCharCode(39);

/** Stable pseudonym per real value, so cross-references stay consistent. */
const pseudonyms = new Map<string, string>();
function pseudonym(real: string, prefix: string): string {
  const existing = pseudonyms.get(real);
  if (existing) return existing;
  const n = createHash('sha256').update(real).digest('hex').slice(0, 6);
  const fake = `${prefix}_${n}`;
  pseudonyms.set(real, fake);
  return fake;
}

/** Everything we redacted, so the verifier can prove none of it survived. */
const redacted = new Set<string>();
function remember(...values: (string | undefined)[]): void {
  for (const v of values) if (v && v.trim().length > 2) redacted.add(v);
}

/** Replace a text node's contents, keeping the element and its attributes. */
function redactElement(xml: string, tag: string, replacement: (i: number) => string): string {
  let i = 0;
  return xml.replace(
    new RegExp(`(<${tag}(?:\\s[^>]*)?>)([\\s\\S]*?)(</${tag}>)`, 'g'),
    (_m, open, inner, close) => {
      remember(inner);
      return `${open}${replacement(i++)}${close}`;
    },
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

// --- per-file scrubbers ----------------------------------------------------

function scrubComments(xml: string): string {
  // Usernames → stable pseudonyms. These are real people.
  xml = xml.replace(new RegExp(`user=${Q}([^${Q}]*)${Q}`, 'g'), (_m, u: string) => {
    remember(u);
    return `user=${Q}${pseudonym(u, 'commenter')}${Q}`;
  });
  xml = redactElement(xml, 'body', (i) => `Redacted comment body ${i}.`);
  xml = redactElement(xml, 'subject', (i) => `Redacted subject ${i}`);
  return xml;
}

function scrubEvents(xml: string): string {
  xml = redactMember(xml, 'event', 'Redacted entry body. <i>Structure preserved.</i>');
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

  const written: string[] = [];

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
    await writeFile(new URL(f, OUT), clean, 'utf8');
    written.push(f);
    console.log(
      `  scrubbed  ${f}  ${raw.length.toLocaleString()} → ${clean.length.toLocaleString()} bytes`,
    );
  }

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
    const data = dataOf(await readFile(new URL(f, OUT), 'utf8'));
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
  // This pass inverts it: every payload element in the output must contain a
  // placeholder and nothing else. Anything unredacted fails, whatever the cause.
  //
  // (Today LJ escapes content — `&lt;`, not `<` — so the early-termination case
  // can't arise: `<body` and `</body>` each occur exactly 955 times against 955
  // body elements. This pass means we don't have to keep being right about that.)
  const PLACEHOLDER = /^(Redacted (comment body|subject) \d+\.?|Redacted subject)$/;
  for (const f of written) {
    const out = await readFile(new URL(f, OUT), 'utf8');
    for (const tag of ['body', 'subject'] as const) {
      for (const m of out.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'))) {
        const inner = (m[1] ?? '').trim();
        if (!PLACEHOLDER.test(inner)) {
          console.error(`  UNREDACTED <${tag}> in ${f}: ${JSON.stringify(inner.slice(0, 60))}`);
          if (++leaks > 5) break;
        }
      }
    }
  }
  if (leaks) throw new Error(`${leaks} redacted value(s) survived scrubbing. Nothing published.`);

  console.log(`  ok — ${redacted.size.toLocaleString()} distinct values redacted, 0 leaked`);
  console.log(`\n  ${written.length} fixtures in tests/fixtures/ — safe to commit.\n`);
}

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
