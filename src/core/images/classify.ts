/**
 * Deciding what a downloaded blob actually is, and whether it's real (§5.2).
 *
 * Everything here is a pure function. Sniffing takes bytes; poison detection
 * takes reference tuples. No network, no clock, no database — so both can be
 * tested against adversarial inputs with known-right answers rather than against
 * whatever the implementation happens to do.
 */

export type AssetStatus = 'ok' | 'dead' | 'suspect' | 'poison';

/**
 * Identify a blob from its MAGIC NUMBERS, never from the Content-Type header or
 * the URL's extension.
 *
 * Both lie, routinely and in the direction that matters. A dead host serves an
 * HTML "upgrade your account" page from a URL ending `.jpg`, with an image
 * content-type, at HTTP 200. The bytes are the only thing that can't lie.
 */
export function sniffMime(bytes: Uint8Array): string | undefined {
  const b = bytes;
  if (b.length < 4) return undefined;

  const at = (i: number, ...sig: number[]): boolean => sig.every((s, j) => b[i + j] === s);

  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x42, 0x4d)) return 'image/bmp';
  // RIFF....WEBP
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(0, 0x49, 0x49, 0x2a, 0x00) || at(0, 0x4d, 0x4d, 0x00, 0x2a)) return 'image/tiff';

  // Not an image. Worth distinguishing HTML specifically: that's the shape of a
  // host serving an error page or a login wall where a photo used to be.
  const head = Buffer.from(b.subarray(0, 512)).toString('latin1').trimStart().toLowerCase();
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<?xml')) {
    return 'text/html';
  }
  return undefined;
}

export const EXT_FOR_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/webp': 'webp',
  'image/tiff': 'tiff',
};

/**
 * Image dimensions from the header alone — enough to spot a degenerate image
 * without decoding pixels.
 *
 * 1×1 matters more than it sounds: 2000s HTML is full of `spacer.gif`, and a
 * tracking pixel is byte-identical to a layout spacer. Both are "not a photo",
 * which is all we need to know.
 */
export function readSize(bytes: Uint8Array): { width: number; height: number } | undefined {
  const b = Buffer.from(bytes);
  const mime = sniffMime(bytes);

  try {
    if (mime === 'image/png' && b.length >= 24) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }
    if (mime === 'image/gif' && b.length >= 10) {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }
    if (mime === 'image/bmp' && b.length >= 26) {
      return { width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
    }
    if (mime === 'image/jpeg') {
      // Walk the segment chain to a Start-Of-Frame marker. JPEG has no fixed
      // header offset — dimensions live in whichever SOFn shows up.
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = b[i + 1] ?? 0;
        // SOF0..SOF15, excluding DHT(c4), JPGA(c8), DAC(cc)
        if (
          marker >= 0xc0 &&
          marker <= 0xcf &&
          marker !== 0xc4 &&
          marker !== 0xc8 &&
          marker !== 0xcc
        ) {
          return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
        }
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
  } catch {
    // Truncated or malformed header. Not knowing the size is fine; guessing is not.
    return undefined;
  }
  return undefined;
}

export interface FetchOutcome {
  readonly url: string;
  readonly httpStatus: number | undefined;
  readonly bytes: Uint8Array | undefined;
  readonly error: string | undefined;
}

export interface Verdict {
  readonly status: AssetStatus;
  readonly mime: string | undefined;
  readonly reason: string | undefined;
}

/**
 * Tier 1, per-asset: is this blob a real image at all?
 *
 * Deliberately does not consider HTTP status alone. A 200 proves the server
 * answered, not that it answered with your photo.
 */
export function classifyBytes(o: FetchOutcome): Verdict {
  if (o.error !== undefined || o.bytes === undefined) {
    return { status: 'dead', mime: undefined, reason: o.error ?? 'no response' };
  }
  if (o.httpStatus !== undefined && (o.httpStatus < 200 || o.httpStatus >= 300)) {
    return { status: 'dead', mime: undefined, reason: `HTTP ${o.httpStatus}` };
  }
  if (o.bytes.length === 0) {
    return { status: 'dead', mime: undefined, reason: 'empty body' };
  }

  const mime = sniffMime(o.bytes);
  if (mime === undefined) {
    return { status: 'dead', mime: undefined, reason: 'not a recognisable image' };
  }
  if (mime === 'text/html') {
    // The classic: an error page, login wall or "account upgraded" notice served
    // at 200 from a URL ending .jpg.
    return { status: 'dead', mime, reason: 'HTML served where an image was expected' };
  }

  const size = readSize(o.bytes);
  if (size !== undefined && size.width <= 1 && size.height <= 1) {
    return { status: 'dead', mime, reason: `degenerate ${size.width}x${size.height}` };
  }

  return { status: 'ok', mime, reason: undefined };
}

export interface RefRow {
  readonly hash: string;
  readonly sourceUrl: string;
  readonly host: string;
}

export interface PoisonFinding {
  readonly hash: string;
  readonly host: string;
  readonly distinctUrls: number;
  /** Share of that host's distinct URLs collapsing onto this one blob. */
  readonly share: number;
}

export interface PoisonOptions {
  /** Distinct URLs on one host that must share a blob before it counts. */
  readonly minUrls?: number;
  /** Share of the host's URLs that must collapse onto it. */
  readonly minShare?: number;
}

/**
 * Tier 1, cross-asset: HOST COLLAPSE.
 *
 * If many DISTINCT urls on the same host return byte-identical content, that
 * host is serving one placeholder, not many photos. This is the whole mechanism
 * — and it costs nothing, because content-addressing already computed it.
 *
 * Two guards against false positives, both learned from what the real corpus
 * looks like:
 *
 *  - DISTINCT urls, never reference count. An image legitimately reposted forty
 *    times is ONE url repeated; that must not register.
 *  - Grouped by host, with a share threshold. A meme genuinely reused across a
 *    few URLs on one host is a small share; a dead host is ~all of them.
 *
 * Note what it never uses: the hostname itself. Detection keys on collapse, and
 * a list of known-bad hosts would be a maintenance treadmill that misses the
 * next one.
 */
export function detectPoison(rows: readonly RefRow[], opts: PoisonOptions = {}): PoisonFinding[] {
  const minUrls = opts.minUrls ?? 5;
  const minShare = opts.minShare ?? 0.5;

  // host -> distinct urls ; host -> hash -> distinct urls
  //
  // Nested maps, not a joined string key. The first version built a
  // `host<sep>hash` key and split it apart again on the read side. It was
  // correct — both sides used the same separator — but that separator was an
  // invisible NUL byte, so the code read as though it used a space and no tool
  // could match it. A key that only works because two invisible characters agree
  // is one careless edit from a silent, hard-to-see failure. Nesting removes the
  // separator, so there is nothing left to get wrong.
  const urlsPerHost = new Map<string, Set<string>>();
  const urlsPerHostHash = new Map<string, Map<string, Set<string>>>();

  for (const r of rows) {
    if (!r.hash || !r.host) continue;

    const h = urlsPerHost.get(r.host) ?? new Set<string>();
    h.add(r.sourceUrl);
    urlsPerHost.set(r.host, h);

    const byHash = urlsPerHostHash.get(r.host) ?? new Map<string, Set<string>>();
    const urls = byHash.get(r.hash) ?? new Set<string>();
    urls.add(r.sourceUrl);
    byHash.set(r.hash, urls);
    urlsPerHostHash.set(r.host, byHash);
  }

  const out: PoisonFinding[] = [];
  for (const [host, byHash] of urlsPerHostHash) {
    const total = urlsPerHost.get(host)?.size ?? 0;
    if (total === 0) continue;
    for (const [hash, urls] of byHash) {
      if (urls.size < minUrls) continue;
      const share = urls.size / total;
      if (share < minShare) continue;
      out.push({ hash, host, distinctUrls: urls.size, share });
    }
  }
  return out.sort((a, b) => b.distinctUrls - a.distinctUrls);
}
