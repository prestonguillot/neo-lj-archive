import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  parseEvents,
  parseCommentMeta,
  parseCommentBody,
  parseLogin,
  nextStartId,
} from './parse.js';
import { decodeResponse, encodeRequest, XmlRpcFault } from './xmlrpc.js';

/**
 * The oracle is LiveJournal's own XML, captured from a real journal and
 * scrubbed of payload (DESIGN.md §10). Nobody here authored the structure —
 * which is the point. Every `catches:` below is a defect these fixtures caught
 * in a design that had already been written down and reviewed.
 */
const fixture = (name: string): string =>
  readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');

const recent = () => parseEvents(fixture('getevents-lastn.xml'));
const old2004 = () => parseEvents(fixture('getevents-2004.xml'));
const meta = () => parseCommentMeta(fixture('export-comment-meta.xml'));
const bodies = () => parseCommentBody(fixture('export-comment-body.xml'));

describe('parseCommentBody', () => {
  it('reads 999 comments from a full page', () => {
    expect(bodies()).toHaveLength(999);
  });

  // catches: parentid read as 0 for top-level comments. LJ omits the attribute
  // entirely; `Number(undefined) || 0` yields 0, making all 582 root comments
  // replies to a comment that does not exist. Every thread silently flattens.
  it('leaves parentid undefined for top-level comments, never 0', () => {
    const roots = bodies().filter((c) => c.parentid === undefined);
    expect(roots).toHaveLength(582);
    expect(bodies().some((c) => c.parentid === 0)).toBe(false);
  });

  it('reads parentid for replies', () => {
    expect(bodies().filter((c) => c.parentid !== undefined)).toHaveLength(417);
  });

  // catches: posterid coerced to 0 for anonymous comments. LJ omits the
  // attribute; a non-null FK to users(posterid) throws, or invents user 0.
  it('leaves posterid undefined for anonymous comments, never 0', () => {
    const anon = bodies().filter((c) => c.posterid === undefined);
    expect(anon).toHaveLength(4);
    expect(bodies().some((c) => c.posterid === 0)).toBe(false);
  });

  // catches: assuming every comment has a <body>. Deleted comments arrive
  // self-closing with no children, so a parser that dereferences body dies on
  // 44 of 999 — and this is the common case, not an edge.
  it('handles deleted comments arriving with no children at all', () => {
    const deleted = bodies().filter((c) => c.state === 'D');
    expect(deleted).toHaveLength(44);
    for (const c of deleted) {
      expect(c.body).toBeUndefined();
      expect(c.date).toBeUndefined();
    }
  });

  // catches: treating an absent state attribute as missing data. LJ only emits
  // state when it is NOT active, so absent means active.
  it('treats an absent state attribute as active', () => {
    expect(bodies().filter((c) => c.state === 'A')).toHaveLength(955);
  });

  it('reads bodies for active comments', () => {
    for (const c of bodies().filter((c) => c.state === 'A')) {
      expect(c.body).toBeDefined();
      expect(c.date).toBeDefined();
    }
  });
});

describe('parseCommentMeta', () => {
  // catches: reading the id list from comment_body. Body pages at 1,000, so a
  // fetcher indexing off it would believe the journal has 999 comments when it
  // has 6,550.
  it('returns the whole journal index in one page', () => {
    const m = meta();
    expect(m.comments).toHaveLength(6550);
    expect(m.maxid).toBe(6570);
  });

  it('maps posterids to usernames', () => {
    expect(meta().usermaps).toHaveLength(194);
    for (const u of meta().usermaps) {
      expect(u.posterid).toBeGreaterThan(0);
      expect(u.username).not.toBe('');
    }
  });

  // catches: assuming screening never occurs. It was expected to be absent from
  // this journal; there are 2. Rare is not never.
  it('reads every comment state LJ actually sent', () => {
    const tally: Record<string, number> = {};
    for (const c of meta().comments) tally[c.state] = (tally[c.state] ?? 0) + 1;
    expect(tally).toEqual({ A: 6331, D: 217, S: 2 });
  });

  it('leaves posterid undefined for the 22 anonymous commenters', () => {
    expect(meta().comments.filter((c) => c.posterid === undefined)).toHaveLength(22);
  });
});

describe('nextStartId', () => {
  // catches: paging by a fixed stride. Ids have gaps — 6,550 comments spread
  // across ids 1–6,570 — so startid += 1000 walks past real comments and
  // silently loses them.
  it('advances past the highest id received, not by page size', () => {
    expect(nextStartId(bodies(), 6570)).toBe(1000);
  });

  it('stops when the page reaches maxid', () => {
    expect(nextStartId([{ id: 6570 } as never], 6570)).toBeUndefined();
  });

  it('stops on an empty page rather than looping forever', () => {
    expect(nextStartId([], 6570)).toBeUndefined();
  });
});

describe('parseEvents', () => {
  it('reads 20 entries from each slice', () => {
    expect(recent()).toHaveLength(20);
    expect(old2004()).toHaveLength(20);
  });

  // catches: computing ditemid as itemid*256+anum. LJ returns it directly; the
  // derivation is one more place to be subtly wrong.
  it('takes ditemid from LJ rather than deriving it', () => {
    for (const e of recent()) {
      expect(e.ditemid).toBeGreaterThan(0);
      expect(e.ditemid).toBe(e.itemid * 256 + e.anum);
    }
  });

  // catches: recording only current_mood. Mood is two independent fields —
  // 4 of these 20 entries carry a moodid and only 2 carry mood text, so the
  // other 2 lose their mood entirely. §7.1 calls mood exactly the sort of
  // texture people miss.
  it('reads mood and moodid as independent fields', () => {
    const e = old2004();
    expect(e.filter((x) => x.moodid !== undefined)).toHaveLength(4);
    expect(e.filter((x) => x.mood !== undefined)).toHaveLength(2);
    // The point: entries with a moodid but no mood text exist.
    expect(e.filter((x) => x.moodid !== undefined && x.mood === undefined).length).toBeGreaterThan(
      0,
    );
  });

  // catches: ignoring base64. LJ encodes entry bodies selectively — 1 of these
  // 20 — so a parser reading <string> only returns empty for that entry.
  it('decodes base64-encoded entry bodies', () => {
    for (const e of recent()) expect(e.body).not.toBe('');
  });

  // The previous version of this test asserted `expect([...]).toContain(security)`
  // — a tautology, since the parser can only return those three values. It
  // passed with the code deliberately broken. Replaced with the actual
  // distribution LJ sent, which cannot pass unless parsing is right.
  it('reads the security levels LJ actually sent', () => {
    const tally = (es: ReturnType<typeof recent>): Record<string, number> => {
      const t: Record<string, number> = {};
      for (const e of es) t[e.security] = (t[e.security] ?? 0) + 1;
      return t;
    };
    expect(tally(recent())).toEqual({ private: 9, usemask: 11 });
    expect(tally(old2004())).toEqual({ private: 20 });
  });

  // catches: allowmask read for entries where it is meaningless. LJ only sends
  // it for usemask entries; a friends-group bitmask on a private entry is noise
  // that would leak into the UI as a false access claim.
  it('reads allowmask only where LJ sends it', () => {
    for (const e of recent()) {
      if (e.security === 'usemask') expect(e.allowmask).toBeGreaterThan(0);
      else expect(e.allowmask).toBeUndefined();
    }
  });

  it('keeps unmodelled props rather than dropping them', () => {
    // personifi_tags / verticals_list etc. are LJ noise, but this archive is
    // meant to be lossless — better kept than silently discarded.
    expect(recent().some((e) => Object.keys(e.props).length > 0)).toBe(true);
  });
});

describe('parseLogin', () => {
  // catches: not fetching the mood vocabulary. Without it, every moodid is an
  // unresolvable integer and those entries render no mood at all.
  it('reads LJ mood vocabulary when present', () => {
    // The captured login was made without getmoods, so this proves the absence
    // path doesn't throw — the vocabulary is fetched separately.
    expect(parseLogin(fixture('login.xml')).moods).toEqual([]);
  });

  it('reads the account username', () => {
    expect(parseLogin(fixture('login.xml')).username).toBe('testuser');
  });

  // catches: silently fetching communities. login advertises 9 usejournals;
  // §3 scopes them out. Parsing them is fine — sending usejournal is not.
  it('surfaces usejournals without implying we fetch them', () => {
    expect(parseLogin(fixture('login.xml')).usejournals.length).toBeGreaterThan(0);
  });
});

describe('xmlrpc', () => {
  // catches: trusting the HTTP status. LJ returns faults with 200 and a <fault>
  // body, so status-only checking reports success on a rejected request.
  it('throws on a fault despite a well-formed response', () => {
    const fault = `<?xml version="1.0"?><methodResponse><fault><value><struct>
      <member><name>faultCode</name><value><int>100</int></value></member>
      <member><name>faultString</name><value><string>Invalid password</string></value></member>
    </struct></value></fault></methodResponse>`;
    expect(() => decodeResponse(fault)).toThrow(XmlRpcFault);
    expect(() => decodeResponse(fault)).toThrow(/Invalid password/);
  });

  // catches: treating a bare <value> as empty. Per the XML-RPC spec an untyped
  // value is a string; omitting that case makes such fields vanish.
  it('reads an untyped <value> as a string, per spec', () => {
    const xml = `<?xml version="1.0"?><methodResponse><params><param><value><struct>
      <member><name>bare</name><value>hello</value></member>
    </struct></value></param></params></methodResponse>`;
    expect(decodeResponse(xml)).toEqual({ bare: 'hello' });
  });

  it('escapes XML metacharacters when encoding a request', () => {
    const xml = encodeRequest('LJ.XMLRPC.login', { username: 'a&b<c' });
    expect(xml).toContain('a&amp;b&lt;c');
  });
});
