/**
 * Tooltip copy for viz section titles and KPI labels.
 * What it is + how it is calculated.
 */

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export const TIPS = {
  files: {
    label: 'Files',
    body: 'Count of indexed files in this workspace SQLite index (rows in the files table).',
  },
  symbols: {
    label: 'Symbols',
    body: 'Count of extracted symbols in this workspace (rows in the symbols table).',
  },
  imports: {
    label: 'Imports',
    body: 'Import/require edges in this workspace (rows in the edges table).',
  },
  callEdges: {
    label: 'Call edges',
    body: 'Function-call edges in this workspace (rows in the call_edges table).',
  },
  vectors: {
    label: 'Vectors',
    body: 'Embedding rows for semantic search (rows in the symbol_vectors table).',
  },
  ngrams: {
    label: 'N-grams',
    body: 'Lexical n-gram postings used by grep/search (rows in the ngrams table).',
  },
  memories: {
    label: 'Memories',
    body: 'Saved agent notes stored in this workspace index (rows in the memories table).',
  },
  coverage: {
    label: 'Coverage',
    body: 'Embedding fill: symbol_vectors count / symbols count for this workspace.',
  },
  injectHit: {
    label: 'Hit (all)',
    body: 'Share of retrieval injects with hits > 0. Excludes noPrompt. Shows 0% (no retrieval) when injects exist but none queried; -- when events exist but no injects; n/a only with zero events. Gauge uses this when retrieval injects exist; otherwise MCP ok/calls.',
  },
  injectHitCode: {
    label: 'Hit (code)',
    body: 'Share of injects tagged intent=code with hits > 0. Needs intent on journal rows (new injects). -- when no code-intent samples yet.',
  },
  injected: {
    label: 'Injected',
    body: 'Sum of measured inject STDOUT tokens (ceil(chars/4)).',
  },
  mcpOut: {
    label: 'MCP out',
    body: 'Sum of measured MCP tool response tokens (ceil(chars/4) of response text).',
  },
  spent: {
    label: 'Spent',
    body: 'Measured spend: Injected + MCP out.',
  },
  walkBlock: {
    label: 'Walk block ≈',
    body: 'Sum of guardrail tokensAvoided. Flat ~1200 when a listing walk is blocked.',
  },
  windowVsFile: {
    label: 'Window vs file ≈',
    body: 'Estimated full-file tokens minus delivered window, path-deduped, cap 8000/file.',
  },
  discover: {
    label: 'Discover ≈',
    body: 'Estimated directory-list tokens, credited once per session when locate hits.',
  },
  avoided: {
    label: 'Avoided ≈',
    body: 'Estimate: walk block + window-vs-file + discover. Not measured. Labeled ≈.',
  },
  net: {
    label: 'Net ≈',
    body: 'Avoided − Spent (mixed honesty: estimate minus measured).',
  },
  p50Delta: {
    label: 'p50 Δ ms',
    body: 'Median inject deltaMs (time to build the prompt inject).',
  },
  timeouts: {
    label: 'Timeouts',
    body: 'Injects with timedOutDelta or timedOutRetrieve in this pane.',
  },
  events: {
    label: 'Events',
    body: 'Journal rows in this pane (user-level metrics.jsonl, scoped as labeled).',
  },
  injects: {
    label: 'Injects',
    body: 'Prompt-inject journal rows in this pane.',
  },
  indexDoctor: {
    label: 'Index / doctor',
    body: 'Index runs / doctor runs in this pane (metrics.jsonl type=index and type=doctor).',
  },
  mcpOk: {
    label: 'MCP ok',
    body: 'Successful MCP tool calls / all MCP calls in this pane.',
  },
  walksBlocked: {
    label: 'Walks blocked',
    body: 'Guardrail blocks / listing walks seen in this pane.',
  },
  filesByFolder: {
    label: 'Files by folder',
    body: 'Indexed files grouped by top folder (src/packages/apps + next segment); top 20.',
  },
  symbolKinds: {
    label: 'Symbol kinds',
    body: 'Symbol counts grouped by kind (GROUP BY symbols.kind).',
  },
  languages: {
    label: 'Languages',
    body: 'Indexed file counts by files.language.',
  },
  heaviestFiles: {
    label: 'Heaviest files',
    body: 'Top 15 paths by symbol count. Bar is relative to the max in that list.',
  },
  callGraph: {
    label: 'Call graph',
    body: 'Top callees by inbound call_edges, noise names filtered, cap 48 nodes / 90 edges.',
  },
  memoriesList: {
    label: 'Memories',
    body: 'Last 50 memory rows in this workspace index, newest id first.',
  },
  usageProject: {
    label: 'Usage · this workspace',
    body: 'metrics.jsonl rows whose workspace path matches this repo (normalized). Untagged excluded.',
  },
  usageGlobal: {
    label: 'Usage · all FastPath',
    body: 'All rows in the user-level journal (every repo on this machine).',
  },
  workspaces: {
    label: 'Workspaces',
    body: 'Journal rollup grouped by workspace field. Untagged rows bucket as (untagged). Temp dirs (/var/folders, /tmp) collapse under Ephemeral.',
  },
  eventMix: {
    label: 'Event mix',
    body: 'Journal event counts by type: inject, mcp, guardrail, index, doctor, other.',
  },
  actions: {
    label: 'Actions',
    body: 'Doctor-style next steps from this pane: low hit rate, no MCP, net negative, coverage 0, timeouts, or empty journal.',
  },
} as const;

export type TipId = keyof typeof TIPS;

export const VIZ_TIP_IDS = Object.keys(TIPS) as TipId[];

function tipMark(id: TipId): string {
  const t = TIPS[id];
  return `<span class="tip" data-tip="${id}" tabindex="0"><span class="tip-mark" aria-label="About ${escapeHtml(t.label)}">?</span><span class="tip-body">${escapeHtml(t.body)}</span></span>`;
}

export function sectionTitle(id: TipId): string {
  return `<h2>${escapeHtml(TIPS[id].label)}${tipMark(id)}</h2>`;
}

export function kpiLabel(id: TipId, tag: 'div' | 'span' = 'span'): string {
  return `<${tag} class="k">${escapeHtml(TIPS[id].label)}${tipMark(id)}</${tag}>`;
}
