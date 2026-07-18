import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../store/db.js';
import { buildSite } from './index.js';
import { decodeEntities } from './index.js';
import { Secret } from '../secret.js';
import type { CommentMeta, CommentBody } from '../fetch/types.js';

/**
 * Escaping fidelity (DESIGN.md §4.3, §10).
 *
 * The build double-escaped every display value: it called esc() AND bound the
 * result into EJS <%=, which escapes again — so "Iron & Wine" shipped as
 * "Iron &amp;amp; Wine", rendered by a browser as the literal "Iron &amp; Wine".
 * 25 instances across titles, tags, moods, names, tooltips. EJS <%= is the single
 * escaping owner; esc() belongs only where the build assembles raw HTML by hand
 * (the comment byline anchor). Found by a review agent, confirmed in the output.
 *
 * These run buildSite over a seeded in-memory Store and read the GENERATED files,
 * because the defect lives in the data→template wiring in index.ts, not in the
 * templates themselves. A first draft tested the templates directly and could not
 * catch esc() creeping back into buildSite — the exact regression it exists for.
 */
describe('invariant: display values are escaped exactly once', () => {
  let dir: string;
  let entryHtml: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'neolj-esc-'));
    const store = Store.openMemory();
    store.putEntries([
      {
        itemid: 1,
        anum: 10,
        ditemid: 266,
        eventtime: '2004-03-15 21:30:00',
        logtime: '2004-03-15 21:30:00',
        // Ampersand in the subject: the exact "Iron & Wine" shape that broke.
        subject: 'Iron & Wine <best band>',
        body: 'hello',
        security: 'public',
        allowmask: undefined,
        mood: 'cranky & tired',
        moodid: undefined,
        music: 'Simon & Garfunkel',
        location: undefined,
        pictureKeyword: undefined,
        tags: ['rock & roll'],
        props: {},
      },
    ]);
    store.putUsers([{ posterid: 100, username: 'someone' }]);
    const meta: CommentMeta[] = [{ id: 1, jitemid: 1, posterid: 100, state: 'A' }];
    const bodies: CommentBody[] = [
      {
        id: 1,
        jitemid: 1,
        parentid: undefined,
        posterid: 100,
        // LJ stored comment subjects entity-encoded, and re-quoted them repeatedly.
        subject: 'Re: I&amp;amp;#39;m cross & annoyed',
        body: 'a comment',
        date: '2004-03-15 22:00:00',
        state: 'A',
      },
    ];
    store.putCommentMeta(meta);
    store.putCommentBodies(bodies);

    await buildSite(
      {
        username: 'someone',
        passwordMd5: new Secret(''),
        outputDir: dir,
        requestDelayMs: 0,
        imageConcurrency: 1,
        imageTimeoutMs: 1000,
      },
      { store },
    );
    store.close();
    entryHtml = readFileSync(join(dir, 'site', 'entries', '266.html'), 'utf8');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  // catches: esc() creeping back in front of an EJS <%= binding — the double-escape
  // signature (&amp;amp;) that visibly corrupted the whole site. Checked on the
  // GENERATED page, so it exercises the real data→build→output path.
  it('never emits &amp;amp; anywhere on a built page', () => {
    expect(entryHtml).not.toContain('&amp;amp;');
  });

  it.each([
    ['subject', 'Iron &amp; Wine'],
    ['mood', 'cranky &amp; tired'],
    ['music', 'Simon &amp; Garfunkel'],
    ['tag', 'rock &amp; roll'],
  ])('escapes the %s once', (_label, expected) => {
    expect(entryHtml).toContain(expected);
  });

  // catches: single-escaping degrading into NO escaping. A subject of "<best band>"
  // must render inert, not as a tag.
  it('still escapes markup in a value', () => {
    expect(entryHtml).toContain('&lt;best band&gt;');
    expect(entryHtml).not.toContain('<best band>');
  });

  // catches: the comment-subject entity decode regressing. The re-quoted subject
  // must show an apostrophe, not a literal "&amp;#39;".
  it('decodes an entity-encoded comment subject to a single escape', () => {
    expect(entryHtml).toContain('&#39;m cross');
    expect(entryHtml).not.toContain('&amp;#39;');
  });
});

/**
 * Comment subjects arrived from LJ already entity-encoded (I&#39;m), and the
 * "Re:" re-quote chain encoded some repeatedly (&amp;amp;#39;). decodeEntities
 * unwinds that to text so EJS can re-escape it once; otherwise the page shows a
 * literal "&#39;" where an apostrophe belongs. 22 comment subjects in the corpus.
 */
describe('invariant: decodeEntities unwinds LJ entity encoding', () => {
  it.each([
    ['single', 'I&#39;m', "I'm"],
    ['re-quoted twice', 'I&amp;amp;#39;m', "I'm"],
    ['re-quoted thrice', 'I&amp;amp;amp;#39;m', "I'm"],
    ['named amp', 'Me &amp; you', 'Me & you'],
    ['hex', 'a&#x27;b', "a'b"],
    ['angle brackets', '&lt;3', '<3'],
    ['no entities is identity', 'plain text', 'plain text'],
  ])('%s -> decoded', (_label, input, expected) => {
    expect(decodeEntities(input)).toBe(expected);
  });

  // catches: an unterminated re-quote looping forever. The fixpoint loop is
  // capped, so a pathological input must still terminate and return something.
  it('terminates on a deeply nested encoding', () => {
    const deep = 'x' + '&amp;'.repeat(20) + '#39;';
    expect(() => decodeEntities(deep)).not.toThrow();
  });
});
