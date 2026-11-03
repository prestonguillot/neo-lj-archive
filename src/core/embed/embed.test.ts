import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { MODEL, passages, quantize, passageKey, vectorsJs, packSafetensors } from './index.js';
import { engine, safetensors, tinyPack } from '../../../tests/support/tiny-model.js';
import { Store } from '../store/db.js';

/**
 * Search by meaning — the engine (DESIGN.md §7.4).
 *
 * The oracle is the OFFICIAL implementation: token ids and vectors produced by
 * transformers.js for the same model, committed as a fixture
 * (tests/fixtures/minilm-reference.json), with the model's published vocabulary.
 */
const fixtures = new URL('../../../tests/fixtures/', import.meta.url);
const vocab = readFileSync(new URL('minilm-vocab.txt', fixtures), 'utf8').split('\n');
if (vocab.at(-1) === '') vocab.pop();
const ref = JSON.parse(readFileSync(new URL('minilm-reference.json', fixtures), 'utf8')) as {
  cases: { text: string; ids: number[]; vector: number[] }[];
};

describe('the tokenizer, against the official one', () => {
  // The tokenizer needs only the vocabulary; no weights are loaded for this.
  const tok = engine({ ...tinyPack(), vocab });

  // catches: any divergence from BERT's tokenizer — accents not stripped, curly
  // quotes or CJK split differently, a long word not broken into ##pieces. Every
  // wrong id is a different input to the model, and no error anywhere.
  it.each(ref.cases.map((c) => [c.text.slice(0, 40), c] as const))('%s', (_l, c) => {
    expect(tok.tokenize(c.text, 512)).toEqual(c.ids);
  });
});

// The full model is ~90 MB and lives in archive.db after `neo-lj build --embed`,
// not in the repo — so this oracle check runs where that archive exists, and is
// skipped (not faked) everywhere else, including CI.
const DB = join(process.cwd(), 'archive', 'archive.db');
const local = existsSync(DB)
  ? (() => {
      const s = Store.open(join(process.cwd(), 'archive'));
      try {
        return s.getModel(MODEL.name);
      } finally {
        s.close();
      }
    })()
  : undefined;

describe.skipIf(local === undefined)('the browser engine, against the official model', () => {
  // catches: the engine computing something that isn't MiniLM — a wrong
  // activation, LayerNorm epsilon, attention scale, or pooling. Measured: the
  // int8-packed weights stay within 0.996 cosine of the fp32 official vectors.
  it.each(ref.cases.map((c) => [c.text.slice(0, 40), c] as const))('%s', (_l, c) => {
    const v = engine(local!).embed(c.text);
    let cos = 0;
    for (let i = 0; i < v.length; i++) cos += v[i]! * c.vector[i]!;
    expect(cos).toBeGreaterThan(0.995);
  });
});

describe('packSafetensors', () => {
  const W = Float32Array.from([1, -2, 0.5, 4, 0, -4]); // 2 rows x 3
  const st = safetensors({
    'enc.dense.weight': { shape: [2, 3], data: W },
    'enc.dense.bias': { shape: [2], data: Float32Array.from([0.25, -0.75]) },
    'pooler.dense.weight': { shape: [2, 2], data: new Float32Array(4) },
  });
  const p = packSafetensors(st, ['a'], 't', { layers: 0, hidden: 2, heads: 1, pooling: 'mean' });

  // catches: per-tensor instead of per-ROW scales — one large row would crush
  // every other row's precision to a handful of levels.
  it('quantizes 2-D weights per row, each row to its own full int8 range', () => {
    const t = p.tensors['enc.dense.weight']!;
    expect(t.dtype).toBe('int8');
    const q = new Int8Array(p.bytes.buffer, p.bytes.byteOffset + t.offset, 6);
    const sc = new Float32Array(p.bytes.slice(t.scaleOffset!, t.scaleOffset! + 8).buffer);
    expect([...q]).toEqual([64, -127, 32, 127, 0, -127]);
    expect(sc[0]).toBeCloseTo(2 / 127, 7);
    expect(sc[1]).toBeCloseTo(4 / 127, 7);
  });

  it('keeps 1-D tensors exact and leaves the unused pooler out', () => {
    const b = p.tensors['enc.dense.bias']!;
    expect(b.dtype).toBe('f32');
    expect([...new Float32Array(p.bytes.slice(b.offset, b.offset + 8).buffer)]).toEqual([
      0.25, -0.75,
    ]);
    expect(p.tensors['pooler.dense.weight']).toBeUndefined();
  });

  // catches: half-precision weights read as if they were f32 — garbage, silently.
  it('refuses weights that are not f32', () => {
    const bad = safetensors({ x: { shape: [1], data: new Float32Array(1) } });
    const s = new TextDecoder().decode(bad).replace('"F32"', '"F16"');
    expect(() =>
      packSafetensors(new TextEncoder().encode(s), [], 't', {
        layers: 0,
        hidden: 1,
        heads: 1,
        pooling: 'mean',
      }),
    ).toThrow(/F16/);
  });
});

describe('quantize', () => {
  it('maps the largest component to ±127 and stays within one step', () => {
    const v = [0.5, -0.25, 0.1, -0.5];
    const { scale, q } = quantize(v);
    expect(Math.max(...[...q].map(Math.abs))).toBe(127);
    v.forEach((x, i) => expect(Math.abs(q[i]! * scale - x)).toBeLessThanOrEqual(scale / 2 + 1e-9));
  });
});

describe('passages', () => {
  const text = Array.from({ length: 400 }, (_, i) => `w${i}`).join(' ');

  // catches: chunking that drops text — every word must land in some passage, or
  // the end of a long entry can never be found by meaning.
  it('covers every word of a long record', () => {
    const ps = passages('Title', text);
    const seen = new Set(ps.flatMap((p) => p.split(' ')));
    for (let i = 0; i < 400; i++) expect(seen.has(`w${i}`)).toBe(true);
    expect(ps.every((p) => p.split(' ').length <= 150)).toBe(true);
  });

  it('keeps a short record whole, title first', () => {
    expect(passages('Title', 'a few words')).toEqual(['Title. a few words']);
  });

  // catches: vectors keyed by position instead of content — reordering entries
  // or editing one would attach the wrong vectors to the wrong text.
  it('keys a passage by model and text, nothing else', () => {
    expect(passageKey('m', 'x')).toBe(passageKey('m', 'x'));
    expect(passageKey('m', 'x')).not.toBe(passageKey('m', 'y'));
    expect(passageKey('m', 'x')).not.toBe(passageKey('n', 'x'));
  });
});

describe('vectorsJs', () => {
  it('evaluates as a classic script to the rows it was given', () => {
    const js = vectorsJs(2, [
      { owner: 3, scale: 0.5, q: Int8Array.from([1, -2]) },
      { owner: 0, scale: 0.25, q: Int8Array.from([127, 0]) },
    ]);
    const w: { NEO_VECTORS?: { n: number; dim: number; b64: string } } = {};
    new Function('window', js)(w);
    const b = Buffer.from(w.NEO_VECTORS!.b64, 'base64');
    expect(w.NEO_VECTORS!.n).toBe(2);
    expect([...new Int32Array(b.buffer, b.byteOffset, 2)]).toEqual([3, 0]);
    expect([...new Float32Array(b.buffer.slice(b.byteOffset + 8, b.byteOffset + 16))]).toEqual([
      0.5, 0.25,
    ]);
    expect([...new Int8Array(b.buffer, b.byteOffset + 16, 4)]).toEqual([1, -2, 127, 0]);
  });
});
