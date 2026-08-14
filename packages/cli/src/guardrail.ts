#!/usr/bin/env node
/**
 * PreToolUse hook helper — the anti-token-burn guardrail.
 * Repo walks (listDirectory / glob / file search) and recursive shell discovery
 * (grep -r / rg / find -name) are the biggest context polluters in Kiro. This
 * hook logs every attempt and, depending on FASTPATH_GUARDRAIL, blocks them
 * (exit 2 → STDERR shown to the agent) and points the agent back to FastPath.
 *
 * Modes:
 *   off   — do nothing
 *   warn  — log only (payload discovery; no behavior change)
 *   block — block every matched walk / shell discovery
 *   auto  — allow scoped walks (explicit path, depth <= 1), block the rest (default)
 *
 * A blocked walk is answered, not just refused: the indexed file list for the
 * requested path goes back on STDERR so the agent gets what it wanted with zero
 * filesystem reads.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userFastpathDir } from './config.js';
import { appendMetric, appendRotatingLine, WALK_TOKENS_AVOIDED } from './metrics.js';
import { listIndexedPaths } from '@fastpath/core';
import {
  isRepoDiscoveryShell,
  isScopedWalk,
  isShellTool,
  readShellCommand,
  readWalkRequest,
} from './guardrail-policy.js';
import {
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
  workspaceFromPayload,
} from './hook-util.js';

type GuardrailMode = 'off' | 'warn' | 'block' | 'auto';

const LOG_TAIL_EVENTS = 500;
const BLOCK_EXIT_CODE = 2;
/** How many indexed paths to hand back in place of a blocked walk. */
const SUBSTITUTE_PATH_LIMIT = 40;
/** Reading the same file this many times in a session is a token sink. */
const DUPLICATE_READ_WARN_AT = 2;

const BLOCK_MESSAGE =
  'FastPath guardrail: unscoped repo walking is disabled to save tokens. ' +
  'Locate code with FastPath MCP tools instead: find / impact / window / memory. ' +
  'Scoped walks (explicit path, depth <= 1) are allowed.';

const SHELL_DISCOVERY_MESSAGE =
  'FastPath guardrail: recursive shell search of the workspace is disabled. ' +
  'For repo content use FastPath MCP `find` (mode: grep / search / symbol). ' +
  'Shell grep/rg is OK on command stdout or a single known file — not `grep -r` / `rg` / `find` for discovery.';

function guardrailMode(): GuardrailMode {
  const raw = (process.env.FASTPATH_GUARDRAIL || 'auto').toLowerCase().trim();
  if (raw === 'off' || raw === 'warn' || raw === 'block' || raw === 'auto') return raw;
  return 'auto';
}

function eventsLogPath(): string {
  return join(userFastpathDir(), 'hook-events.jsonl');
}

interface GuardrailEvent {
  at: string;
  tool: string;
  session: string;
  mode: GuardrailMode;
  blocked: boolean;
  payloadKeys: string[];
  path?: string;
  kind?: 'walk' | 'read' | 'shell-discovery';
}

function appendEvent(event: GuardrailEvent): void {
  appendRotatingLine(eventsLogPath(), JSON.stringify(event));
}

/** Count how often this session already touched the same path. */
function priorSamePath(session: string, path: string): number {
  const logPath = eventsLogPath();
  if (!session || !path || !existsSync(logPath)) return 0;
  try {
    const lines = readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines.slice(-LOG_TAIL_EVENTS)) {
      try {
        const ev = JSON.parse(line) as GuardrailEvent;
        if (ev.session === session && ev.path === path) count += 1;
      } catch {
        /* skip */
      }
    }
    return count;
  } catch {
    return 0;
  }
}

const READ_TOOL = /read|open|cat|view/i;

/**
 * Answer the blocked walk from the index: the agent wanted a file list, and we
 * have one. Substituting turns the guardrail into a service instead of friction.
 */
function substituteListing(workspace: string, path: string): string | null {
  try {
    const paths = listIndexedPaths(workspace, path, SUBSTITUTE_PATH_LIMIT);
    if (!paths.length) return null;
    const label = path || 'workspace';
    const byDir = new Map<string, string[]>();
    for (const p of paths) {
      const slash = p.lastIndexOf('/');
      const dir = slash >= 0 ? p.slice(0, slash) : '.';
      const list = byDir.get(dir) ?? [];
      list.push(p.slice(slash + 1));
      byDir.set(dir, list);
    }
    const groups = [...byDir.entries()]
      .slice(0, 12)
      .map(([dir, files]) => `${dir}/: ${files.slice(0, 8).join(', ')}`)
      .join(' · ');
    return (
      `${label} (from FastPath index, grouped): ${groups}. ` +
      `Indexed: ${paths.join(', ')}. ` +
      `Use FastPath \`find\` mode=context/search for content — do not re-walk.`
    );
  } catch {
    return null;
  }
}

async function run(): Promise<void> {
  recordHeartbeat('guardrail');
  const mode = guardrailMode();
  if (mode === 'off') return;

  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload('guardrail', raw, payload);
  const tool = payload.tool_name || payload.toolName || 'unknown';
  const session = payload.session_id || '';
  const workspace = workspaceFromPayload(payload);
  const request = readWalkRequest(payload);

  // Shell: block recursive repo discovery; allow stdout filters and single-file greps.
  if (isShellTool(tool)) {
    const command = readShellCommand(payload);
    const discovery = isRepoDiscoveryShell(command);
    const shouldBlock = discovery && (mode === 'block' || mode === 'auto');
    appendEvent({
      at: new Date().toISOString(),
      tool,
      session,
      mode,
      blocked: shouldBlock,
      payloadKeys: Object.keys(payload),
      path: command.slice(0, 200),
      kind: 'shell-discovery',
    });
    appendMetric({
      type: 'guardrail',
      at: new Date().toISOString(),
      workspace,
      session,
      tool,
      blocked: shouldBlock,
      tokensAvoided: shouldBlock ? WALK_TOKENS_AVOIDED : 0,
    });
    if (discovery && mode === 'warn') {
      console.error(SHELL_DISCOVERY_MESSAGE);
      return;
    }
    if (shouldBlock) {
      console.error(SHELL_DISCOVERY_MESSAGE);
      process.exit(BLOCK_EXIT_CODE);
    }
    return;
  }

  // Repeated reads of one file are a comparable token sink to walking; warn,
  // never block, since the read is usually legitimate the first time.
  if (READ_TOOL.test(tool)) {
    const seen = priorSamePath(session, request.path);
    appendEvent({
      at: new Date().toISOString(),
      tool,
      session,
      mode,
      blocked: false,
      payloadKeys: Object.keys(payload),
      path: request.path,
      kind: 'read',
    });
    if (seen >= DUPLICATE_READ_WARN_AT) {
      console.error(
        `FastPath: ${request.path} already read ${seen}x this session — reuse prior context or call FastPath \`window\` for specific lines instead of whole-file re-read.`,
      );
    }
    return;
  }

  const scoped = isScopedWalk(request);
  const shouldBlock = mode === 'block' || (mode === 'auto' && !scoped);

  appendEvent({
    at: new Date().toISOString(),
    tool,
    session,
    mode,
    blocked: shouldBlock,
    payloadKeys: Object.keys(payload),
    path: request.path,
    kind: 'walk',
  });
  appendMetric({
    type: 'guardrail',
    at: new Date().toISOString(),
    workspace,
    session,
    tool,
    blocked: shouldBlock,
    tokensAvoided: shouldBlock ? WALK_TOKENS_AVOIDED : 0,
  });

  if (shouldBlock) {
    const listing = substituteListing(workspace, request.path);
    console.error(listing ? `${BLOCK_MESSAGE}\n${listing}` : BLOCK_MESSAGE);
    process.exit(BLOCK_EXIT_CODE);
  }
}

run()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
