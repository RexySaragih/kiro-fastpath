import { existsSync } from 'node:fs';

export class ClientConstants {
  /** Soft ceiling for any future async client work (local SQLite is sync today). */
  static readonly DEFAULT_TIMEOUT_MS = 30_000;
}

/**
 * Race a promise against an AbortController timeout.
 * Kept for MCP QC / future async backends; sync FastPath calls do not need it yet.
 */
export async function withTimeout<T>(
  work: Promise<T>,
  timeoutMs: number = ClientConstants.DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([
      work,
      new Promise<T>((_, reject) => {
        controller.signal.addEventListener(
          'abort',
          () => reject(new Error(`Operation timed out after ${timeoutMs}ms`)),
          { once: true },
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/\/Users\/[^\s:]+/g, '[path]')
    .replace(/\/Volumes\/[^\s:]+/g, '[path]')
    .replace(/[A-Za-z]:\\[^\s:]+/g, '[path]')
    .slice(0, 500);
}

export function warnIfRepoDotEnvPresent(): void {
  if (existsSync('.env')) {
    console.error(
      '[fastpath-mcp] note: project .env present but ignored — use mcp.json env only',
    );
  }
}
