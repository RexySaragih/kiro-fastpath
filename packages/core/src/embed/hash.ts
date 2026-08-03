import { createHash } from 'node:crypto';
import { tokenizeIdentifier } from '../tokenize.js';

/** Feature-hash dim (fallback backend). MiniLM uses 384. */
export const HASH_EMBED_DIM = 256;
/** @deprecated use HASH_EMBED_DIM — kept for older imports */
export const EMBED_DIM = HASH_EMBED_DIM;

/** Deterministic feature-hash embedding — offline, no model download. */
export function embedText(text: string, dim = HASH_EMBED_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = tokenizeIdentifier(text).split(/\s+/).filter(Boolean);
  if (!tokens.length) return vec;

  for (const token of tokens) {
    const h = createHash('sha256').update(token).digest();
    const idx = h.readUInt32BE(0) % dim;
    const sign = (h[4]! & 1) === 0 ? 1 : -1;
    vec[idx]! += sign;
    const idx2 = h.readUInt32BE(8) % dim;
    const sign2 = (h[12]! & 1) === 0 ? 1 : -1;
    vec[idx2]! += sign2 * 0.5;
  }

  return l2Normalize(vec);
}

export function l2Normalize(vec: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < vec.length; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vec.length; i++) vec[i]! /= norm;
  return vec;
}

export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function blobToVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
