/**
 * Shared helpers for Kiro hook entrypoints (prompt-inject, file-event,
 * session-start, guardrail). Hooks receive JSON on STDIN and must never
 * block the user — callers always exit 0 unless intentionally blocking.
 */

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
