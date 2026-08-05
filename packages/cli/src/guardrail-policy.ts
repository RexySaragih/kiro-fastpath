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
export function toolArgs(payload: HookPayload): Record<string, unknown> {
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

const SHELL_TOOL =
  /^(execute_?bash|execute_?command|run_?command|run_?shell|shell|bash|zsh|sh)$/i;

export function isShellTool(tool: string): boolean {
  return SHELL_TOOL.test(tool.trim());
}

/** Pull the shell command string from common PreToolUse payload shapes. */
export function readShellCommand(payload: HookPayload): string {
  const args = toolArgs(payload);
  return (
    argString(args, ['command', 'cmd', 'script', 'code', 'input', 'bash']) ||
    (typeof payload.command === 'string' ? payload.command.trim() : '')
  );
}

/** Rough argv split — enough for discovery heuristics, not a full shell parser. */
function shellTokens(segment: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^\s]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment))) {
    let t = m[0];
    if (
      (t.startsWith('"') && t.endsWith('"')) ||
      (t.startsWith("'") && t.endsWith("'"))
    ) {
      t = t.slice(1, -1);
    }
    tokens.push(t);
  }
  return tokens;
}

function stripLeadingAssignments(segment: string): string {
  return segment.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, '').trim();
}

/** Last non-flag arg looks like a single source file, not a directory walk root. */
function lastArgIsSingleFile(tokens: string[]): boolean {
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    const t = tokens[i];
    if (!t || t.startsWith('-')) continue;
    // Extensions FastPath indexes (and common sources) — single-file grep is fine.
    if (/\.[A-Za-z0-9]{1,10}$/.test(t) && !t.endsWith('/')) return true;
    return false;
  }
  return false;
}

function hasRecursiveGrepFlag(tokens: string[]): boolean {
  for (const t of tokens) {
    if (t === '--recursive' || t === '--dereference-recursive') return true;
    // Short cluster: -r, -R, -rln, -nR, etc. (not --long flags).
    if (t.startsWith('-') && !t.startsWith('--') && /[rR]/.test(t.slice(1))) return true;
  }
  return false;
}

function isGrepDiscovery(tokens: string[]): boolean {
  // tokens[0] is grep/egrep/fgrep
  if (hasRecursiveGrepFlag(tokens)) return true;
  // `grep pattern .` / `grep pattern ./src` without -r still walks when path is a dir.
  if (lastArgIsSingleFile(tokens.slice(1))) return false;
  const paths = tokens.slice(1).filter((t) => !t.startsWith('-') && t !== '--');
  // grep PATTERN only (stdin) — allow; usually filters a pipe we already handled.
  if (paths.length <= 1) return false;
  // pattern + directory-like path
  const target = paths[paths.length - 1];
  if (!target) return false;
  if (target === '.' || target === '..' || target.endsWith('/') || !/\.[A-Za-z0-9]+$/.test(target)) {
    return true;
  }
  return false;
}

function isRgDiscovery(tokens: string[]): boolean {
  // `rg pattern file.ts` — allow. Bare `rg pattern` or `rg pattern src` — block.
  if (lastArgIsSingleFile(tokens.slice(1))) return false;
  return true;
}

function isFindDiscovery(tokens: string[]): boolean {
  return tokens.some((t) =>
    ['-name', '-iname', '-path', '-ipath', '-regex', '-type', '-wholepath'].includes(t),
  );
}

/**
 * True when the first pipeline stage is using the shell to search the workspace
 * tree (the FastPath bypass). Filters on prior command output (`npm test | rg`)
 * are allowed.
 */
export function isRepoDiscoveryShell(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;

  // Only the producer side of a pipe can discover files; later stages filter stdout.
  const firstPipeStage = cmd.split('|')[0] ?? cmd;
  const segments = firstPipeStage.split(/\s*(?:&&|;|\|\|)\s*/);

  for (const raw of segments) {
    const segment = stripLeadingAssignments(raw);
    if (!segment) continue;
    const tokens = shellTokens(segment);
    if (!tokens.length) continue;

    const head = tokens[0];
    if (head === 'grep' || head === 'egrep' || head === 'fgrep') {
      if (isGrepDiscovery(tokens)) return true;
      continue;
    }
    if (head === 'rg' || head === 'ripgrep') {
      if (isRgDiscovery(tokens)) return true;
      continue;
    }
    if (head === 'ag' || head === 'ack') return true;
    if (head === 'find' && isFindDiscovery(tokens)) return true;
    if (head === 'git' && tokens[1] === 'grep') return true;
  }
  return false;
}
