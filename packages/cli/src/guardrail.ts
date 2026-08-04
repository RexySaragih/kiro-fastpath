#!/usr/bin/env node
/**
 * PreToolUse hook helper — the anti-token-burn guardrail.
 * Repo walks (listDirectory / glob / file search) are the biggest context
 * polluters in Kiro. This hook logs every walk attempt and, depending on
 * FASTPATH_GUARDRAIL, blocks them (exit 2 → STDERR shown to the agent)
 * and points the agent back to FastPath retrieval.
 *
 * Modes:
 *   off   — do nothing
 *   warn  — log only (payload discovery; no behavior change)
 *   block — always block matched tools
 *   auto  — allow a small per-session allowance, then block (default)
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { userFastpathDir } from './config.js';
import { parseHookPayload, readStdinText } from './hook-util.js';

type GuardrailMode = 'off' | 'warn' | 'block' | 'auto';

/** Walk calls allowed per session before `auto` starts blocking. */
const AUTO_ALLOWANCE = 2;
const LOG_TAIL_EVENTS = 500;
const BLOCK_EXIT_CODE = 2;

const BLOCK_MESSAGE =
  'FastPath guardrail: repo walking is disabled to save tokens. ' +
  'Locate code with FastPath MCP tools instead: search / symbol / grep_fast / context_for_task. ' +
  'If retrieval returns nothing, ask the user for a path or symbol name.';

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
}

function appendEvent(event: GuardrailEvent): void {
  try {
    mkdirSync(userFastpathDir(), { recursive: true });
    appendFileSync(eventsLogPath(), `${JSON.stringify(event)}\n`);
  } catch {
    /* never break the hook */
  }
}

function priorWalksThisSession(session: string): number {
  const path = eventsLogPath();
  if (!session || !existsSync(path)) return 0;
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    let count = 0;
    for (const line of lines.slice(-LOG_TAIL_EVENTS)) {
      try {
        const ev = JSON.parse(line) as GuardrailEvent;
        if (ev.session === session) count += 1;
      } catch {
        /* skip */
      }
    }
    return count;
  } catch {
    return 0;
  }
}

async function run(): Promise<void> {
  const mode = guardrailMode();
  if (mode === 'off') return;

  const payload = parseHookPayload(await readStdinText());
  const tool = payload.tool_name || payload.toolName || 'unknown';
  const session = payload.session_id || '';

  const priorWalks = priorWalksThisSession(session);
  const shouldBlock =
    mode === 'block' || (mode === 'auto' && priorWalks >= AUTO_ALLOWANCE);

  appendEvent({
    at: new Date().toISOString(),
    tool,
    session,
    mode,
    blocked: shouldBlock,
    payloadKeys: Object.keys(payload),
  });

  if (shouldBlock) {
    console.error(BLOCK_MESSAGE);
    process.exit(BLOCK_EXIT_CODE);
  }
}

run()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
