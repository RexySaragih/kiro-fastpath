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
} from '@fastpath/core';
import { appendMetric } from './metrics.js';

interface HookPayload {
  prompt?: string;
  cwd?: string;
  hook_event_name?: string;
}

const SNIPPET_MAX_CHARS = 600;
const MAX_HITS = 6;
const CONTEXT_CHUNKS = 5;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function workspaceFrom(payload: HookPayload): string {
  return (
    process.env.FASTPATH_WORKSPACE?.trim() ||
    payload.cwd?.trim() ||
    process.cwd()
  );
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

function writeContext(body: string): void {
  process.stdout.write(body.endsWith('\n') ? body : `${body}\n`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ value?: T; timedOut: boolean }> {
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
  const raw = await readStdin();
  let payload: HookPayload = {};
  try {
    payload = raw.trim() ? (JSON.parse(raw) as HookPayload) : {};
  } catch {
    payload = {};
  }

  const prompt = extractPrompt(payload, raw);
  const workspace = workspaceFrom(payload);

  if (!prompt) {
    writeContext('## FastPath\n\n(no user prompt — skip retrieval)\n');
    return;
  }

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
