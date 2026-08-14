#!/usr/bin/env node
/**
 * Stop hook helper — deterministic session memory.
 * When the agent finishes a turn that touched files, records one compact
 * 'session' memory ("task X edited files Y,Z") so future prompts can recall
 * what was done and why, without replaying old context. No LLM cost.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { parseFileAst, saveMemory } from '@fastpath/core';
import {
  extractPrompt,
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
  sessionIdFromPayload,
  workspaceFromPayload,
} from './hook-util.js';
import {
  clearTouchedAfterCapture,
  readTurnState,
  updateTurnState,
} from './state.js';
import { appendMetric } from './metrics.js';

const PROMPT_SNIPPET_CHARS = 160;
const MAX_PATHS_IN_MEMORY = 5;
const MAX_SYMBOLS_IN_MEMORY = 6;

function toRelPaths(workspace: string, paths: string[]): string[] {
  return paths.map((p) => (isAbsolute(p) ? relative(workspace, p) : p));
}

/** Line numbers touched per file, from `git diff --unified=0`. */
function changedLines(workspace: string, rels: string[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const res = spawnSync('git', ['-C', workspace, 'diff', '--unified=0', 'HEAD', '--', ...rels], {
    encoding: 'utf8',
  });
  if (res.status !== 0 || !res.stdout) return out;

  let current: string | null = null;
  for (const line of res.stdout.split('\n')) {
    const fileMatch = /^\+\+\+ b\/(.+)$/.exec(line);
    if (fileMatch) {
      current = fileMatch[1]!;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      const list = out.get(current) ?? [];
      for (let i = 0; i < Math.max(count, 1); i++) list.push(start + i);
      out.set(current, list);
    }
  }
  return out;
}

/**
 * Names of symbols whose AST span contains a changed line. Symbol-level memory
 * ("changed AuthService.validateJwt") is actionable; a path list is not.
 */
async function changedSymbols(workspace: string, rels: string[]): Promise<string[]> {
  const lines = changedLines(workspace, rels);
  const names: string[] = [];
  for (const [rel, touched] of lines) {
    const abs = join(workspace, rel);
    if (!existsSync(abs)) continue;
    try {
      const parsed = await parseFileAst(rel, readFileSync(abs, 'utf8'));
      for (const sym of parsed.symbols) {
        if (touched.some((l) => l >= sym.line && l <= sym.endLine)) {
          names.push(`${sym.name} (${rel})`);
        }
      }
    } catch {
      /* unparseable — fall back to the path list */
    }
  }
  return [...new Set(names)].slice(0, MAX_SYMBOLS_IN_MEMORY);
}

async function run(): Promise<void> {
  recordHeartbeat('memory-capture');
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload('memory-capture', raw, payload);
  const workspace = workspaceFromPayload(payload);
  const sessionId = sessionIdFromPayload(payload);
  const state = readTurnState(workspace, sessionId);

  const touched = state.touchedPaths ?? [];
  if (!touched.length) return; // nothing edited this turn — no memory worth keeping

  const rels = toRelPaths(workspace, touched);
  const shown = rels.slice(0, MAX_PATHS_IN_MEMORY);
  const more = rels.length - shown.length;

  // Prefer stored prompt; Stop payload may also carry the user text.
  const task =
    state.lastPrompt?.trim().slice(0, PROMPT_SNIPPET_CHARS) ||
    extractPrompt(payload, raw).slice(0, PROMPT_SNIPPET_CHARS);

  const symbols = await changedSymbols(workspace, rels);
  const what = symbols.length
    ? `changed ${symbols.join(', ')}`
    : `edited ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;

  // Never invent "unspecified task" — symbol/path-only labels are fine.
  const text = task ? `${task} — ${what}` : what;
  if (!text.trim()) return;

  await saveMemory(workspace, {
    kind: 'session',
    text,
    tags: ['auto'],
    paths: shown,
  });

  updateTurnState(workspace, sessionId, {
    contextSummary: text.slice(0, 300),
    accessedFiles: shown,
  });
  clearTouchedAfterCapture(workspace, sessionId);

  appendMetric({
    type: 'stop',
    at: new Date().toISOString(),
    workspace,
    session: sessionId,
    edited: true,
    paths: shown.length,
  });

  console.error(`[fastpath memory-capture] saved session memory (${shown.length} paths)`);
}

run()
  .catch((err) => {
    console.error('[fastpath memory-capture]', err instanceof Error ? err.message : err);
  })
  .finally(() => {
    process.exit(0);
  });
