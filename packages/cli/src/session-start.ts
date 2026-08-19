#!/usr/bin/env node
/**
 * SessionStart hook helper.
 * Warms the embedder, catches up on git-changed files (budgeted), and prints
 * an index status block that Kiro adds to session context (exit 0 STDOUT).
 */
import {
  getIndexStats,
  indexGitChanged,
  indexHeadChange,
  listMemories,
  warmEmbedder,
  warmReranker,
} from '@fastpath/core';
import {
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
  sessionIdFromPayload,
  withTimeout,
  writeContext,
  workspaceFromPayload,
} from './hook-util.js';
import { appendMetric, resetLedgerState } from './metrics.js';
import { readTurnState } from './state.js';

/** SessionStart is off the prompt hot path — allow a cold MiniLM load + git delta. */
const WARM_BUDGET_MS = 15_000;
const GIT_DELTA_BUDGET_MS = 8_000;
const SESSION_MEMORY_COUNT = 3;
const SESSION_MEMORY_LINE_CHARS = 200;

function recentMemoryLines(workspace: string): string[] {
  try {
    return listMemories(workspace, SESSION_MEMORY_COUNT).map(
      (m) => `- (${m.kind}) ${m.text.slice(0, SESSION_MEMORY_LINE_CHARS)}`,
    );
  } catch {
    return [];
  }
}

/** Branch switches leave a clean tree — reconcile the index against HEAD. */
async function catchUpHead(
  workspace: string,
): Promise<{ filesIndexed: number; removed: number; switched: boolean }> {
  try {
    const raced = await withTimeout(indexHeadChange(workspace), GIT_DELTA_BUDGET_MS);
    const value = raced.value;
    if (!value) return { filesIndexed: 0, removed: 0, switched: false };
    return {
      filesIndexed: value.filesIndexed,
      removed: value.removed,
      switched: Boolean(value.from && value.to && value.from !== value.to),
    };
  } catch {
    return { filesIndexed: 0, removed: 0, switched: false };
  }
}

async function catchUpGitDelta(workspace: string): Promise<number> {
  try {
    const raced = await withTimeout(indexGitChanged(workspace), GIT_DELTA_BUDGET_MS);
    return raced.value?.filesIndexed ?? 0;
  } catch {
    return 0; // not a git repo or delta failed — full index remains authoritative
  }
}

async function run(): Promise<void> {
  recordHeartbeat('session-start');
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload('session-start', raw, payload);
  const workspace = workspaceFromPayload(payload);
  const sessionId = sessionIdFromPayload(payload);
  const started = Date.now();

  // Warm both models here — a cold reranker load would otherwise blow the
  // 3s prompt-inject retrieve budget on the first real query.
  await withTimeout(warmEmbedder(), WARM_BUDGET_MS);
  await withTimeout(warmReranker(), WARM_BUDGET_MS);
  const headChange = await catchUpHead(workspace);
  const gitDelta = await catchUpGitDelta(workspace);
  const stats = getIndexStats(workspace);

  resetLedgerState();
  appendMetric({
    type: 'session-start',
    at: new Date().toISOString(),
    workspace,
    gitDelta,
    ms: Date.now() - started,
  });

  if (!stats.files) {
    writeContext(
      `## FastPath session\n\nIndex empty at \`${workspace}\`. Ask the user to run \`fastpath index\` before coding.\n`,
    );
    return;
  }

  const lines = [
    '## FastPath session',
    '',
    `Workspace: \`${workspace}\` · indexed files=${stats.files} symbols=${stats.symbols} · indexedAt=${stats.indexedAt}`,
  ];
  if (headChange.switched) {
    lines.push(
      `HEAD changed since last index — reconciled ${headChange.filesIndexed} file(s), removed ${headChange.removed}.`,
    );
  }
  if (gitDelta) {
    lines.push(`Caught up ${gitDelta} git-changed file(s) at session start.`);
  }

  const recent = recentMemoryLines(workspace);
  if (recent.length) {
    lines.push('', 'Recent project memory:', ...recent);
  }

  try {
    const turn = readTurnState(workspace, sessionId);
    if (turn.contextSummary) {
      lines.push('', 'Prior handoff:', `- ${turn.contextSummary}`);
      if (turn.accessedFiles?.length) {
        lines.push(`- files: ${turn.accessedFiles.join(', ')}`);
      }
    }
  } catch {
    /* optional */
  }

  lines.push(
    '',
    'Locate code with FastPath (injected context or MCP: find / impact / window / memory).',
    'Default agent: edit + shell OK. Spawn Scout to gather when inject misses. Architect 6+ / design.',
    'Do NOT spawn Kiro built-in Context gathering. Do NOT walk the repo with listDirectory/glob.',
  );

  writeContext(`${lines.join('\n')}\n`);
}

run()
  .catch((err) => {
    console.error('[fastpath session-start]', err instanceof Error ? err.message : err);
  })
  .finally(() => {
    process.exit(0);
  });
