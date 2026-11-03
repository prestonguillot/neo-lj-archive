import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { MODEL, packSafetensors, type Embedder, type ModelPack } from '../core/index.js';

/**
 * Search by meaning, the build-time half (DESIGN.md §7.4) — OPTIONAL.
 *
 * Only `neo-lj build --embed` reaches this file. It needs the optional package
 * @huggingface/transformers (an optionalDependency); without it, everything else
 * in the tool works exactly as before and the search page stays keyword-only.
 *
 * Loaded by dynamic import with a computed specifier, so neither the type-checker
 * nor the module loader requires the package to exist unless --embed is used.
 */

const PACKAGE = '@huggingface/transformers';

interface Tensor {
  readonly data: Float32Array;
  readonly dims: readonly number[];
}
interface Transformers {
  env: { cacheDir: string; allowRemoteModels: boolean };
  pipeline(
    task: 'feature-extraction',
    model: string,
    opts: { revision: string; dtype: 'fp32' },
  ): Promise<(texts: string[], o: { pooling: 'mean'; normalize: true }) => Promise<Tensor>>;
}

export class MissingOptionalPackage extends Error {
  constructor() {
    super(
      `search by meaning needs the optional package ${PACKAGE}.\n` +
        `  npm install ${PACKAGE}\n` +
        'Everything else works without it; the search page stays keyword-only.',
    );
  }
}

async function load(): Promise<Transformers> {
  try {
    const spec: string = PACKAGE;
    return (await import(spec)) as Transformers;
  } catch {
    throw new MissingOptionalPackage();
  }
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

async function fetchPinned(file: string, expect: string): Promise<Uint8Array> {
  const url = `https://huggingface.co/${MODEL.weights.repo}/resolve/${MODEL.weights.revision}/${file}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  // Pinned by hash, not just revision: the archive ships these weights, so what
  // runs in the browser must be exactly what was verified (§7.4).
  if (sha256(bytes) !== expect) throw new Error(`${file}: checksum mismatch — refusing to use it`);
  return bytes;
}

/** The embedder and browser model for buildSite's optional `embed` dependency. */
export async function semanticDeps(outputDir: string): Promise<{
  embedder: Embedder;
  model: () => Promise<{ pack: ModelPack; source: string }>;
}> {
  const t = await load();
  // The runtime's own model cache lives with the archive (gitignored), not in
  // node_modules, so it survives a reinstall and never enters the repo.
  t.env.cacheDir = join(outputDir, 'models');
  const extract = await t.pipeline('feature-extraction', MODEL.onnx.repo, {
    revision: MODEL.onnx.revision,
    dtype: 'fp32',
  });
  return {
    embedder: async (texts) => {
      const out = await extract([...texts], { pooling: 'mean', normalize: true });
      const dim = out.dims[1] ?? MODEL.config.hidden;
      return texts.map((_, i) => out.data.slice(i * dim, (i + 1) * dim));
    },
    model: async () => {
      const st = await fetchPinned('model.safetensors', MODEL.weights.safetensorsSha256);
      const vocabBytes = await fetchPinned('vocab.txt', MODEL.weights.vocabSha256);
      const vocab = new TextDecoder().decode(vocabBytes).split('\n');
      if (vocab.at(-1) === '') vocab.pop();
      return {
        pack: packSafetensors(st, vocab, MODEL.name, MODEL.config),
        source: `${MODEL.weights.repo}@${MODEL.weights.revision}`,
      };
    },
  };
}
