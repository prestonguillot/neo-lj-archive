import { describe, it, expect } from 'vitest';
import { splitMusic, musicKey } from './index.js';

/**
 * current_music parsing and the dedup key (DESIGN.md §10). The rule was DERIVED
 * from the corpus (most entries use " - "), and a real bug shipped here once — commit
 * "normalise so the count is true". These are the oracle values, chosen from LJ's
 * actual shapes, not read off the code.
 */
describe('splitMusic', () => {
  it.each([
    ['artist - song', 'Glass Harbor - Paper Lanterns', 'Glass Harbor', 'Paper Lanterns'],
    ['artist contains a hyphen', 'Re-Entry - Ninety Rooms', 'Re-Entry', 'Ninety Rooms'],
    ['song by artist (reversed)', 'Lullaby by Ottoline Vance', 'Ottoline Vance', 'Lullaby'],
    ['no separator is all artist', 'Quiet Engine', 'Quiet Engine', null],
  ])('%s', (_label, raw, artist, song) => {
    expect(splitMusic(raw)).toEqual({ artist, song });
  });

  // catches: " - " matching on the FIRST occurrence — a song with " - " in it must
  // still attribute the artist correctly (artist is before the first separator).
  it('splits on the first " - " only', () => {
    expect(splitMusic('Marrowgate - Lighthouse - Reprise')).toEqual({
      artist: 'Marrowgate',
      song: 'Lighthouse - Reprise',
    });
  });
});

describe('musicKey (dedup — the count depends on it)', () => {
  // catches: the exact "count is true" bug — one band typed two ways (with and
  // without the space) counted as two artists when they are one. THE reason this function exists.
  it.each([
    ['whitespace', 'Glass Harbor', 'Glassharbor'],
    ['leading The', 'The Kestrels', 'Kestrels'],
    ['case', 'QUIET ENGINE', 'quiet engine'],
    ['trailing punctuation', 'Lanternfish!', 'Lanternfish'],
    ['ampersand entity', 'Salt &amp; Cedar', 'Salt & Cedar'],
  ])('folds %s to one key', (_label, a, b) => {
    expect(musicKey(a)).toBe(musicKey(b));
  });

  // catches: over-folding — two genuinely different artists must NOT merge.
  it('keeps distinct artists distinct', () => {
    expect(musicKey('Glass Harbor')).not.toBe(musicKey('Quiet Engine'));
    expect(musicKey('The Kestrels')).not.toBe(musicKey('The Kestrel Boys'));
  });
});
