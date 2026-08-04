import { existsSync } from 'node:fs';

export function sanitizeErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/\/Users\/[^\s:]+/g, '[path]')
    .replace(/\/home\/[^\s:]+/g, '[path]')
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
