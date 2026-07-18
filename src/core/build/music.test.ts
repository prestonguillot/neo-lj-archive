import { describe, it, expect } from 'vitest';
import { splitMusic, musicKey } from './index.js';

/**
 * current_music parsing and the dedup key (DESIGN.md §10). The rule was DERIVED
 * from the corpus (409/473 use " - "), and a real bug shipped here once — commit
 * "normalise so the count is true". These are the oracle values, chosen from LJ's
 * actual shapes, not read off the code.
 */
describe('splitMusic', () => {
  it.each([
    ['artist - song', 'Brand New - Sic Transit Gloria', 'Brand New', 'Sic Transit Gloria'],
    ['song title contains a hyphen', 'Jay-Z - 99 Problems', 'Jay-Z', '99 Problems'],
    ['song by artist (reversed)', 'Hallelujah by Jeff Buckley', 'Jeff Buckley', 'Hallelujah'],
    ['no separator is all artist', 'Radiohead', 'Radiohead', null],
  ])('%s', (_label, raw, artist, song) => {
    expect(splitMusic(raw)).toEqual({ artist, song });
  });

  // catches: " - " matching on the FIRST occurrence — a song with " - " in it must
  // still attribute the artist correctly (artist is before the first separator).
  it('splits on the first " - " only', () => {
    expect(splitMusic('Sufjan - Chicago - Reprise')).toEqual({
      artist: 'Sufjan',
      song: 'Chicago - Reprise',
    });
  });
});

describe('musicKey (dedup — the count depends on it)', () => {
  // catches: the exact "count is true" bug — Green Day (14) and Greenday (8)
  // counted as two artists when they are one. THE reason this function exists.
  it.each([
    ['whitespace', 'Green Day', 'Greenday'],
    ['leading The', 'The Beatles', 'Beatles'],
    ['case', 'RADIOHEAD', 'radiohead'],
    ['trailing punctuation', 'Weezer!', 'Weezer'],
    ['ampersand entity', 'Iron &amp; Wine', 'Iron & Wine'],
  ])('folds %s to one key', (_label, a, b) => {
    expect(musicKey(a)).toBe(musicKey(b));
  });

  // catches: over-folding — two genuinely different artists must NOT merge.
  it('keeps distinct artists distinct', () => {
    expect(musicKey('Brand New')).not.toBe(musicKey('Green Day'));
    expect(musicKey('The Beatles')).not.toBe(musicKey('The Beach Boys'));
  });
});
