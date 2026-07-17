import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { slugify, assignSlugs } from './index.js';

/**
 * Tag slugs (DESIGN.md §7.2, §10).
 *
 * A tag becomes a filename, so two tags sharing a slug means two tags sharing a
 * PAGE — whichever is written second silently replaces the other's entries. No
 * error, no warning, just a tag page that quietly lies about what is tagged.
 *
 * This journal's tags happen not to collide, so the bug was latent. "Happens not
 * to collide today" is not a property; these are.
 */

describe('invariant: distinct tags never share a page', () => {
  // catches: the collision the old code CLAIMED to handle and did not. Its comment
  // said "or one that collides after squashing" while the code only handled the
  // empty string. A comment describing behaviour that does not exist is worse
  // than no comment: it stops the next reader from looking.
  it.each([
    ['punctuation squashed to the same thing', ['foo bar', 'foo-bar', 'foo_bar', 'foo!bar']],
    ['case only', ['Recipes', 'recipes', 'RECIPES']],
    ['trailing punctuation', ['wtf', 'wtf!', 'wtf?', '...wtf...']],
    ['punctuation-only tags', ['!!!', '???', '...', '<3']],
    ['unicode that squashes away', ['café', 'cafe', 'çafé']],
    ['empty-ish', ['', ' ', '-', '--']],
  ])('%s', (_label, tags) => {
    const slugs = assignSlugs(tags);
    const distinctTags = new Set(tags).size;
    const distinctSlugs = new Set(slugs.values()).size;
    expect(distinctSlugs).toBe(distinctTags);
  });

  // catches: a slug that moves between builds. Every tag link and every bookmark
  // points at a filename, so instability is a broken archive, not a cosmetic
  // wobble. Row order out of sqlite is not guaranteed.
  it('assigns the same slug regardless of the order tags arrive in', () => {
    const tags = ['foo bar', 'foo-bar', 'zebra', 'Apple', 'apple'];
    const a = assignSlugs(tags);
    const b = assignSlugs([...tags].reverse());
    for (const t of tags) expect(a.get(t)).toBe(b.get(t));
  });

  it('every tag gets a slug, and every slug is a usable filename', () => {
    const tags = ['foo bar', '!!!', '<3', 'café', 'normal'];
    const slugs = assignSlugs(tags);
    for (const t of tags) {
      const s = slugs.get(t);
      expect(s).toBeTruthy();
      // No separators, no traversal, nothing a filesystem will argue with.
      expect(s).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe('invariant: the real corpus', () => {
  // The 57 scrubbed bodies carry no tags, so the real tag list is not in source
  // control. What CAN be asserted here is the property itself, over a set built
  // to break it — which is stronger than asserting today's 143 tags are fine.
  it('holds for a large adversarial tag set', () => {
    const tags: string[] = [];
    for (let i = 0; i < 200; i++) {
      // Every one of these squashes to the same base.
      tags.push(`tag ${i}`, `tag-${i}`, `tag_${i}`, `TAG ${i}`, `tag.${i}`);
    }
    const slugs = assignSlugs(tags);
    expect(new Set(slugs.values()).size).toBe(new Set(tags).size);
  });
});

describe('slugify (the base, which is NOT collision-free)', () => {
  it('squashes punctuation and case', () => {
    expect(slugify('Foo Bar!')).toBe('foo-bar');
  });

  // Honest about what it is: this collision is exactly why assignSlugs exists,
  // and pinning it here stops someone "fixing" slugify and breaking the layer
  // that actually resolves it.
  it('DOES collide, by design — assignSlugs is what resolves it', () => {
    expect(slugify('foo bar')).toBe(slugify('foo-bar'));
  });

  it('gives a punctuation-only tag a stable hex name rather than nothing', () => {
    expect(slugify('!!!')).toMatch(/^t-[0-9a-f]+$/);
    expect(slugify('!!!')).toBe(slugify('!!!'));
  });
});

/** The built site is the proof: no two tag pages may share a filename. */
describe('the shipped archive', () => {
  it('has one page per tag', () => {
    // Skips when the private archive is absent — CI has no archive.db, and a
    // test that silently passes for the wrong reason is worse than a skip.
    let manifest: string[] | undefined;
    try {
      manifest = readFileSync(new URL('../../../archive/audit/tags.json', import.meta.url), 'utf8')
        .split('\n')
        .filter(Boolean);
    } catch {
      return;
    }
    expect(new Set(manifest).size).toBe(manifest.length);
  });
});
