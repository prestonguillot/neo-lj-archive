import { runInNewContext } from 'node:vm';
import {
  BERT_JS,
  packSafetensors,
  type ModelPack,
  type Embedder,
} from '../../src/core/embed/index.js';

/**
 * A tiny BERT — 4 dimensions, 1 layer — with seeded weights, built as a REAL
 * safetensors file and packed by the real packer. It exercises every path the
 * browser engine has (embeddings, attention, feed-forward, pooling) in
 * milliseconds and kilobytes, so the build and the page can be tested end to end
 * in CI. It knows nothing about meaning; the real model's correctness is checked
 * separately, against the official implementation (embed.test.ts).
 */

const H = 4;
const INTER = 8;
export const TINY_VOCAB = [
  '[PAD]',
  '[UNK]',
  '[CLS]',
  '[SEP]',
  '.',
  ',',
  ':',
  'a',
  'the',
  'and',
  'with',
  'snack',
  'chips',
  'pretzels',
  'cut',
  'reply',
  'depth',
  'day',
  'everything',
];

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** safetensors bytes: u64 header length, JSON header, then f32 data. */
export function safetensors(
  tensors: Record<string, { shape: number[]; data: Float32Array }>,
): Uint8Array {
  let off = 0;
  const header: Record<string, unknown> = {};
  for (const [k, t] of Object.entries(tensors)) {
    header[k] = { dtype: 'F32', shape: t.shape, data_offsets: [off, off + t.data.byteLength] };
    off += t.data.byteLength;
  }
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(8 + json.length + off);
  new DataView(out.buffer).setBigUint64(0, BigInt(json.length), true);
  out.set(json, 8);
  let at = 8 + json.length;
  for (const t of Object.values(tensors)) {
    out.set(new Uint8Array(t.data.buffer, t.data.byteOffset, t.data.byteLength), at);
    at += t.data.byteLength;
  }
  return out;
}

export function tinyPack(): ModelPack {
  const r = seeded(7);
  const rand = (n: number, s = 0.5): Float32Array =>
    Float32Array.from({ length: n }, () => r() * s);
  const ones = (n: number): Float32Array => new Float32Array(n).fill(1);
  const t = (shape: number[], data: Float32Array) => ({ shape, data });
  const L = 'encoder.layer.0.';
  const st = safetensors({
    'embeddings.word_embeddings.weight': t([TINY_VOCAB.length, H], rand(TINY_VOCAB.length * H, 1)),
    'embeddings.position_embeddings.weight': t([64, H], rand(64 * H, 0.1)),
    'embeddings.token_type_embeddings.weight': t([2, H], rand(2 * H, 0.1)),
    'embeddings.LayerNorm.weight': t([H], ones(H)),
    'embeddings.LayerNorm.bias': t([H], new Float32Array(H)),
    [L + 'attention.self.query.weight']: t([H, H], rand(H * H)),
    [L + 'attention.self.query.bias']: t([H], rand(H, 0.1)),
    [L + 'attention.self.key.weight']: t([H, H], rand(H * H)),
    [L + 'attention.self.key.bias']: t([H], rand(H, 0.1)),
    [L + 'attention.self.value.weight']: t([H, H], rand(H * H)),
    [L + 'attention.self.value.bias']: t([H], rand(H, 0.1)),
    [L + 'attention.output.dense.weight']: t([H, H], rand(H * H)),
    [L + 'attention.output.dense.bias']: t([H], rand(H, 0.1)),
    [L + 'attention.output.LayerNorm.weight']: t([H], ones(H)),
    [L + 'attention.output.LayerNorm.bias']: t([H], new Float32Array(H)),
    [L + 'intermediate.dense.weight']: t([INTER, H], rand(INTER * H)),
    [L + 'intermediate.dense.bias']: t([INTER], rand(INTER, 0.1)),
    [L + 'output.dense.weight']: t([H, INTER], rand(H * INTER)),
    [L + 'output.dense.bias']: t([H], rand(H, 0.1)),
    [L + 'output.LayerNorm.weight']: t([H], ones(H)),
    [L + 'output.LayerNorm.bias']: t([H], new Float32Array(H)),
    // Present in real checkpoints, unused by sentence embeddings: must be skipped.
    'pooler.dense.weight': t([H, H], rand(H * H)),
    'pooler.dense.bias': t([H], rand(H)),
  });
  return packSafetensors(st, TINY_VOCAB, 'tiny', {
    layers: 1,
    hidden: H,
    heads: 1,
    pooling: 'mean',
  });
}

/** The browser engine itself, loaded as the page loads it — a classic script. */
export function engine(pack: ModelPack): {
  embed(text: string): Float32Array;
  tokenize(text: string, max: number): number[];
} {
  const g: { NeoBert?: { load(p: unknown): never } } = {};
  runInNewContext(BERT_JS, { globalThis: g, window: g });
  return g.NeoBert!.load({
    meta: { tensors: pack.tensors, config: pack.config },
    bytes: pack.bytes,
    vocab: pack.vocab,
  });
}

/** An embedder that runs the tiny model through the browser engine, and counts. */
export function tinyEmbedder(pack: ModelPack): { embedder: Embedder; calls: () => number } {
  const m = engine(pack);
  let calls = 0;
  return {
    embedder: async (texts) => {
      calls += texts.length;
      return texts.map((x) => m.embed(x));
    },
    calls: () => calls,
  };
}
