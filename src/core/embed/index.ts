import { createHash } from 'node:crypto';

/**
 * Search by meaning (DESIGN.md §7.4) — the parts that live in the archive.
 *
 * Everything here is OPTIONAL. The build only uses it when vectors exist in
 * archive.db, and only `neo-lj build --embed` (with the optional package
 * installed) ever computes them. Without them the search page is exactly the
 * keyword search it always was.
 *
 * The browser side has no runtime: BERT_JS is a few hundred lines of plain
 * JavaScript that runs the model's own published weights. Measured against the
 * official implementation, it produces identical token ids and embeddings
 * (cosine 1.000000 at f32; ≥ 0.996 with the int8 weights the archive ships).
 */

/** The one model this archive uses. Pinned: a build cannot drift to new weights. */
export const MODEL = {
  name: 'all-MiniLM-L6-v2',
  /** Published weights, packed for the browser. */
  weights: {
    repo: 'sentence-transformers/all-MiniLM-L6-v2',
    revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41',
    safetensorsSha256: '53aa51172d142c89d9012cce15ae4d6cc0ca6895895114379cacb4fab128d9db',
    vocabSha256: '07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3',
  },
  /** The ONNX export the build-time runtime embeds passages with. Same model. */
  onnx: { repo: 'Xenova/all-MiniLM-L6-v2', revision: '751bff37182d3f1213fa05d7196b954e230abad9' },
  config: { layers: 6, hidden: 384, heads: 12, pooling: 'mean' as const },
} as const;

export interface PackedTensor {
  readonly dtype: 'f32' | 'int8';
  readonly shape: readonly number[];
  readonly size: number;
  readonly offset: number;
  readonly scaleOffset?: number;
}

/** A model as the browser loads it: a byte blob plus the table that reads it. */
export interface ModelPack {
  readonly name: string;
  readonly config: { layers: number; hidden: number; heads: number; pooling: 'mean' | 'cls' };
  readonly tensors: Record<string, PackedTensor>;
  readonly vocab: readonly string[];
  readonly bytes: Uint8Array;
}

/**
 * Pack safetensors weights for the browser: 2-D weights as int8 with a per-row
 * scale (4x smaller, measured ≥ 0.996 cosine), everything else f32. The pooler
 * and position-id buffers are unused by sentence embeddings and left out.
 */
export function packSafetensors(
  st: Uint8Array,
  vocab: readonly string[],
  name: string,
  config: ModelPack['config'],
): ModelPack {
  const view = new DataView(st.buffer, st.byteOffset, st.byteLength);
  const headerLen = Number(view.getBigUint64(0, true));
  const header = JSON.parse(new TextDecoder().decode(st.subarray(8, 8 + headerLen))) as Record<
    string,
    { dtype: string; shape: number[]; data_offsets: [number, number] }
  >;
  const data = st.subarray(8 + headerLen);
  const parts: Uint8Array[] = [];
  let off = 0;
  const push = (b: Uint8Array): number => {
    const pad = (4 - (off % 4)) % 4;
    if (pad) {
      parts.push(new Uint8Array(pad));
      off += pad;
    }
    const at = off;
    parts.push(b);
    off += b.length;
    return at;
  };
  const tensors: Record<string, PackedTensor> = {};
  for (const [key, t] of Object.entries(header)) {
    if (key === '__metadata__' || key.startsWith('pooler.') || key === 'embeddings.position_ids')
      continue;
    if (t.dtype !== 'F32') throw new Error(`${key}: expected F32 weights, got ${t.dtype}`);
    const raw = data.subarray(t.data_offsets[0], t.data_offsets[1]);
    const f = new Float32Array(raw.slice().buffer);
    const quant = t.shape.length === 2 && key !== 'embeddings.token_type_embeddings.weight';
    if (!quant) {
      tensors[key] = {
        dtype: 'f32',
        shape: t.shape,
        size: f.length,
        offset: push(new Uint8Array(f.buffer)),
      };
      continue;
    }
    const [rows, cols] = t.shape as [number, number];
    const q = new Int8Array(f.length);
    const sc = new Float32Array(rows);
    for (let r = 0; r < rows; r++) {
      let m = 0;
      for (let c = 0; c < cols; c++) m = Math.max(m, Math.abs(f[r * cols + c]!));
      const s = m / 127 || 1;
      sc[r] = s;
      for (let c = 0; c < cols; c++) q[r * cols + c] = Math.round(f[r * cols + c]! / s);
    }
    const offset = push(new Uint8Array(q.buffer));
    tensors[key] = {
      dtype: 'int8',
      shape: t.shape,
      size: f.length,
      offset,
      scaleOffset: push(new Uint8Array(sc.buffer)),
    };
  }
  const bytes = new Uint8Array(off);
  let at = 0;
  for (const p of parts) {
    bytes.set(p, at);
    at += p.length;
  }
  return { name, config, tensors, vocab, bytes };
}

/** A unit vector as int8 plus one scale: 384 bytes instead of 1,536. */
export function quantize(v: ArrayLike<number>): { scale: number; q: Int8Array } {
  let m = 0;
  for (let i = 0; i < v.length; i++) m = Math.max(m, Math.abs(v[i]!));
  const scale = m / 127 || 1;
  const q = new Int8Array(v.length);
  for (let i = 0; i < v.length; i++) q[i] = Math.round(v[i]! / scale);
  return { scale, q };
}

/**
 * The passages a record is searched as. The model reads ~256 tokens at a time,
 * and a long entry is about several things — it should match on its best
 * passage, not on an average of all of them. ~150 words, overlapping by 30.
 */
export function passages(head: string, text: string): string[] {
  const words = `${head}. ${text}`.split(/\s+/).filter(Boolean);
  if (words.length <= 150) return [words.join(' ')];
  const out: string[] = [];
  for (let s = 0; s < words.length; s += 120) out.push(words.slice(s, s + 150).join(' '));
  return out;
}

/** Vectors are keyed by what they encode, so a passage is embedded once, ever. */
export const passageKey = (model: string, text: string): string =>
  createHash('sha256').update(model).update('\0').update(text).digest('hex');

/** Turns passages into unit vectors. Supplied by the shell; core never loads a model. */
export type Embedder = (texts: readonly string[]) => Promise<Float32Array[]>;

const b64 = (u: Uint8Array): string =>
  Buffer.from(u.buffer, u.byteOffset, u.byteLength).toString('base64');

/** search/model.js: the packed model as a classic script assigning a global. */
export function modelJs(p: ModelPack): string {
  return `window.NEO_MODEL=${JSON.stringify({ meta: { tensors: p.tensors, config: p.config }, vocab: p.vocab })};window.NEO_MODEL.b64="${b64(p.bytes)}";\n`;
}

/**
 * search/vectors.js: one row per passage — which record it belongs to, its scale,
 * and its int8 vector — packed as owner(int32[n]) | scale(f32[n]) | q(int8[n*dim]).
 */
export function vectorsJs(
  dim: number,
  rows: readonly { owner: number; scale: number; q: Int8Array }[],
): string {
  const n = rows.length;
  const buf = new Uint8Array(n * 8 + n * dim);
  const owner = new Int32Array(buf.buffer, 0, n);
  const scale = new Float32Array(buf.buffer, n * 4, n);
  const q = new Int8Array(buf.buffer, n * 8, n * dim);
  rows.forEach((r, i) => {
    owner[i] = r.owner;
    scale[i] = r.scale;
    q.set(r.q, i * dim);
  });
  return `window.NEO_VECTORS={n:${n},dim:${dim},b64:"${b64(buf)}"};\n`;
}

/** search/bert.js, shipped verbatim. Tests evaluate this exact string. */
export const BERT_JS = String.raw`/* BERT-family sentence embeddings in plain JavaScript (DESIGN.md §7.4).
 *
 * A classic script, no imports, no WebAssembly, no workers: it runs from file://
 * in every browser engine, and in Node via vm. Defines globalThis.NeoBert.
 *
 *   const m = NeoBert.load(pack)  // pack: { meta, bytes: Uint8Array, vocab: string[] }
 *   m.embed('some text')          // Float32Array(384), L2-normalised
 *
 * Weights arrive as a byte blob plus a table: each tensor is f32, or int8 with a
 * per-row f32 scale (row = output unit, so dequantising is one multiply per row).
 */
(function (root) {
  'use strict';

  // ---- tokenizer: BERT BasicTokenizer + WordPiece, uncased ------------------
  function isPunct(cp) {
    if ((cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126)) return true;
    return /\p{P}/u.test(String.fromCodePoint(cp));
  }
  function isCjk(cp) {
    return (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x20000 && cp <= 0x2a6df) ||
      (cp >= 0x2a700 && cp <= 0x2b73f) || (cp >= 0x2b740 && cp <= 0x2b81f) || (cp >= 0x2b820 && cp <= 0x2ceaf) ||
      (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0x2f800 && cp <= 0x2fa1f);
  }
  function isControl(ch) {
    if (ch === '\t' || ch === '\n' || ch === '\r') return false;
    return /\p{C}/u.test(ch);
  }
  function basicTokens(text) {
    let s = '';
    for (const ch of text) {
      const cp = ch.codePointAt(0);
      if (cp === 0 || cp === 0xfffd || isControl(ch)) continue;
      if (/\s/u.test(ch)) s += ' ';
      else if (isCjk(cp)) s += ' ' + ch + ' ';
      else s += ch;
    }
    const out = [];
    for (let w of s.trim().split(/\s+/)) {
      if (w === '') continue;
      w = w.toLowerCase().normalize('NFD').replace(/\p{Mn}/gu, '');
      let cur = '';
      for (const ch of w) {
        if (isPunct(ch.codePointAt(0))) {
          if (cur) out.push(cur);
          out.push(ch);
          cur = '';
        } else cur += ch;
      }
      if (cur) out.push(cur);
    }
    return out;
  }
  function wordpiece(word, vocab) {
    if ([...word].length > 100) return [vocab.get('[UNK]')];
    const ids = [];
    let start = 0;
    while (start < word.length) {
      let end = word.length, id;
      while (start < end) {
        const sub = (start > 0 ? '##' : '') + word.slice(start, end);
        id = vocab.get(sub);
        if (id !== undefined) break;
        end--;
        // never split a surrogate pair
        if (end > start && word.charCodeAt(end) >= 0xdc00 && word.charCodeAt(end) <= 0xdfff) end--;
      }
      if (id === undefined) return [vocab.get('[UNK]')];
      ids.push(id);
      start = end;
    }
    return ids;
  }

  // ---- maths ---------------------------------------------------------------
  // erf, Abramowitz & Stegun 7.1.26 (|error| < 1.5e-7) — exact GELU, as BERT uses.
  function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
  }
  function layerNorm(x, n, d, g, b, eps) {
    for (let i = 0; i < n; i++) {
      const o = i * d; let mean = 0, v = 0;
      for (let j = 0; j < d; j++) mean += x[o + j];
      mean /= d;
      for (let j = 0; j < d; j++) { const t = x[o + j] - mean; v += t * t; }
      const inv = 1 / Math.sqrt(v / d + eps);
      for (let j = 0; j < d; j++) x[o + j] = (x[o + j] - mean) * inv * g[j] + b[j];
    }
  }

  function load(pack) {
    const { meta, bytes } = pack;
    const vocab = new Map(pack.vocab.map((w, i) => [w, i]));
    const T = {};
    for (const [name, t] of Object.entries(meta.tensors)) {
      if (t.dtype === 'f32') T[name] = { f: new Float32Array(bytes.buffer.slice(bytes.byteOffset + t.offset, bytes.byteOffset + t.offset + t.size * 4)), shape: t.shape };
      else T[name] = {
        q: new Int8Array(bytes.buffer, bytes.byteOffset + t.offset, t.size),
        s: new Float32Array(bytes.buffer.slice(bytes.byteOffset + t.scaleOffset, bytes.byteOffset + t.scaleOffset + t.shape[0] * 4)),
        shape: t.shape,
      };
    }
    const f = (n) => T[n].f;
    const cfg = meta.config;

    // y[n,out] = x[n,in] · W[out,in]^T + b
    //
    // Register-blocked: each weight row is read once per FOUR tokens rather than
    // once per token, and four independent accumulators keep the CPU busy. Same
    // arithmetic, same order of additions per output — so the same answer.
    function linear(x, n, name) {
      const W = T[name + '.weight'], b = f(name + '.bias');
      const [out, inn] = W.shape, y = new Float32Array(n * out);
      const w = W.q || W.f;
      for (let o = 0; o < out; o++) {
        const row = o * inn, s = W.q ? W.s[o] : 1, bo = b[o];
        let i = 0;
        for (; i + 3 < n; i += 4) {
          const x0 = i * inn, x1 = x0 + inn, x2 = x1 + inn, x3 = x2 + inn;
          let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
          for (let k = 0; k < inn; k++) {
            const wk = w[row + k];
            a0 += x[x0 + k] * wk; a1 += x[x1 + k] * wk; a2 += x[x2 + k] * wk; a3 += x[x3 + k] * wk;
          }
          y[i * out + o] = a0 * s + bo; y[(i + 1) * out + o] = a1 * s + bo;
          y[(i + 2) * out + o] = a2 * s + bo; y[(i + 3) * out + o] = a3 * s + bo;
        }
        for (; i < n; i++) {
          const xo = i * inn; let a = 0;
          for (let k = 0; k < inn; k++) a += x[xo + k] * w[row + k];
          y[i * out + o] = a * s + bo;
        }
      }
      return y;
    }
    function rowOf(name, r) {
      const t = T[name], d = t.shape[1], out = new Float32Array(d);
      if (t.q) { const s = t.s[r]; for (let j = 0; j < d; j++) out[j] = t.q[r * d + j] * s; }
      else out.set(t.f.subarray(r * d, (r + 1) * d));
      return out;
    }

    function tokenize(text, maxLen) {
      const ids = [vocab.get('[CLS]')];
      for (const w of basicTokens(text)) for (const id of wordpiece(w, vocab)) ids.push(id);
      if (ids.length > maxLen - 1) ids.length = maxLen - 1;
      ids.push(vocab.get('[SEP]'));
      return ids;
    }

    function embed(text, maxLen) {
      const ids = tokenize(text, maxLen || 256), n = ids.length, D = cfg.hidden, H = cfg.heads, dh = D / H;
      let x = new Float32Array(n * D);
      const tt = rowOf('embeddings.token_type_embeddings.weight', 0);
      for (let i = 0; i < n; i++) {
        const w = rowOf('embeddings.word_embeddings.weight', ids[i]), p = rowOf('embeddings.position_embeddings.weight', i);
        for (let j = 0; j < D; j++) x[i * D + j] = w[j] + p[j] + tt[j];
      }
      layerNorm(x, n, D, f('embeddings.LayerNorm.weight'), f('embeddings.LayerNorm.bias'), 1e-12);
      for (let l = 0; l < cfg.layers; l++) {
        const P = 'encoder.layer.' + l + '.';
        const q = linear(x, n, P + 'attention.self.query'), k = linear(x, n, P + 'attention.self.key'), v = linear(x, n, P + 'attention.self.value');
        const ctx = new Float32Array(n * D), sc = new Float32Array(n), scale = 1 / Math.sqrt(dh);
        for (let h = 0; h < H; h++) {
          const ho = h * dh;
          for (let i = 0; i < n; i++) {
            let max = -Infinity;
            for (let j = 0; j < n; j++) {
              let s = 0; for (let d = 0; d < dh; d++) s += q[i * D + ho + d] * k[j * D + ho + d];
              s *= scale; sc[j] = s; if (s > max) max = s;
            }
            let sum = 0; for (let j = 0; j < n; j++) { sc[j] = Math.exp(sc[j] - max); sum += sc[j]; }
            for (let j = 0; j < n; j++) { const a = sc[j] / sum; for (let d = 0; d < dh; d++) ctx[i * D + ho + d] += a * v[j * D + ho + d]; }
          }
        }
        const ao = linear(ctx, n, P + 'attention.output.dense');
        for (let i = 0; i < ao.length; i++) ao[i] += x[i];
        layerNorm(ao, n, D, f(P + 'attention.output.LayerNorm.weight'), f(P + 'attention.output.LayerNorm.bias'), 1e-12);
        const inter = linear(ao, n, P + 'intermediate.dense');
        for (let i = 0; i < inter.length; i++) { const t = inter[i]; inter[i] = 0.5 * t * (1 + erf(t / Math.SQRT2)); }
        const o = linear(inter, n, P + 'output.dense');
        for (let i = 0; i < o.length; i++) o[i] += ao[i];
        layerNorm(o, n, D, f(P + 'output.LayerNorm.weight'), f(P + 'output.LayerNorm.bias'), 1e-12);
        x = o;
      }
      // pooling as the model was trained: the [CLS] token, or the mean of all tokens
      const out = new Float32Array(D);
      if (cfg.pooling === 'cls') out.set(x.subarray(0, D));
      else for (let i = 0; i < n; i++) for (let j = 0; j < D; j++) out[j] += x[i * D + j] / n;
      let norm = 0; for (let j = 0; j < D; j++) norm += out[j] * out[j];
      norm = Math.sqrt(norm) || 1; for (let j = 0; j < D; j++) out[j] /= norm;
      return out;
    }

    return { embed: embed, tokenize: tokenize };
  }

  root.NeoBert = { load: load };
})(typeof window !== 'undefined' ? window : globalThis);
`;
