import { describe, it, expect } from 'vitest';
import { youtubeThumb } from './embeds.js';

/**
 * youtubeThumb turns LJ's embed-proxy URL into a durable YouTube poster URL, or
 * undefined when there's nothing to build one from (DESIGN.md §10). Pure, and
 * exactly the shape that wants a table of oracle values chosen adversarially —
 * not read off the implementation.
 */
describe('youtubeThumb', () => {
  const proxy = (params: string): string => `https://l.lj-toys.com/?${params}`;

  it.each([
    ['a real youtube proxy', proxy('source=youtube&vid=J4QB7cHdVfs'), 'J4QB7cHdVfs'],
    ['vid ordered after source', proxy('vid=abc12345678&source=youtube'), 'abc12345678'],
  ])('%s -> img.youtube.com poster', (_label, url, vid) => {
    expect(youtubeThumb(url)).toBe(`https://img.youtube.com/vi/${vid}/hqdefault.jpg`);
  });

  it.each([
    ['non-youtube source', proxy('source=vimeo&vid=123')],
    ['no source at all', proxy('vid=abc12345678&noads=1')],
    ['source but empty vid', proxy('source=youtube&vid=')],
    ['source but no vid key', proxy('source=youtube&noads=1')],
    ['not a URL', 'not a url at all'],
    ['empty string', ''],
  ])('%s -> undefined', (_label, url) => {
    expect(youtubeThumb(url)).toBeUndefined();
  });

  // catches: a vid with URL-special characters injected into the poster URL raw.
  it('encodes the video id it puts in the URL', () => {
    const out = youtubeThumb(proxy('source=youtube&vid=' + encodeURIComponent('a/b?c')));
    expect(out).toBe('https://img.youtube.com/vi/a%2Fb%3Fc/hqdefault.jpg');
  });
});
