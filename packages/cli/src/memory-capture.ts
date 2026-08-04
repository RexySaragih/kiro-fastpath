#!/usr/bin/env node
/**
 * Stop hook helper — deterministic session memory.
 * When the agent finishes a turn that touched files, records one compact
 * 'session' memory ("task X edited files Y,Z") so future prompts can recall
 * what was done and why, without replaying old context. No LLM cost.
 */
import { relative, isAbsolute } from 'node:path';
import { saveMemory } from '@fastpath/core';
import { parseHookPayload, readStdinText, workspaceFromPayload } from './hook-util.js';
import { readWorkspaceState, updateWorkspaceState } from './state.js';

const PROMPT_SNIPPET_CHARS = 160;
const MAX_PATHS_IN_MEMORY = 5;

function toRelPaths(workspace: string, paths: string[]): string[] {
  return paths.map((p) => (isAbsolute(p) ? relative(workspace, p) : p));
}

async function run(): Promise<void> {
  const payload = parseHookPayload(await readStdinText());
  const workspace = workspaceFromPayload(payload);
  const state = readWorkspaceState(workspace);

  const touched = state.touchedPaths ?? [];
  if (!touched.length) return; // nothing edited this turn — no memory worth keeping

  const rels = toRelPaths(workspace, touched);
  const shown = rels.slice(0, MAX_PATHS_IN_MEMORY);
  const more = rels.length - shown.length;
  const task = state.lastPrompt?.trim().slice(0, PROMPT_SNIPPET_CHARS) || 'unspecified task';

  const text = `${task} — edited ${shown.join(', ')}${more > 0 ? ` (+${more} more)` : ''}`;
  await saveMemory(workspace, {
    kind: 'session',
    text,
    tags: ['auto'],
    paths: shown,
  });

  updateWorkspaceState(workspace, {
    touchedPaths: [],
    lastCaptureAt: new Date().toISOString(),
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
