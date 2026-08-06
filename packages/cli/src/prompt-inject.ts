#!/usr/bin/env node
/**
 * UserPromptSubmit hook helper.
 * Delta-reindexes dirty files (budgeted), then injects FastPath hits into context.
 * Exit 0 → Kiro adds STDOUT to agent context. Never blocks the user prompt.
 */
import {
  contextForTask,
  countQualityHits,
  findDirtyFiles,
  getIndexStats,
  IndexLimits,
  InjectLimits,
  indexWorkspacePaths,
  isQualityHit,
  listMemories,
  recallMemories,
  recentSymbols,
  type MemoryEntry,
  type SearchHit,
} from '@fastpath/core';
import { readTurnState, updateTurnState } from './state.js';
import {
  type HookPayload,
  extractAgentName,
  extractPrompt,
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
  sessionIdFromPayload,
  withTimeout,
  writeContext,
  workspaceFromPayload,
} from './hook-util.js';
import { CAVEMAN_OUTPUT_NUDGE, PONYTAIL_CODE_NUDGE } from './agents-md.js';

const STYLE_NUDGES = `${CAVEMAN_OUTPUT_NUDGE}\n${PONYTAIL_CODE_NUDGE}`;
import {
  appendMetric,
  creditLocateHits,
  estimateTokens,
  type InjectMode,
} from './metrics.js';
import {
  formatRoutingLine,
  isTinyPrompt,
  routingAdvice,
} from './routing.js';

/**
 * `FASTPATH_INJECT=off` disables retrieval injection while still recording the
 * turn, so tokens-to-completion can be A/B'd on the same task.
 */
function injectMode(): InjectMode {
  return process.env.FASTPATH_INJECT?.toLowerCase().trim() === 'off' ? 'off' : 'on';
}

const MEMORY_RECALL_BUDGET_MS = 1000;

/** Compact, budgeted memory recall — a few lines max, never blocks the prompt. */
async function recallRelevantMemories(
  workspace: string,
  prompt: string,
  scopePaths: string[] = [],
): Promise<MemoryEntry[]> {
  const raced = await withTimeout(
    recallMemories(workspace, prompt, {
      topK: InjectLimits.MEMORY_TOP_K,
      scopePaths,
    }),
    MEMORY_RECALL_BUDGET_MS,
  );
  return raced.value ?? [];
}

const RECENCY_PACK_SYMBOLS = 5;

function hitLoc(h: SearchHit): string {
  if (h.startLine != null && h.endLine != null) {
    return h.startLine === h.endLine
      ? `${h.path}:${h.startLine}`
      : `${h.path}:${h.startLine}-${h.endLine}`;
  }
  return h.line ? `${h.path}:${h.line}` : h.path;
}

function recencyPackLines(workspace: string): string[] {
  let recent: SearchHit[] = [];
  try {
    recent = recentSymbols(workspace, RECENCY_PACK_SYMBOLS);
  } catch {
    return [];
  }
  if (!recent.length) return [];
  return [
    '## Recency (not query matches)',
    '',
    'Recent indexed symbols — do **not** treat as task hits. Ask for a path/symbol or call `find` with a sharper query.',
    ...recent.map(
      (h) => `- **${h.symbol ?? h.kind ?? 'hit'}** — \`${hitLoc(h)}\``,
    ),
  ];
}

function memoryLines(memories: MemoryEntry[]): string[] {
  if (!memories.length) return [];
  return [
    '',
    'Project memory:',
    ...memories.map(
      (m) => `- (${m.kind}) ${m.text.slice(0, InjectLimits.MEMORY_SNIPPET_MAX_CHARS)}`,
    ),
  ];
}

/** Fallback when prompt cannot be extracted — memories only, labeled recency. */
function noPromptFallbackBody(workspace: string, reason: string): string {
  const pack = recencyPackLines(workspace);
  let memories: MemoryEntry[] = [];
  try {
    memories = listMemories(workspace, InjectLimits.MEMORY_TOP_K);
  } catch {
    /* memories are optional */
  }
  const body = [...pack, ...memoryLines(memories)];
  if (!body.length) {
    return `## FastPath\n\n${STYLE_NUDGES}\n\n(${reason}; index has nothing to offer yet)\n`;
  }
  return `## FastPath (auto-injected)\n\n${STYLE_NUDGES}\n\n(${reason})\n\n${body.join('\n')}\n\nLocate with FastPath MCP: find / impact / window / memory. Do NOT walk the repo.\n`;
}

function chunkBudget(prompt: string): number {
  return isTinyPrompt(prompt)
    ? Math.max(2, Math.floor(InjectLimits.CONTEXT_CHUNKS / 2))
    : InjectLimits.CONTEXT_CHUNKS;
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
  recordHeartbeat('prompt-inject');
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload('prompt-inject', raw, payload);

  const prompt = extractPrompt(payload, raw);
  const workspace = workspaceFromPayload(payload);
  const session = sessionIdFromPayload(payload);
  const agent = extractAgentName(payload);
  const mode = injectMode();

  /** Emit + ledger the tokens this turn actually cost. */
  const record = (
    body: string | null,
    stats: {
      dirty: number;
      deltaMs: number;
      retrieveMs: number;
      hits: number;
      timedOutDelta: boolean;
      timedOutRetrieve: boolean;
      windowVsFileTokens?: number;
      discoveryTokens?: number;
    },
  ): void => {
    const payloadBody = mode === 'off' ? null : body;
    if (payloadBody) writeContext(payloadBody);
    appendMetric({
      type: 'inject',
      at: new Date().toISOString(),
      session,
      agent,
      mode,
      injectedTokens: payloadBody ? estimateTokens(payloadBody) : 0,
      windowVsFileTokens: mode === 'off' ? 0 : (stats.windowVsFileTokens ?? 0),
      discoveryTokens: mode === 'off' ? 0 : (stats.discoveryTokens ?? 0),
      dirty: stats.dirty,
      deltaMs: stats.deltaMs,
      retrieveMs: stats.retrieveMs,
      hits: stats.hits,
      timedOutDelta: stats.timedOutDelta,
      timedOutRetrieve: stats.timedOutRetrieve,
    });
  };

  if (!prompt) {
    // Do not invent lastPrompt — memory-capture will use symbol-only labels.
    const body = noPromptFallbackBody(workspace, 'no user prompt in hook payload');
    record(body, {
      dirty: 0,
      deltaMs: 0,
      retrieveMs: 0,
      hits: 0,
      timedOutDelta: false,
      timedOutRetrieve: false,
    });
    return;
  }

  // Remember the prompt so the Stop hook can label the session memory.
  updateTurnState(workspace, session, {
    lastPrompt: prompt.slice(0, 500),
    lastPromptAt: new Date().toISOString(),
  });

  const delta = await maybeDeltaReindex(workspace);

  const stats = getIndexStats(workspace);
  if (!stats.files) {
    record(
      `## FastPath\n\n${STYLE_NUDGES}\n\nIndex empty at \`${workspace}\`. Ask the user to run \`fastpath index\` before coding (Scout cannot shell).\n`,
      {
        dirty: delta.dirty,
        deltaMs: delta.ms,
        retrieveMs: 0,
        hits: 0,
        timedOutDelta: delta.timedOut,
        timedOutRetrieve: false,
      },
    );
    return;
  }

  const retrieveStarted = Date.now();
  const raced = await withTimeout(
    contextForTask(workspace, prompt, chunkBudget(prompt)),
    IndexLimits.INJECT_RETRIEVE_BUDGET_MS,
  );
  const retrieveMs = Date.now() - retrieveStarted;

  if (raced.timedOut) {
    console.error(
      `[fastpath prompt-inject] retrieve timed out after ${IndexLimits.INJECT_RETRIEVE_BUDGET_MS}ms`,
    );
    record(
      `## FastPath\n\n${STYLE_NUDGES}\n\n(retrieval timed out — use FastPath MCP tools: find / impact / window / memory)\n`,
      {
        dirty: delta.dirty,
        deltaMs: delta.ms,
        retrieveMs,
        hits: 0,
        timedOutDelta: delta.timedOut,
        timedOutRetrieve: true,
      },
    );
    return;
  }

  const hits = raced.value ?? [];
  const qualityHits = countQualityHits(hits);
  const strongHits = hits.filter((h) => isQualityHit(h));
  const lines = [
    '## FastPath retrieved context (auto-injected)',
    '',
    CAVEMAN_OUTPUT_NUDGE,
    PONYTAIL_CODE_NUDGE,
    '',
    `Workspace: \`${workspace}\` · indexed files=${stats.files} symbols=${stats.symbols}`,
    '',
    'Use these code windows first. Prefer FastPath `window` over whole-file host reads.',
    'Minimize host whole-file reads — windows first, then edit.',
    'Agents: Scout ≤5 files (no shell); Architect 6+ / design; Default OK for verify.',
    '',
  ];

  // Handoff from prior turn (if any).
  try {
    const turn = readTurnState(workspace, session);
    if (turn.contextSummary) {
      lines.push(`Prior handoff: ${turn.contextSummary}`, '');
      if (turn.accessedFiles?.length) {
        lines.push(`Prior files: ${turn.accessedFiles.join(', ')}`, '');
      }
    }
  } catch {
    /* optional */
  }

  if (delta.dirty >= IndexLimits.DELTA_MAX_FILES) {
    lines.push(
      `Note: ${delta.dirty}+ dirty files, only ${IndexLimits.DELTA_MAX_FILES} reindexed — retrieval may be stale. Run \`fastpath index --git\` or \`fastpath watch\`.`,
      '',
    );
  }
  if (delta.timedOut) {
    lines.push('Note: delta reindex timed out — retrieval may be stale.', '');
  }

  const advice = routingAdvice(
    prompt,
    strongHits.map((h) => h.path),
  );
  if (advice) {
    const line = formatRoutingLine(advice);
    lines.push(line, '');
    console.warn(`\n[FastPath routing] ${advice.agent} (${advice.confidence}) — ${advice.reason}\n`);
    appendMetric({
      type: 'routing',
      at: new Date().toISOString(),
      session,
      agent: advice.agent,
      confidence: advice.confidence,
      reason: advice.reason,
    });
  }

  if (!strongHits.length) {
    lines.push(
      '## NO_MATCH',
      '',
      'No strong query matches for this prompt. Do **not** edit from recency alone.',
      'Ask the user for a path/symbol, or call FastPath `find` with a sharper query.',
      '',
    );
    const pack = recencyPackLines(workspace);
    if (pack.length) lines.push(...pack, '');
  } else {
    for (const hit of strongHits.slice(0, InjectLimits.MAX_HITS)) {
      lines.push(`- **${hit.symbol ?? hit.kind ?? 'hit'}** — \`${hitLoc(hit)}\``);
      if (hit.snippet) {
        lines.push(
          '```',
          hit.snippet.slice(0, InjectLimits.SNIPPET_MAX_CHARS),
          '```',
        );
      }
    }
  }

  // Weak hits: paths only, no bodies (avoid authoritative-looking noise).
  const weak = hits.filter((h) => !isQualityHit(h)).slice(0, 3);
  if (weak.length && strongHits.length) {
    lines.push('', 'Weak hits (paths only — verify before editing):');
    for (const h of weak) {
      lines.push(`- \`${hitLoc(h)}\` (${h.symbol ?? h.kind ?? 'hit'})`);
    }
  }

  const memories = await recallRelevantMemories(
    workspace,
    prompt,
    strongHits.map((h) => h.path),
  );
  if (memories.length) {
    lines.push('', '## FastPath memory (auto-injected)', '');
    for (const m of memories) {
      const stale = m.stale ? ' [STALE — referenced files changed since saved]' : '';
      lines.push(
        `- (${m.kind}) ${m.text.slice(0, InjectLimits.MEMORY_SNIPPET_MAX_CHARS)}${stale}`,
      );
    }
  }

  lines.push(
    '',
    'Prefer these windows for edits. Use FastPath `window` for more lines — avoid whole-file host reads.',
  );

  const credit =
    mode === 'off' || qualityHits === 0
      ? { windowVsFileTokens: 0, discoveryTokens: 0, paths: [] as string[] }
      : creditLocateHits(workspace, strongHits.slice(0, InjectLimits.MAX_HITS));

  record(`${lines.join('\n')}\n`, {
    dirty: delta.dirty,
    deltaMs: delta.ms,
    retrieveMs,
    hits: qualityHits,
    timedOutDelta: delta.timedOut,
    timedOutRetrieve: false,
    windowVsFileTokens: credit.windowVsFileTokens,
    discoveryTokens: credit.discoveryTokens,
  });
}

run()
  .catch((err) => {
    console.error('[fastpath prompt-inject]', err);
    writeContext(
      `## FastPath\n\n${STYLE_NUDGES}\n\n(retrieval error — continue carefully; prefer FastPath MCP tools)\n`,
    );
  })
  .finally(() => {
    process.exit(0);
  });
