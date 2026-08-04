#!/usr/bin/env node
/**
 * SessionStart hook helper.
 * Warms the embedder, catches up on git-changed files (budgeted), and prints
 * an index status block that Kiro adds to session context (exit 0 STDOUT).
 */
import {
  getIndexStats,
  indexGitChanged,
  listMemories,
  warmEmbedder,
} from '@fastpath/core';
import {
  parseHookPayload,
  readStdinText,
  withTimeout,
  writeContext,
  workspaceFromPayload,
} from './hook-util.js';
import { appendMetric } from './metrics.js';

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

async function catchUpGitDelta(workspace: string): Promise<number> {
  try {
    const raced = await withTimeout(indexGitChanged(workspace), GIT_DELTA_BUDGET_MS);
    return raced.value?.filesIndexed ?? 0;
  } catch {
    return 0; // not a git repo or delta failed — full index remains authoritative
  }
}

async function run(): Promise<void> {
  const payload = parseHookPayload(await readStdinText());
  const workspace = workspaceFromPayload(payload);
  const started = Date.now();

  await withTimeout(warmEmbedder(), WARM_BUDGET_MS);
  const gitDelta = await catchUpGitDelta(workspace);
  const stats = getIndexStats(workspace);

  appendMetric({
    type: 'session-start',
    at: new Date().toISOString(),
    gitDelta,
    ms: Date.now() - started,
  });

  if (!stats.files) {
    writeContext(
      `## FastPath session\n\nIndex empty at \`${workspace}\`. Run \`fastpath index\` before coding.\n`,
    );
    return;
  }

  const lines = [
    '## FastPath session (auto-injected)',
    '',
    `Workspace: \`${workspace}\` · indexed files=${stats.files} symbols=${stats.symbols} · indexedAt=${stats.indexedAt}`,
  ];
  if (gitDelta) {
    lines.push(`Caught up ${gitDelta} git-changed file(s) at session start.`);
  }

  const recent = recentMemoryLines(workspace);
  if (recent.length) {
    lines.push('', 'Recent project memory:', ...recent);
  }

  lines.push(
    '',
    'Locate code with FastPath (injected context or MCP tools: search / symbol / grep_fast / context_for_task / impact).',
    'Do NOT walk the repo with listDirectory/glob.',
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
