import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { embedText, HASH_EMBED_DIM, l2Normalize } from './hash.js';

export type EmbedBackendName = 'minilm' | 'hash';

export const MINILM_DIM = 384;
export const MINILM_MODEL = 'Xenova/all-MiniLM-L6-v2';

const EMBED_BATCH = 32;

let pipelinePromise: Promise<EmbedFn> | null = null;
let activeBackend: EmbedBackendName = 'hash';
let activeDim = HASH_EMBED_DIM;

type EmbedFn = (texts: string[]) => Promise<Float32Array[]>;

function resolveRequestedBackend(): EmbedBackendName {
  const raw = (process.env.FASTPATH_EMBED || 'auto').toLowerCase().trim();
  if (raw === 'hash' || raw === 'feature-hash') return 'hash';
  if (raw === 'minilm' || raw === 'onnx' || raw === 'hf') return 'minilm';
  return 'minilm'; // auto → prefer real model, fall back in ensureEmbedder
}

export function modelCacheDir(): string {
  const override = process.env.FASTPATH_MODEL_CACHE?.trim();
  if (override) return override;
  return join(homedir(), '.fastpath', 'models');
}

function cacheDir(): string {
  return modelCacheDir();
}

/** True when Hugging Face cache looks like MiniLM weights were downloaded. */
export function minilmWeightsPresent(): boolean {
  const dir = modelCacheDir();
  if (!existsSync(dir)) return false;
  const needle = 'all-MiniLM-L6-v2';
  try {
    for (const name of readdirSync(dir)) {
      if (name.includes(needle) || name.includes('Xenova')) return true;
    }
    // Nested HF hub layout
    const hub = join(dir, 'Xenova');
    if (existsSync(hub)) return true;
  } catch {
    return false;
  }
  return false;
}

async function loadMiniLm(): Promise<EmbedFn> {
  mkdirSync(cacheDir(), { recursive: true });
  const { pipeline, env } = await import('@huggingface/transformers');
  env.cacheDir = cacheDir();
  env.allowLocalModels = true;

  const extractor = await pipeline('feature-extraction', MINILM_MODEL, {
    dtype: 'fp32',
  });

  return async (texts: string[]) => {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH);
      for (const text of batch) {
        const truncated = text.slice(0, 2000);
        const result = await extractor(truncated, {
          pooling: 'mean',
          normalize: true,
        });
        const data = Array.from(result.data as Float32Array | number[]);
        out.push(l2Normalize(Float32Array.from(data)));
      }
    }
    return out;
  };
}

async function ensureEmbedder(): Promise<EmbedFn> {
  if (pipelinePromise) return pipelinePromise;

  const requested = resolveRequestedBackend();
  if (requested === 'hash') {
    activeBackend = 'hash';
    activeDim = HASH_EMBED_DIM;
    pipelinePromise = Promise.resolve(async (texts: string[]) =>
      texts.map((t) => embedText(t, HASH_EMBED_DIM)),
    );
    return pipelinePromise;
  }

  pipelinePromise = loadMiniLm()
    .then((fn) => {
      activeBackend = 'minilm';
      activeDim = MINILM_DIM;
      return fn;
    })
    .catch((err) => {
      console.error(
        '[fastpath] MiniLM embedder unavailable, falling back to feature-hash:',
        err instanceof Error ? err.message : err,
      );
      activeBackend = 'hash';
      activeDim = HASH_EMBED_DIM;
      return async (texts: string[]) => texts.map((t) => embedText(t, HASH_EMBED_DIM));
    });

  return pipelinePromise;
}

export function getEmbedBackend(): EmbedBackendName {
  return activeBackend;
}

export function getEmbedDim(): number {
  return activeDim;
}

/** Embed one string (async — may download MiniLM on first call). */
export async function embedQuery(text: string): Promise<Float32Array> {
  const fn = await ensureEmbedder();
  const [vec] = await fn([text]);
  return vec ?? embedText(text, activeDim);
}

/** Embed many strings with batching. */
export async function embedMany(texts: string[]): Promise<Float32Array[]> {
  if (!texts.length) return [];
  const fn = await ensureEmbedder();
  return fn(texts);
}

/** Warm the embedder (download model) without indexing. */
export async function warmEmbedder(): Promise<{
  backend: EmbedBackendName;
  dim: number;
}> {
  await ensureEmbedder();
  return { backend: activeBackend, dim: activeDim };
}

/** Reset cached pipeline (tests). */
export function resetEmbedderForTests(): void {
  pipelinePromise = null;
  activeBackend = 'hash';
  activeDim = HASH_EMBED_DIM;
}
