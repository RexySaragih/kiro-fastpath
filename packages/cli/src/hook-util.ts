/**
 * Shared helpers for Kiro hook entrypoints (prompt-inject, file-event,
 * session-start, guardrail). Hooks receive JSON on STDIN and must never
 * block the user — callers always exit 0 unless intentionally blocking.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { userFastpathDir } from './config.js';

export interface HookPayload {
  prompt?: string;
  cwd?: string;
  hook_event_name?: string;
  session_id?: string;
  tool_name?: string;
  toolName?: string;
  file_path?: string;
  filePath?: string;
  path?: string;
  files?: string[];
  [key: string]: unknown;
}

export async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseHookPayload(raw: string): HookPayload {
  try {
    return raw.trim() ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    return {};
  }
}

export function workspaceFromPayload(payload: HookPayload): string {
  return (
    process.env.FASTPATH_WORKSPACE?.trim() ||
    payload.cwd?.trim() ||
    process.cwd()
  );
}

/**
 * File paths from a hook payload. Kiro versions differ on the field name,
 * so check the known variants plus env fallbacks.
 */
export function extractFilePaths(payload: HookPayload): string[] {
  const single =
    payload.file_path ||
    payload.filePath ||
    payload.path ||
    process.env.KIRO_FILE_PATH ||
    process.env.FILE_PATH ||
    '';
  const out: string[] = [];
  if (typeof single === 'string' && single.trim()) out.push(single.trim());
  if (Array.isArray(payload.files)) {
    for (const f of payload.files) {
      if (typeof f === 'string' && f.trim()) out.push(f.trim());
    }
  }
  return [...new Set(out)];
}

export function writeContext(body: string): void {
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
}

/** Resolve-only race: never rejects; reports whether the budget expired. */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<{ value?: T; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  return new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise
      .then((value) => {
        if (timer) clearTimeout(timer);
        resolve({ value, timedOut: false });
      })
      .catch(() => {
        if (timer) clearTimeout(timer);
        resolve({ timedOut: true });
      });
  });
}

/* ---------------------------------------------------------------------------
 * Payload discovery (FASTPATH_HOOK_DEBUG=1)
 * The hook payload contract is version-dependent and currently guessed. One
 * debug session resolves it: capture raw stdin + env key names (values never
 * recorded) to a capped JSONL file.
 * ------------------------------------------------------------------------ */

const PAYLOAD_LOG_MAX_LINES = 200;
const PAYLOAD_RAW_MAX_CHARS = 4000;
const HOOK_ENV_PREFIXES = ['KIRO', 'FASTPATH', 'USER_PROMPT', 'HOOK', 'TOOL', 'FILE'];

export function hookDebugEnabled(): boolean {
  return process.env.FASTPATH_HOOK_DEBUG === '1';
}

export function hookPayloadLogPath(): string {
  return join(userFastpathDir(), 'hook-payloads.jsonl');
}

function candidateEnvKeys(): string[] {
  return Object.keys(process.env)
    .filter((k) => HOOK_ENV_PREFIXES.some((p) => k.toUpperCase().startsWith(p)))
    .sort();
}

function appendCapped(path: string, line: string, maxLines: number): void {
  appendFileSync(path, line);
  const body = readFileSync(path, 'utf8').split('\n').filter(Boolean);
  if (body.length > maxLines) {
    writeFileSync(path, `${body.slice(-maxLines).join('\n')}\n`);
  }
}

/** Record the raw hook payload for contract discovery. No-op unless debugging. */
export function recordHookPayload(hook: string, raw: string, payload: HookPayload): void {
  if (!hookDebugEnabled()) return;
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    appendCapped(
      hookPayloadLogPath(),
      `${JSON.stringify({
        at: new Date().toISOString(),
        hook,
        argv: process.argv.slice(2),
        rawLength: raw.length,
        raw: raw.slice(0, PAYLOAD_RAW_MAX_CHARS),
        payloadKeys: Object.keys(payload),
        envKeys: candidateEnvKeys(),
      })}\n`,
      PAYLOAD_LOG_MAX_LINES,
    );
  } catch {
    /* never break the hook */
  }
}

/* ---------------------------------------------------------------------------
 * Liveness heartbeats
 * "Installed on disk" is not "working". Every hook stamps its entry so doctor
 * can report UNVERIFIED instead of READY for hooks that have never fired.
 * ------------------------------------------------------------------------ */

export type HookName =
  | 'prompt-inject'
  | 'session-start'
  | 'file-save'
  | 'file-create'
  | 'file-delete'
  | 'memory-capture'
  | 'guardrail';

export interface HeartbeatFile {
  hooks: Record<string, { lastAt: string; count: number }>;
}

export function heartbeatPath(): string {
  return join(userFastpathDir(), 'heartbeats.json');
}

export function readHeartbeats(): HeartbeatFile {
  try {
    if (!existsSync(heartbeatPath())) return { hooks: {} };
    const raw = JSON.parse(readFileSync(heartbeatPath(), 'utf8')) as Partial<HeartbeatFile>;
    return { hooks: raw.hooks ?? {} };
  } catch {
    return { hooks: {} };
  }
}

/** Stamp hook entry. Cheap (one small JSON write), never throws. */
export function recordHeartbeat(hook: HookName): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    const file = readHeartbeats();
    const prior = file.hooks[hook];
    file.hooks[hook] = {
      lastAt: new Date().toISOString(),
      count: (prior?.count ?? 0) + 1,
    };
    writeFileSync(heartbeatPath(), `${JSON.stringify(file, null, 2)}\n`);
  } catch {
    /* never break the hook */
  }
}
