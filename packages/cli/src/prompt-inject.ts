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
  listMemories,
  recallMemories,
  recentSymbols,
  type MemoryEntry,
  type SearchHit,
} from '@fastpath/core';
import { updateWorkspaceState } from './state.js';
import {
  type HookPayload,
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
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

const RECENCY_PACK_SYMBOLS = 5;

function hitLoc(h: SearchHit): string {
  if (h.startLine != null && h.endLine != null) {
    return h.startLine === h.endLine
      ? `${h.path}:${h.startLine}`
      : `${h.path}:${h.startLine}-${h.endLine}`;
  }
  return h.line ? `${h.path}:${h.line}` : h.path;
}

/**
 * The hook cost is already paid by the time we know there is no prompt (or no
 * hits), so never emit an empty block — fall back to a cheap recency pack.
 */
function recencyPackLines(workspace: string): string[] {
  let recent: SearchHit[] = [];
  try {
    recent = recentSymbols(workspace, RECENCY_PACK_SYMBOLS);
  } catch {
    return [];
  }
  if (!recent.length) return [];
  return [
    'Recently changed indexed symbols (recency pack):',
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

/** Fallback block for "no prompt extracted" — recency + memories, never empty. */
function recencyFallbackBody(workspace: string, reason: string): string {
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
  return `## FastPath (auto-injected)\n\n${STYLE_NUDGES}\n\n(${reason})\n\n${body.join('\n')}\n\nLocate more with FastPath MCP tools. Do NOT walk the repo.\n`;
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
  recordHeartbeat('prompt-inject');
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload('prompt-inject', raw, payload);

  const prompt = extractPrompt(payload, raw);
  const workspace = workspaceFromPayload(payload);
  const session = payload.session_id || '';
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
    const body = await recencyFallbackBody(workspace, 'no user prompt in hook payload');
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
  updateWorkspaceState(workspace, {
    lastPrompt: prompt.slice(0, 500),
    lastPromptAt: new Date().toISOString(),
  });

  const delta = await maybeDeltaReindex(workspace);

  const stats = getIndexStats(workspace);
  if (!stats.files) {
    record(
      `## FastPath\n\n${STYLE_NUDGES}\n\nIndex empty at \`${workspace}\`. Run \`fastpath index\` before coding.\n`,
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
    contextForTask(workspace, prompt, InjectLimits.CONTEXT_CHUNKS),
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
  const lines = [
    '## FastPath retrieved context (auto-injected)',
    '',
    CAVEMAN_OUTPUT_NUDGE,
    PONYTAIL_CODE_NUDGE,
    '',
    `Workspace: \`${workspace}\` · indexed files=${stats.files} symbols=${stats.symbols}`,
    '',
    'Use these code windows first. Prefer FastPath `window` over whole-file host reads.',
    'Host-read at most 3 files, and only if a window is insufficient — then edit.',
    '',
  ];

  // The delta cap silently dropped work — say so rather than serving stale hits.
  if (delta.dirty >= IndexLimits.DELTA_MAX_FILES) {
    lines.push(
      `Note: ${delta.dirty}+ dirty files, only ${IndexLimits.DELTA_MAX_FILES} reindexed — retrieval may be stale. Run \`fastpath index --git\` or \`fastpath watch\`.`,
      '',
    );
  }
  if (delta.timedOut) {
    lines.push('Note: delta reindex timed out — retrieval may be stale.', '');
  }

  const hint = routingHint(prompt, hits.map((h) => h.path));
  if (hint) lines.push(hint, '');

  if (!hits.length) {
    lines.push('(no strong query matches — showing recency instead of nothing)', '');
    const pack = recencyPackLines(workspace);
    if (pack.length) lines.push(...pack);
    else lines.push('(index has no symbols yet — ask user for a path or symbol name)');
  }

  for (const hit of hits.slice(0, InjectLimits.MAX_HITS)) {
    lines.push(`- **${hit.symbol ?? hit.kind ?? 'hit'}** — \`${hitLoc(hit)}\``);
    if (hit.snippet) {
      lines.push(
        '```',
        hit.snippet.slice(0, InjectLimits.SNIPPET_MAX_CHARS),
        '```',
      );
    }
  }

  const memories = await recallRelevantMemories(
    workspace,
    prompt,
    hits.map((h) => h.path),
  );
  if (memories.length) {
    lines.push('', '## FastPath memory (auto-injected)', '');
    for (const m of memories) {
      // Flag memories whose referenced files changed — a stale fact is worse
      // than no fact.
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
      : creditLocateHits(workspace, hits.slice(0, InjectLimits.MAX_HITS));

  record(`${lines.join('\n')}\n`, {
    dirty: delta.dirty,
    deltaMs: delta.ms,
    retrieveMs,
    // Doctor/metrics: only count hits with a usable body window.
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
