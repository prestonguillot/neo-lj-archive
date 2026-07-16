/**
 * Capture raw LiveJournal responses to disk, once, so tests have an oracle
 * nobody here authored (DESIGN.md §10).
 *
 * This script deliberately does NOT use src/core. It speaks raw HTTP and saves
 * the response bytes verbatim. If it imported our parser, the fixtures would be
 * shaped by the code they're meant to test, and the oracle would be circular.
 * The only thing this shares with the real fetcher is the wire protocol — which
 * LiveJournal defines, not us.
 *
 * Output lands in ./fixtures-raw/ which is GITIGNORED. It contains real private
 * entries and real usernames, and this repo is public. Run `scrub-fixtures.ts`
 * to produce the committed fixtures.
 *
 * Usage (credentials never via flag — flags land in shell history and `ps`):
 *   LJ_USER=... LJ_PASSWORD=... npx tsx scripts/capture-fixtures.ts
 *   npx tsx scripts/capture-fixtures.ts        # prompts, no echo
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const XMLRPC_URL = 'https://www.livejournal.com/interface/xmlrpc';
const COMMENTS_URL = 'https://www.livejournal.com/export_comments.bml';
const CLIENT_VERSION = 'Node-neo-lj-archive/0.1';
const OUT_DIR = new URL('../fixtures-raw/', import.meta.url);

/** Deliberately slow. A 403 from LJ is a ban, not a retry (DESIGN.md §5.1). */
const DELAY_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Minimal XML-RPC serializer. Only the shapes LJ's methods actually take. */
function toXmlRpcValue(v: string | number): string {
  return typeof v === 'number'
    ? `<value><int>${v}</int></value>`
    : `<value><string>${xmlEscape(v)}</string></value>`;
}

function buildRequest(method: string, params: Record<string, string | number>): string {
  const members = Object.entries(params)
    .map(([k, v]) => `<member><name>${k}</name>${toXmlRpcValue(v)}</member>`)
    .join('');
  const body = Object.keys(params).length
    ? `<params><param><value><struct>${members}</struct></value></param></params>`
    : '<params/>';
  return `<?xml version="1.0"?><methodCall><methodName>${method}</methodName>${body}</methodCall>`;
}

async function xmlrpc(method: string, params: Record<string, string | number> = {}) {
  const res = await fetch(XMLRPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', 'User-Agent': CLIENT_VERSION },
    body: buildRequest(method, params),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
  if (text.includes('<fault>')) {
    throw new Error(`${method} faulted: ${/<string>([^<]*)<\/string>/.exec(text)?.[1] ?? text}`);
  }
  return text;
}

/**
 * Just enough XML scraping to drive the capture. This is NOT the parser — the
 * real one lives in src/core and gets tested against what we save here.
 */
function scrape(xml: string, name: string): string | undefined {
  const re = new RegExp(`<name>${name}</name>\\s*<value>\\s*(?:<string>)?([^<]*)`, 'i');
  return re.exec(xml)?.[1];
}

async function save(name: string, body: string): Promise<void> {
  await writeFile(new URL(name, OUT_DIR), body, 'utf8');
  console.log(`  saved  ${name}  (${body.length.toLocaleString()} bytes)`);
}

async function prompt(question: string, hide = false): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });
  if (!hide) {
    const a = await rl.question(question);
    rl.close();
    return a.trim();
  }
  // No-echo: intercept the output stream while the answer is typed.
  const iface = rl as unknown as { _writeToOutput: (s: string) => void };
  const original = iface._writeToOutput.bind(iface);
  iface._writeToOutput = (s: string) => original(s.includes(question) ? s : '');
  const answer = await rl.question(question);
  rl.close();
  stdout.write('\n');
  return answer;
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  const user = process.env['LJ_USER'] ?? (await prompt('LJ username: '));
  const password = process.env['LJ_PASSWORD'] ?? (await prompt('LJ password: ', true));
  delete process.env['LJ_PASSWORD'];
  const pwMd5 = md5(password);

  /** Challenges are single-use and expire in ~60s — fresh one per request. */
  async function auth(): Promise<Record<string, string | number>> {
    const chalXml = await xmlrpc('LJ.XMLRPC.getchallenge');
    const challenge = scrape(chalXml, 'challenge');
    if (!challenge) throw new Error('no challenge in response');
    return {
      username: user,
      auth_method: 'challenge',
      auth_challenge: challenge,
      auth_response: md5(challenge + pwMd5),
      ver: 1,
      clientversion: CLIENT_VERSION,
    };
  }

  console.log('\n[1/5] getchallenge');
  await save('getchallenge.xml', await xmlrpc('LJ.XMLRPC.getchallenge'));
  await sleep(DELAY_MS);

  console.log('[2/5] login');
  await save('login.xml', await xmlrpc('LJ.XMLRPC.login', await auth()));
  await sleep(DELAY_MS);

  // Two slices, because one isn't enough of an oracle.
  //
  // The recent slice (2010) is all `private`/`usemask` and carries no
  // current_mood / current_music / current_location — Preston had stopped
  // writing them by then. That's precisely the metadata §7.1 calls the texture
  // people miss, so a fixture without it can't test extracting it. It also
  // contains no `public` entries at all.
  //
  // The 2004 slice is where mood/music/location and public entries live. Both
  // are needed or the parser is tested against half the format.
  console.log('[3/5] getevents (recent + 2004 slices)');
  const recent = await xmlrpc('LJ.XMLRPC.getevents', {
    ...(await auth()),
    selecttype: 'lastn',
    howmany: 20,
    lineendings: 'unix',
  });
  await save('getevents-lastn.xml', recent);
  await sleep(DELAY_MS);

  const old = await xmlrpc('LJ.XMLRPC.getevents', {
    ...(await auth()),
    selecttype: 'lastn',
    howmany: 20,
    beforedate: '2004-06-01 00:00:00',
    lineendings: 'unix',
  });
  await save('getevents-2004.xml', old);
  await sleep(DELAY_MS);

  console.log('[4/5] sessiongenerate');
  const sessionXml = await xmlrpc('LJ.XMLRPC.sessiongenerate', {
    ...(await auth()),
    expiration: 'short',
  });
  const ljsession = scrape(sessionXml, 'ljsession');
  if (!ljsession) throw new Error('no ljsession in response');
  console.log('  ok     session minted (not saved — it is a credential)');
  await sleep(DELAY_MS);

  console.log('[5/5] export_comments.bml');
  for (const get of ['comment_meta', 'comment_body'] as const) {
    const res = await fetch(`${COMMENTS_URL}?get=${get}&startid=0`, {
      headers: { Cookie: `ljsession=${ljsession}`, 'User-Agent': CLIENT_VERSION },
    });
    if (!res.ok) throw new Error(`${get}: HTTP ${res.status}`);
    await save(`export-${get.replace('_', '-')}.xml`, await res.text());
    await sleep(DELAY_MS);
  }

  console.log('\nRaw captures in ./fixtures-raw/ (gitignored — real private content).');
  console.log('Next: npx tsx scripts/scrub-fixtures.ts\n');
}

main().catch((err: unknown) => {
  console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
