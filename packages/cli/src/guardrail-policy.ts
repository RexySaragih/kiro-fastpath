/**
 * Pure guardrail policy — kept out of the hook entrypoint so it can be tested
 * without spawning a process that reads STDIN.
 */
import type { HookPayload } from './hook-util.js';

export interface WalkRequest {
  path: string;
  depth: number | null;
}

/** Tool arguments, wherever this Kiro version puts them. */
function toolArgs(payload: HookPayload): Record<string, unknown> {
  for (const key of ['tool_input', 'toolInput', 'arguments', 'args', 'input', 'parameters']) {
    const value = payload[key];
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  }
  return {};
}

function argString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function readWalkRequest(payload: HookPayload): WalkRequest {
  const args = toolArgs(payload);
  const path =
    argString(args, ['path', 'dir', 'directory', 'target', 'query', 'pattern']) ||
    (typeof payload.path === 'string' ? payload.path : '');
  const rawDepth = args.depth ?? args.maxDepth ?? args.max_depth;
  const depth = typeof rawDepth === 'number' ? rawDepth : null;
  return { path, depth };
}

/**
 * A scoped walk names a real subdirectory and does not recurse. Those are cheap
 * and legitimate; unscoped or root-level walks are the token sink. This replaces
 * the arbitrary "two free passes per session" allowance, which punished long
 * legitimate sessions and rewarded short wasteful ones.
 */
export function isScopedWalk({ path, depth }: WalkRequest): boolean {
  if (!path) return false;
  const clean = path.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!clean || clean === '.' || clean === '/' || clean === '*' || clean.startsWith('**')) {
    return false;
  }
  if (clean.includes('**')) return false;
  if (depth !== null && depth > 1) return false;
  return true;
}
