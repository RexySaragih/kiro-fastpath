#!/usr/bin/env node
/**
 * UserPromptSubmit hook helper.
 * Delta-reindexes dirty files (budgeted), then injects FastPath hits into context.
 * Exit 0 → Kiro adds STDOUT to agent context. Never blocks the user prompt.
 */
import {
  contextForTask,
  findDirtyFiles,
  getIndexStats,
  IndexLimits,
  indexWorkspacePaths,
  recallMemories,
  type MemoryEntry,
} from '@fastpath/core';
import { updateWorkspaceState } from './state.js';
import {
  type HookPayload,
  parseHookPayload,
  readStdinText,
  withTimeout,
  writeContext,
  workspaceFromPayload,
} from './hook-util.js';
import { appendMetric } from './metrics.js';

const SNIPPET_MAX_CHARS = 600;
const MAX_HITS = 6;
const CONTEXT_CHUNKS = 5;
const MEMORY_TOP_K = 3;
const MEMORY_SNIPPET_MAX_CHARS = 240;
const MEMORY_RECALL_BUDGET_MS = 1000;

/** Compact, budgeted memory recall — a few lines max, never blocks the prompt. */
async function recallRelevantMemories(
  workspace: string,
  prompt: string,
): Promise<MemoryEntry[]> {
  const raced = await withTimeout(
    recallMemories(workspace, prompt, MEMORY_TOP_K),
    MEMORY_RECALL_BUDGET_MS,
  );
  return raced.value ?? [];
}

const MULTI_FILE_KEYWORDS =
  /\b(feature|refactor|migrat\w*|redesign|restructure|rewrite|implement|architecture|new module|integrat\w*|across|end.?to.?end|system)\b/i;
const SMALL_TASK_KEYWORDS = /\b(fix|typo|bug|tweak|adjust|small|quick|one.?liner?)\b/i;
const MULTI_FILE_HIT_SPREAD = 4;

/**
 * Deterministic routing hint for humans picking Scout vs Architect.
 * One line, computed from keywords + retrieval spread — no LLM cost.
 */
function routingHint(prompt: string, hitPaths: string[]): string | null {
  const distinctFiles = new Set(hitPaths).size;
  const multiSignal =
    MULTI_FILE_KEYWORDS.test(prompt) || distinctFiles >= MULTI_FILE_HIT_SPREAD;
  const smallSignal = SMALL_TASK_KEYWORDS.test(prompt);

  if (multiSignal && !smallSignal) {
    return `Routing: multi-file scope likely (${distinctFiles} files matched) — prefer Architect.`;
  }
  if (smallSignal && !multiSignal) {
    return 'Routing: small scope — prefer Scout.';
  }
  return null;
}

function extractPrompt(payload: HookPayload, raw: string): string {
  const fromEnv =
    process.env.USER_PROMPT?.trim() ||
    process.env.KIRO_USER_PROMPT?.trim() ||
    '';
  if (fromEnv) return fromEnv;
  if (payload.prompt?.trim()) return payload.prompt.trim();
  if (raw.trim() && !raw.trim().startsWith('{')) return raw.trim();
  return '';
}

async function maybeDeltaReindex(
  workspace: string,
): Promise<{ dirty: number; indexed: number; ms: number; timedOut: boolean }> {
  const started = Date.now();
  try {
    const dirty = findDirtyFiles(workspace, IndexLimits.DELTA_MAX_FILES);
    if (!dirty.length) return { dirty: 0, indexed: 0, ms: 0, timedOut: false };

    const raced = await withTimeout(
      indexWorkspacePaths(workspace, dirty),
      IndexLimits.INJECT_DELTA_BUDGET_MS,
    );
    const ms = Date.now() - started;
    if (raced.timedOut) {
      console.error(
        `[fastpath prompt-inject] delta reindex timed out after ${IndexLimits.INJECT_DELTA_BUDGET_MS}ms (dirty=${dirty.length})`,
      );
      return { dirty: dirty.length, indexed: 0, ms, timedOut: true };
    }
    const indexed = raced.value?.filesIndexed ?? 0;
    console.error(
      `[fastpath prompt-inject] delta reindex dirty=${dirty.length} indexed=${indexed} ms=${ms}`,
    );
    return { dirty: dirty.length, indexed, ms, timedOut: false };
  } catch (err) {
    console.error(
      '[fastpath prompt-inject] delta reindex failed:',
      err instanceof Error ? err.message : err,
    );
    return { dirty: 0, indexed: 0, ms: Date.now() - started, timedOut: false };
  }
}

async function run(): Promise<void> {
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);

  const prompt = extractPrompt(payload, raw);
  const workspace = workspaceFromPayload(payload);

  if (!prompt) {
    writeContext('## FastPath\n\n(no user prompt — skip retrieval)\n');
    return;
  }

  // Remember the prompt so the Stop hook can label the session memory.
  updateWorkspaceState(workspace, {
    lastPrompt: prompt.slice(0, 500),
    lastPromptAt: new Date().toISOString(),
  });

  const delta = await maybeDeltaReindex(workspace);

  const stats = getIndexStats(workspace);
  if (!stats.files) {
    writeContext(
      `## FastPath\n\nIndex empty at \`${workspace}\`. Run \`fastpath index\` before coding.\n`,
    );
    return;
  }

  const retrieveStarted = Date.now();
  const raced = await withTimeout(
    contextForTask(workspace, prompt, CONTEXT_CHUNKS),
    IndexLimits.INJECT_RETRIEVE_BUDGET_MS,
  );
  const retrieveMs = Date.now() - retrieveStarted;

  if (raced.timedOut) {
    console.error(
      `[fastpath prompt-inject] retrieve timed out after ${IndexLimits.INJECT_RETRIEVE_BUDGET_MS}ms`,
    );
    appendMetric({
      type: 'inject',
      at: new Date().toISOString(),
      dirty: delta.dirty,
      deltaMs: delta.ms,
      retrieveMs,
      hits: 0,
      timedOutDelta: delta.timedOut,
      timedOutRetrieve: true,
    });
    writeContext(
      '## FastPath\n\n(retrieval timed out — use FastPath MCP tools: symbol / search / grep_fast)\n',
    );
    return;
  }

  const hits = raced.value ?? [];
  appendMetric({
    type: 'inject',
    at: new Date().toISOString(),
    dirty: delta.dirty,
    deltaMs: delta.ms,
    retrieveMs,
    hits: hits.length,
    timedOutDelta: delta.timedOut,
    timedOutRetrieve: false,
  });

  const lines = [
    '## FastPath retrieved context (auto-injected)',
    '',
    `Workspace: \`${workspace}\` · indexed files=${stats.files} symbols=${stats.symbols}`,
    '',
    'Use these paths first. Do NOT listDirectory/glob the whole repo.',
    'Open at most 3 files from this list, then edit.',
    '',
  ];

  const hint = routingHint(prompt, hits.map((h) => h.path));
  if (hint) lines.push(hint, '');

  if (!hits.length) {
    lines.push(
      '(no strong matches — ask user for a file path or symbol name; do not scan the repo)',
    );
  }

  for (const hit of hits.slice(0, MAX_HITS)) {
    const loc = hit.line ? `${hit.path}:${hit.line}` : hit.path;
    lines.push(`- **${hit.symbol ?? hit.kind ?? 'hit'}** — \`${loc}\``);
    if (hit.snippet) {
      lines.push('```', hit.snippet.slice(0, SNIPPET_MAX_CHARS), '```');
    }
  }

  const memories = await recallRelevantMemories(workspace, prompt);
  if (memories.length) {
    lines.push('', '## FastPath memory (auto-injected)', '');
    for (const m of memories) {
      lines.push(`- (${m.kind}) ${m.text.slice(0, MEMORY_SNIPPET_MAX_CHARS)}`);
    }
  }

  writeContext(`${lines.join('\n')}\n`);
}

run()
  .catch((err) => {
    console.error('[fastpath prompt-inject]', err);
    writeContext(
      '## FastPath\n\n(retrieval error — continue carefully; prefer FastPath MCP tools)\n',
    );
  })
  .finally(() => {
    process.exit(0);
  });
