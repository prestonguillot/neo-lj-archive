import { XMLParser } from 'fast-xml-parser';
import { decodeResponse, type XmlRpcValue } from './xmlrpc.js';
import type {
  CommentBody,
  CommentMeta,
  CommentMetaPage,
  CommentState,
  Entry,
  LoginResult,
  Mood,
  Security,
  UserMap,
} from './types.js';

/**
 * Parsers for LJ's two very different response formats.
 *
 * getevents/login are XML-RPC. export_comments.bml is LJ's own plain XML with
 * single-quoted attributes. Both are parsed properly rather than pattern-matched
 * — the single-quoted attributes in particular are a trap that silently matches
 * nothing (DESIGN.md §5.1).
 */

const commentParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: false, // ids stay strings until we convert them
  parseTagValue: false,
  trimValues: false, // comment bodies are content; whitespace is theirs
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

const asRecord = (v: XmlRpcValue | undefined): Record<string, XmlRpcValue> =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : {};

const str = (v: XmlRpcValue | undefined): string | undefined => {
  if (v === undefined || v === null) return undefined;
  const s = String(v);
  return s === '' ? undefined : s;
};

const num = (v: XmlRpcValue | undefined): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

// --- getevents -------------------------------------------------------------

/**
 * LJ omits `security` entirely for public entries. Absent means public — it is
 * not missing data, and defaulting it to anything else silently relabels every
 * public entry.
 *
 * KNOWN GAP: this branch has no fixture coverage and cannot get any. Preston's
 * journal has zero public entries — verified across 2001, 2002, 2003, 2004,
 * 2006, 2008 and 2010 samples; every entry carries `private` or `usemask`. The
 * rule comes from LJ's documented behaviour, not from a capture we can replay.
 *
 * A hand-authored fixture would turn the mutation report green while proving
 * nothing (DESIGN.md §10 — an oracle you wrote yourself is a tautology). So the
 * gap is recorded rather than papered over. If this tool is ever pointed at a
 * journal with public entries, that is when the branch gets a real test.
 */
function parseSecurity(v: XmlRpcValue | undefined): Security {
  const s = str(v);
  if (s === 'private' || s === 'usemask') return s;
  return 'public';
}

export function parseEvents(xml: string): Entry[] {
  const res = asRecord(decodeResponse(xml));
  const events = Array.isArray(res['events']) ? res['events'] : [];

  return events.map((raw): Entry => {
    const e = asRecord(raw);
    const props = asRecord(e['props']);

    // Everything LJ sent that we don't model explicitly, kept rather than
    // dropped — this archive is supposed to be lossless.
    const known = new Set([
      'current_mood',
      'current_moodid',
      'current_music',
      'current_location',
      'taglist',
      'picture_keyword',
    ]);
    const extra: Record<string, string> = {};
    for (const [k, v] of Object.entries(props)) {
      if (!known.has(k) && v !== null && v !== '') extra[k] = String(v);
    }

    const taglist = str(props['taglist']);

    return {
      itemid: num(e['itemid']) ?? 0,
      anum: num(e['anum']) ?? 0,
      ditemid: num(e['ditemid']) ?? 0,
      eventtime: str(e['eventtime']) ?? '',
      logtime: str(e['logtime']),
      subject: str(e['subject']),
      // decodeResponse already base64-decoded this if LJ encoded it.
      body: str(e['event']) ?? '',
      security: parseSecurity(e['security']),
      allowmask: num(e['allowmask']),
      mood: str(props['current_mood']),
      moodid: num(props['current_moodid']),
      music: str(props['current_music']),
      location: str(props['current_location']),
      pictureKeyword: str(props['picture_keyword']),
      tags: taglist
        ? taglist
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : [],
      props: extra,
    };
  });
}

// --- login -----------------------------------------------------------------

export function parseLogin(xml: string): LoginResult {
  const res = asRecord(decodeResponse(xml));

  const moods = (Array.isArray(res['moods']) ? res['moods'] : []).map((raw): Mood => {
    const m = asRecord(raw);
    return {
      moodid: num(m['id']) ?? 0,
      name: str(m['name']) ?? '',
      parent: num(m['parent']) || undefined,
    };
  });

  return {
    username: str(res['username']) ?? '',
    fullname: str(res['fullname']),
    usejournals: (Array.isArray(res['usejournals']) ? res['usejournals'] : []).map(String),
    moods,
  };
}

// --- export_comments.bml ---------------------------------------------------

/** Absent state means active. LJ only emits the attribute when it isn't 'A'. */
function parseState(v: unknown): CommentState {
  const s = v === undefined || v === null ? 'A' : String(v);
  return s === 'D' || s === 'S' || s === 'F' ? s : 'A';
}

/**
 * Absent posterid means anonymous. LJ omits the attribute; it is never '0', so
 * `Number(undefined) || 0` would invent user 0 for 22 real comments.
 */
function parsePosterId(v: unknown): number | undefined {
  return v === undefined || v === null ? undefined : Number(v);
}

export function parseCommentMeta(xml: string): CommentMetaPage {
  const doc = commentParser.parse(xml) as Record<string, unknown>;
  const lj = (doc['livejournal'] ?? {}) as Record<string, unknown>;

  const comments = toArray(
    (lj['comments'] as Record<string, unknown> | undefined)?.['comment'] as Record<
      string,
      unknown
    >[],
  ).map((c): CommentMeta => ({
    id: Number(c['@_id']),
    jitemid: Number(c['@_jitemid']),
    posterid: parsePosterId(c['@_posterid']),
    state: parseState(c['@_state']),
  }));

  const usermaps = toArray(
    (lj['usermaps'] as Record<string, unknown> | undefined)?.['usermap'] as Record<
      string,
      unknown
    >[],
  ).map((u): UserMap => ({
    posterid: Number(u['@_id']),
    username: String(u['@_user']),
  }));

  return { maxid: Number(lj['maxid'] ?? 0), comments, usermaps };
}

export function parseCommentBody(xml: string): CommentBody[] {
  const doc = commentParser.parse(xml) as Record<string, unknown>;
  const lj = (doc['livejournal'] ?? {}) as Record<string, unknown>;

  return toArray(
    (lj['comments'] as Record<string, unknown> | undefined)?.['comment'] as Record<
      string,
      unknown
    >[],
  ).map((c): CommentBody => {
    const raw = (k: string): string | undefined => {
      const v = c[k];
      return v === undefined || v === null || v === '' ? undefined : String(v);
    };
    return {
      id: Number(c['@_id']),
      jitemid: Number(c['@_jitemid']),
      posterid: parsePosterId(c['@_posterid']),
      // Absent parentid means top-level. It is never '0'. Reading absent-as-0
      // makes every root comment a reply to comment 0 and flattens the thread.
      parentid: c['@_parentid'] === undefined ? undefined : Number(c['@_parentid']),
      state: parseState(c['@_state']),
      subject: raw('subject'),
      // Deleted comments arrive self-closing with no children at all.
      body: raw('body'),
      date: raw('date'),
    };
  });
}

/**
 * Where the next comment_body page starts.
 *
 * Not `startid + pageSize`: comment ids have gaps (6,550 comments spread over
 * ids 1–6,570 in one journal), so a fixed stride skips real comments. And not
 * the `nextid` element the archived LJ source emits — the live server doesn't
 * send one (DESIGN.md §5.1).
 *
 * Returns undefined when the page reached maxid, i.e. we're done.
 */
export function nextStartId(page: readonly CommentBody[], maxid: number): number | undefined {
  if (page.length === 0) return undefined;
  const highest = Math.max(...page.map((c) => c.id));
  return highest >= maxid ? undefined : highest + 1;
}
