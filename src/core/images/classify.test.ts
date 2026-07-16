import { describe, it, expect } from 'vitest';
import { sniffMime, readSize, classifyBytes, detectPoison } from './classify.js';

/**
 * Oracle: real file-format magic numbers (defined by the format specs, not by
 * us) and adversarially-chosen scenarios with known-right answers (DESIGN.md
 * §10). Nothing here is derived from what the implementation happens to do.
 */

// Minimal but genuine headers — these byte sequences are what the formats say.
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1,
  0, 0, 0, 1,
]);
const PNG_800x600 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 0, 0, 0x03,
  0x20, 0, 0, 0x02, 0x58,
]);
const GIF_1x1 = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
const HTML = new TextEncoder().encode(
  '<!DOCTYPE html><html><body>Upgrade your account</body></html>',
);

const ok = (bytes: Uint8Array) => ({ url: 'u', httpStatus: 200, bytes, error: undefined });

describe('sniffMime — the bytes, not the header', () => {
  it('identifies real format magic numbers', () => {
    expect(sniffMime(JPEG)).toBe('image/jpeg');
    expect(sniffMime(PNG_1x1)).toBe('image/png');
    expect(sniffMime(GIF_1x1)).toBe('image/gif');
    expect(sniffMime(new Uint8Array([0x42, 0x4d, 0, 0]))).toBe('image/bmp');
  });

  // catches: trusting Content-Type or the URL extension. This IS the design's
  // central claim — a dead host serves an HTML page at 200 from a .jpg URL with
  // an image content-type. Only the bytes can't lie.
  it('identifies HTML masquerading as an image', () => {
    expect(sniffMime(HTML)).toBe('text/html');
  });

  it('returns undefined for bytes it cannot identify, rather than guessing', () => {
    expect(sniffMime(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBeUndefined();
  });
});

describe('readSize', () => {
  it('reads PNG dimensions from IHDR', () => {
    expect(readSize(PNG_800x600)).toEqual({ width: 800, height: 600 });
  });

  it('reads GIF dimensions from the logical screen descriptor', () => {
    expect(readSize(GIF_1x1)).toEqual({ width: 1, height: 1 });
  });

  // catches: throwing on a truncated header. Half this corpus is fifteen-year-old
  // files from dying servers; a truncated response must not crash the run (§9).
  it('returns undefined on a truncated header rather than throwing', () => {
    expect(readSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeUndefined();
  });
});

describe('classifyBytes', () => {
  it('accepts a real image', () => {
    expect(classifyBytes(ok(PNG_800x600)).status).toBe('ok');
  });

  // catches: treating HTTP 200 as success. The entire premise of §5.2: when
  // Photobucket killed hotlinking it served a placeholder at 200 with a valid
  // image content-type. A status-code check reports near-total success while the
  // archive fills with ransom notes.
  it('rejects HTML served at 200 where an image was expected', () => {
    const v = classifyBytes(ok(HTML));
    expect(v.status).toBe('dead');
    expect(v.reason).toMatch(/HTML/);
  });

  // catches: keeping 1x1 spacers and tracking pixels as real images. 2000s HTML
  // is full of spacer.gif; a tracking pixel is byte-identical to a layout spacer,
  // and neither is a photo.
  it('rejects degenerate 1x1 images', () => {
    expect(classifyBytes(ok(GIF_1x1)).status).toBe('dead');
    expect(classifyBytes(ok(PNG_1x1)).status).toBe('dead');
  });

  it('rejects an empty body served at 200', () => {
    expect(classifyBytes(ok(new Uint8Array(0))).status).toBe('dead');
  });

  it('rejects a non-2xx status', () => {
    expect(
      classifyBytes({ url: 'u', httpStatus: 404, bytes: undefined, error: undefined }).status,
    ).toBe('dead');
  });

  // catches: losing why it died. The placeholder carries the corpse (§4.3), and
  // with alt text on only 24 of 608 refs, the reason is most of what's left.
  it('records why, not just that', () => {
    expect(
      classifyBytes({ url: 'u', httpStatus: undefined, bytes: undefined, error: 'ENOTFOUND' })
        .reason,
    ).toBe('ENOTFOUND');
  });
});

describe('detectPoison — host collapse', () => {
  const refs = (spec: [host: string, hash: string, n: number][]) =>
    spec.flatMap(([host, hash, n]) =>
      Array.from({ length: n }, (_, i) => ({
        hash,
        host,
        sourceUrl: `http://${host}/${hash}-${i}.jpg`,
      })),
    );

  // catches: not detecting the case the feature exists for. A dead host serves
  // one placeholder for every URL — 142 distinct URLs, one blob.
  it('flags a host whose distinct URLs all collapse to one blob', () => {
    const found = detectPoison(refs([['dead.invalid', 'ransomhash', 142]]));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ hash: 'ransomhash', host: 'dead.invalid', distinctUrls: 142 });
    expect(found[0]?.share).toBe(1);
  });

  // catches: counting REFERENCES instead of DISTINCT URLs. An image legitimately
  // reposted forty times is one URL repeated — flagging it would delete a real
  // image the author used deliberately.
  it('ignores one URL referenced many times', () => {
    const many = Array.from({ length: 40 }, () => ({
      hash: 'memehash',
      host: 'host1.invalid',
      sourceUrl: 'http://host1.invalid/the-same-meme.gif',
    }));
    expect(detectPoison(many)).toHaveLength(0);
  });

  // catches: flagging a genuinely reused image. A meme posted from a few URLs on
  // a live host is a small share of that host's URLs; a dead host is ~all of them.
  it('ignores a small share of a healthy host', () => {
    const found = detectPoison(
      refs([
        ['live.invalid', 'reused', 6],
        ['live.invalid', 'a', 20],
        ['live.invalid', 'b', 20],
        ['live.invalid', 'c', 20],
      ]),
    );
    expect(found).toHaveLength(0);
  });

  // catches: grouping across hosts. Two hosts each serving their own placeholder
  // are two findings, not one — and a blob shared across unrelated hosts is a
  // genuinely popular image, not a placeholder.
  it('groups by host', () => {
    const found = detectPoison(
      refs([
        ['deadA.invalid', 'placeholderA', 20],
        ['deadB.invalid', 'placeholderB', 20],
      ]),
    );
    expect(found).toHaveLength(2);
    expect(new Set(found.map((f) => f.host))).toEqual(new Set(['deadA.invalid', 'deadB.invalid']));
  });

  // catches: firing on thin evidence. Three URLs sharing a blob is a coincidence;
  // a false positive here deletes a real photo, which is unrecoverable in a way
  // that keeping a ransom note is not.
  it('needs more than a couple of URLs before it fires', () => {
    expect(detectPoison(refs([['host1.invalid', 'h', 3]]))).toHaveLength(0);
    expect(detectPoison(refs([['host1.invalid', 'h', 3]]), { minUrls: 2 })).toHaveLength(1);
  });

  // catches: a partially-dead host slipping through. If most of a host's images
  // died but some survive, the placeholder still dominates — that must still fire.
  it('fires when most of a host died but some images survive', () => {
    const found = detectPoison(
      refs([
        ['half.invalid', 'placeholder', 30],
        ['half.invalid', 'real1', 1],
        ['half.invalid', 'real2', 1],
      ]),
    );
    expect(found).toHaveLength(1);
    expect(found[0]?.hash).toBe('placeholder');
  });
});
