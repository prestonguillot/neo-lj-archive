import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from '../../src/core/store/db.js';
import { buildSite } from '../../src/core/build/index.js';
import { Secret } from '../../src/core/secret.js';
import type { CommentMeta, CommentBody } from '../../src/core/fetch/types.js';

/**
 * A synthetic archive, built through the real code path (DESIGN.md §10).
 *
 * Never the author's journal: that data is private, is not in source control,
 * and a test that needs it can only ever run on one machine. Every case here is
 * one the real corpus proved exists — an unclosed cut, a poll LJ kept
 * server-side, a dead image, a deep thread — reconstructed from the design notes
 * rather than copied out of the export.
 */

const USER = 'testuser';

/** A real 1x1 PNG. Chromium has to decode these bytes, so they can't be faked. */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const LIVE_IMG = 'http://images.invalid/cat.png';
const DEAD_IMG = 'http://gone.invalid/lost.jpg';

export interface Fixture {
  readonly dir: string;
  readonly site: string;
}

export async function buildFixture(): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 'neo-lj-e2e-'));
  const store = Store.open(dir);

  try {
    store.putEntries([
      {
        itemid: 1,
        anum: 10,
        ditemid: 266,
        eventtime: '2004-03-15 21:30:00',
        logtime: '2004-03-15 21:30:00',
        subject: 'A day with everything in it',
        // Every transform the renderer owes the reader, in one body.
        body:
          `Hanging out with <lj user="alice"> and <lj user="bob"> today.\n` +
          `<img src="${LIVE_IMG}" alt="my cat">\n` +
          `<img src="${DEAD_IMG}" alt="the lost one">\n` +
          `<a href="www.somethingawful.com">that site</a>\n` +
          `<lj-cut text="the rest of it">Everything after the cut lives here.`,
        security: 'public',
        allowmask: undefined,
        mood: 'contemplative',
        moodid: undefined,
        music: 'a band I liked',
        location: undefined,
        pictureKeyword: undefined,
        tags: ['life', 'photos'],
        props: {},
      },
      {
        itemid: 2,
        anum: 11,
        ditemid: 277,
        eventtime: '2004-03-16 10:00:00',
        logtime: '2004-03-16 10:00:00',
        subject: 'The private one',
        // A poll: LJ kept the questions on its own servers, so this tag is all
        // the export has. It must not render as silence.
        body: 'So LiveJournal, I ask you:\n<lj-poll-1438708>\nAnd life went on.',
        security: 'private',
        allowmask: undefined,
        mood: undefined,
        // Mood as an id only — 307 real entries look exactly like this.
        moodid: 15,
        music: undefined,
        location: undefined,
        pictureKeyword: undefined,
        tags: ['life'],
        props: {},
      },
    ]);

    store.putMoods([{ moodid: 15, name: 'exhausted', parent: undefined }]);
    store.putUsers([
      { posterid: 100, username: 'alice' },
      { posterid: 101, username: 'bob' },
    ]);

    // A thread deep enough that flattening it would be unmistakable. The real
    // corpus has one 27 deep; nesting is what's under test, not the depth.
    const DEPTH = 8;
    const meta: CommentMeta[] = [];
    const bodies: CommentBody[] = [];
    for (let i = 1; i <= DEPTH; i++) {
      const posterid = i % 2 === 0 ? 100 : 101;
      meta.push({ id: i, jitemid: 1, posterid, state: 'A' });
      bodies.push({
        id: i,
        jitemid: 1,
        // undefined, never 0: 0 would flatten the thread to all top-level.
        parentid: i === 1 ? undefined : i - 1,
        posterid,
        state: 'A',
        subject: undefined,
        body: `Reply at depth ${i}`,
        date: '2004-03-15 22:00:00',
      });
    }
    store.putCommentMeta(meta);
    store.putCommentBodies(bodies);

    // Two references the entry makes: one recovered, one gone.
    store.putAssetRefs([
      {
        sourceUrl: LIVE_IMG,
        host: 'images.invalid',
        context: 'entry',
        contextId: 1,
        altText: 'my cat',
      },
      {
        sourceUrl: DEAD_IMG,
        host: 'gone.invalid',
        context: 'entry',
        contextId: 1,
        altText: 'the lost one',
      },
    ]);

    const hash = createHash('sha256').update(PNG_1X1).digest('hex');
    const localPath = `blobs/${hash.slice(0, 2)}/${hash}.png`;
    const abs = join(dir, localPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, PNG_1X1);

    store.putAssetResult({
      url: LIVE_IMG,
      hash,
      mime: 'image/png',
      byteLen: PNG_1X1.length,
      width: 1,
      height: 1,
      status: 'ok',
      localPath,
      httpStatus: 200,
      reason: undefined,
    });
    store.putAssetResult({
      url: DEAD_IMG,
      hash: undefined,
      mime: undefined,
      byteLen: 0,
      width: undefined,
      height: undefined,
      status: 'dead',
      localPath: undefined,
      httpStatus: 404,
      reason: 'HTTP 404',
    });

    await buildSite(
      {
        username: USER,
        passwordMd5: new Secret(''),
        outputDir: dir,
        requestDelayMs: 0,
        imageConcurrency: 1,
        imageTimeoutMs: 1000,
      },
      { store },
    );
  } finally {
    store.close();
  }

  return { dir, site: join(dir, 'site') };
}
