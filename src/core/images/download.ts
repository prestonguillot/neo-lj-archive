import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  classifyBytes,
  readSize,
  EXT_FOR_MIME,
  type FetchOutcome,
  type Verdict,
} from './classify.js';

/**
 * Fetching images from hosts that have been rotting since 2010 (§5.2).
 *
 * Core, so no console and no process: an injectable `fetch` and `sleep` keep the
 * politeness and failure policy testable without a network or a clock (§15).
 *
 * The error policy here is the OPPOSITE of the LJ fetcher's. A failure against
 * LiveJournal stops the run — a 403 is a ban and retrying deepens it. A failure
 * against some dead GeoCities box is *expected*, is *data*, and must never stop
 * anything (§9). Most of these URLs are supposed to fail.
 */

export interface DownloadOptions {
  readonly outputDir: string;
  /** Hosts fetched in parallel. Politeness is per-host, so this is safe. */
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Between requests to the SAME host. Different hosts don't wait on each other. */
  readonly perHostDelayMs?: number;
  readonly maxRetries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly sleepImpl?: (ms: number) => Promise<void>;
}

export interface StoredAsset extends Verdict {
  readonly url: string;
  readonly hash: string | undefined;
  readonly byteLen: number;
  readonly width: number | undefined;
  readonly height: number | undefined;
  readonly localPath: string | undefined;
  readonly httpStatus: number | undefined;
}

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function hostOf(url: string): string | undefined {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * One URL, one attempt chain.
 *
 * Never throws. A dead host is the expected case, not an exception — half of
 * these URLs have been gone for fifteen years, and the archive's job is to
 * record that honestly (§4.3), not to fall over.
 */
async function fetchOnce(
  url: string,
  opts: Required<Pick<DownloadOptions, 'timeoutMs' | 'maxRetries'>> & {
    fetchImpl: typeof fetch;
    sleepImpl: (ms: number) => Promise<void>;
  },
): Promise<FetchOutcome> {
  let lastErr = 'unknown';

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      const res = await opts.fetchImpl(url, {
        signal: AbortSignal.timeout(opts.timeoutMs),
        redirect: 'follow',
        headers: { 'User-Agent': 'neo-lj-archive/0.1 (personal journal archive)' },
      });

      if (!res.ok) {
        // 4xx is final — a 404 will 404 again. 5xx might be transient.
        if (res.status < 500)
          return { url, httpStatus: res.status, bytes: undefined, error: undefined };
        lastErr = `HTTP ${res.status}`;
        if (attempt === opts.maxRetries) break;
        await opts.sleepImpl(2 ** attempt * 500);
        continue;
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      return { url, httpStatus: res.status, bytes, error: undefined };
    } catch (err) {
      // DNS failure, timeout, connection refused, TLS error on a 2005 host —
      // all routine here.
      lastErr = err instanceof Error ? err.message : String(err);
      if (attempt === opts.maxRetries) break;
      await opts.sleepImpl(2 ** attempt * 500);
    }
  }

  return { url, httpStatus: undefined, bytes: undefined, error: lastErr };
}

/** blobs/ab/abcdef….jpg — sharded so no directory holds thousands of files. */
export function blobPath(hash: string, ext: string): string {
  return join('blobs', hash.slice(0, 2), `${hash}.${ext}`);
}

async function fetchAndStore(url: string, opts: DownloadOptions): Promise<StoredAsset> {
  const outcome = await fetchOnce(url, {
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries ?? 2,
    fetchImpl: opts.fetchImpl ?? fetch,
    sleepImpl: opts.sleepImpl ?? realSleep,
  });

  const verdict = classifyBytes(outcome);

  if (verdict.status !== 'ok' || !outcome.bytes) {
    return {
      ...verdict,
      url,
      hash: undefined,
      byteLen: outcome.bytes?.length ?? 0,
      width: undefined,
      height: undefined,
      localPath: undefined,
      httpStatus: outcome.httpStatus,
    };
  }

  // Content-address: the hash IS the identity. Two URLs returning identical
  // bytes converge here, which is both the dedup and the poison signal (§5.2).
  const hash = createHash('sha256').update(outcome.bytes).digest('hex');
  const size = readSize(outcome.bytes);
  const ext = EXT_FOR_MIME[verdict.mime ?? ''] ?? 'bin';
  const rel = blobPath(hash, ext);
  const abs = join(opts.outputDir, rel);

  await mkdir(join(opts.outputDir, 'blobs', hash.slice(0, 2)), { recursive: true });
  // Re-run safe: same bytes, same path, same content. Rewriting is a no-op.
  await writeFile(abs, outcome.bytes);

  return {
    ...verdict,
    url,
    hash,
    byteLen: outcome.bytes.length,
    width: size?.width,
    height: size?.height,
    localPath: rel,
    httpStatus: outcome.httpStatus,
  };
}

/**
 * Download a work list, politely.
 *
 * Grouped by host so politeness is per-host: sequential within a host with a
 * delay, hosts in parallel. Fetching 142 images from one wheezing server as fast
 * as possible is rude and gets you blocked; fetching from 161 different servers
 * one at a time would take all day for no reason.
 */
export async function downloadAll(
  urls: readonly string[],
  opts: DownloadOptions,
  onResult?: (a: StoredAsset) => void,
): Promise<StoredAsset[]> {
  const sleep = opts.sleepImpl ?? realSleep;
  const delay = opts.perHostDelayMs ?? 250;

  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    const h = hostOf(u) ?? '(unparseable)';
    byHost.set(h, [...(byHost.get(h) ?? []), u]);
  }

  const queue = [...byHost.values()];
  const results: StoredAsset[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      const group = queue.shift();
      if (!group) return;
      for (let i = 0; i < group.length; i++) {
        if (i > 0) await sleep(delay);
        const a = await fetchAndStore(group[i]!, opts);
        results.push(a);
        onResult?.(a);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency) }, worker));
  return results;
}
