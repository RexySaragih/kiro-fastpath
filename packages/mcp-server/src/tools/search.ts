import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { HARD_MAX_TOP_K, type SearchHit } from '@fastpath/core';
import type { FastpathClient } from '../clients/fastpath-client.js';
import { recordLocateMetric, recordPlainMetric } from '../record-metric.js';
import { formatHits, toolErr, toolOk, zodErr } from '../utils/format.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const SYMBOL_KINDS = [
  'function',
  'class',
  'method',
  'interface',
  'type',
  'const',
  'variable',
  'export',
  'other',
] as const;

const PATH_PREFIX_DESC =
  'Optional workspace-relative directory/file prefix to restrict results, e.g. "src/modules/auth" or "test/". Filters by indexed path, not by filename glob.';

export const searchTool: Tool = {
  name: 'search',
  description:
    'Ranked hybrid code search (keyword FTS + vectors). ' +
    'USE when: you have a concept, behavior, or fuzzy topic ("login validation", "blacklist role") and need a few likely files/snippets. ' +
    'DO NOT use when: you already know the exact symbol name → use symbol; you need a regex/string literal in source → use grep_fast; you need callers/importers → use impact; you need a starter pack for a whole coding task → use context_for_task. ' +
    'Never listDirectory/glob the repo instead of this. Returns a small ranked hit list with short snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'Natural language or identifiers describing what to find, e.g. "JWT validation" or "BlacklistService". Not a regex.',
      },
      top_k: {
        type: 'number',
        description: `Max hits to return (default 8, max ${HARD_MAX_TOP_K}).`,
      },
      path_prefix: {
        type: 'string',
        description: PATH_PREFIX_DESC,
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const symbolTool: Tool = {
  name: 'symbol',
  description:
    'Look up a named code symbol (function/class/method/type/const) by identifier. ' +
    'USE when: you know or nearly know the symbol name ("AuthService", "validateJwt", "performVaultLogin"). ' +
    'DO NOT use when: the query is a phrase/concept with no identifier → use search; you need exact text/regex in file bodies → use grep_fast; you need who calls/imports a symbol → use impact after you have the name. ' +
    'Returns definition locations with optional kind filter.',
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'Exact or partial symbol identifier only (no spaces/prose). Example: "AuthService" or "validateJwt".',
      },
      kind: {
        type: 'string',
        enum: [
          'function',
          'class',
          'method',
          'interface',
          'type',
          'const',
          'variable',
          'export',
          'other',
        ],
        description: 'Optional symbol kind filter to narrow results.',
      },
      top_k: {
        type: 'number',
        description: `Max hits (default 8, max ${HARD_MAX_TOP_K}).`,
      },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const contextForTaskTool: Tool = {
  name: 'context_for_task',
  description:
    'One-shot context pack for starting a coding task: top entry-point files + short snippets + imports. ' +
    'USE when: beginning an edit/feature and you need a small starter set of files ("add blacklist export endpoint"). Prefer once per task before diving in. ' +
    'DO NOT use when: you only need one symbol → use symbol; you need a specific string/regex → use grep_fast; you need blast radius of a rename → use impact; you already have enough paths from auto-inject. ' +
    'Cap is small by design — not a full-repo dump.',
  inputSchema: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'Short natural-language coding task, e.g. "fix JWT expiry on login" or "add export to blacklist API".',
      },
      max_chunks: {
        type: 'number',
        description: 'Max code chunks to return (default 5, max 8).',
      },
    },
    required: ['task'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const grepFastTool: Tool = {
  name: 'grep_fast',
  description:
    'Search FILE CONTENTS (not filenames) with a regex or literal string. ' +
    'USE when: you need exact text, an API string, an error message, a decorator, or a regex in source lines (e.g. "describe\\\\(", "@Controller", "BLACKLIST_"). ' +
    'DO NOT use when: looking up a symbol definition by name → use symbol; semantic/"how does X work" → use search; filename patterns like "\\\\.test\\\\.ts" as the pattern (that matches text inside files, not paths) — instead set path_prefix to "test/" and use a content pattern. ' +
    'Prefer over listDirectory/glob/repo-wide shell grep.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Regex or literal matched against each source line (content only, never the path). Examples: "describe\\\\(", "validateJwt", "@Injectable".',
      },
      top_k: {
        type: 'number',
        description: `Max line matches (default 8, max ${HARD_MAX_TOP_K}).`,
      },
      path_prefix: {
        type: 'string',
        description: PATH_PREFIX_DESC,
      },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const impactTool: Tool = {
  name: 'impact',
  description:
    'Blast radius of a symbol: definitions, callers, importers, refs. Use before renames/API changes.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol identifier.' },
      depth: { type: 'number', description: 'Importer hops 1-3 (default 1).' },
      top_k: { type: 'number', description: 'Max items per section.' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

/**
 * `find` collapses search/symbol/grep_fast/context_for_task into one schema.
 * Four tool schemas + four long descriptions were shipped on every turn; one
 * mode parameter costs a fraction of that. Legacy names stay routable.
 */
export const findTool: Tool = {
  name: 'find',
  description:
    'Locate code in the indexed repo instead of listDirectory/glob/grep. ' +
    'Returns focused code windows (path:start-end + body) — prefer these over whole-file reads. ' +
    'Use `window` if you need a few more lines. ' +
    'mode: search=concept, symbol=identifier, grep=regex in file contents, context=task starter pack.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Concept, identifier, regex, or task.' },
      mode: {
        type: 'string',
        enum: ['search', 'symbol', 'grep', 'context'],
        description: 'Default search.',
      },
      kind: { type: 'string', enum: [...SYMBOL_KINDS], description: 'mode=symbol filter.' },
      top_k: { type: 'number', description: `Max results (8, cap ${HARD_MAX_TOP_K}).` },
      path_prefix: { type: 'string', description: 'Indexed path prefix, e.g. "src/auth".' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

const findSchema = z.object({
  query: z.string().min(1).max(1000),
  mode: z.enum(['search', 'symbol', 'grep', 'context']).optional(),
  kind: z.enum(SYMBOL_KINDS).optional(),
  top_k: z.number().int().positive().max(HARD_MAX_TOP_K).optional(),
  path_prefix: z.string().max(500).optional(),
});

export async function handleFind(client: FastpathClient, args: unknown) {
  const parsed = findSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  const { query, mode = 'search', kind, top_k, path_prefix } = parsed.data;
  switch (mode) {
    case 'symbol':
      return runHits(client, 'find', `## symbol: ${query}`, () =>
        client.symbol(query, kind, top_k),
        'No symbol matched. Try a shorter exact identifier (e.g. `AuthService`, not `auth service`). ' +
        'Use mode=search for concepts, or mode=grep for a literal string in file contents.',
      );
    case 'grep':
      return runHits(client, 'find', `## grep: ${query}`, () =>
        client.grep(query, top_k, path_prefix),
        'No grep match. FastPath grep matches a single literal string or simple regex — ' +
        'it does NOT support `|` alternation or `\\|` OR syntax. ' +
        'Call `find` once per term, or use mode=search/symbol for multi-term lookups.',
      );
    case 'context':
      return runHits(client, 'find', '## context', () =>
        client.context(query, top_k),
        'No context found for this task description. ' +
        'Try mode=symbol with an identifier from the task, or mode=search with a shorter concept phrase.',
      );
    default:
      return runHits(client, 'find', `## search: ${query}`, () =>
        client.search(query, top_k, path_prefix),
        'No semantic match. Try a shorter concept (e.g. `inject hit rate` not a full sentence), ' +
        'or switch to mode=symbol for a known identifier, mode=grep for a literal string.',
      );
  }
}

const searchSchema = z.object({
  query: z.string().min(1).max(500),
  top_k: z.number().int().positive().max(HARD_MAX_TOP_K).optional(),
  path_prefix: z.string().max(500).optional(),
});

const symbolSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z
    .enum([
      'function',
      'class',
      'method',
      'interface',
      'type',
      'const',
      'variable',
      'export',
      'other',
    ])
    .optional(),
  top_k: z.number().int().positive().max(HARD_MAX_TOP_K).optional(),
});

const contextSchema = z.object({
  task: z.string().min(1).max(1000),
  max_chunks: z.number().int().positive().max(8).optional(),
});

const grepSchema = z.object({
  pattern: z.string().min(1).max(300),
  top_k: z.number().int().positive().max(HARD_MAX_TOP_K).optional(),
  path_prefix: z.string().max(500).optional(),
});

const impactSchema = z.object({
  name: z.string().min(1).max(200),
  depth: z.number().int().min(1).max(3).optional(),
  top_k: z.number().int().positive().max(HARD_MAX_TOP_K).optional(),
});

export { resolveWorkspace } from '../workspace.js';

async function runHits(
  client: FastpathClient,
  tool: string,
  title: string,
  fn: () => SearchHit[] | Promise<SearchHit[]>,
  noMatchHint?: string,
) {
  try {
    const hits = await fn();
    const result = toolOk(formatHits(hits, title, noMatchHint));
    recordLocateMetric(tool, result, hits);
    return result;
  } catch (err) {
    const msg = client.wrapError(err);
    const result = toolErr(
      `${tool} failed: ${msg}. ` +
      'If the index is missing run `fastpath index`. ' +
      'If the query is a bad regex (grep mode), simplify it to a plain literal.',
    );
    recordLocateMetric(tool, result, []);
    return result;
  }
}

export async function handleSearch(client: FastpathClient, args: unknown) {
  const parsed = searchSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  return runHits(client, 'search', `## search: ${parsed.data.query}`, () =>
    client.search(parsed.data.query, parsed.data.top_k, parsed.data.path_prefix),
    'No semantic match. Try a shorter concept phrase, or switch to mode=symbol for a known identifier, mode=grep for a literal string.',
  );
}

export async function handleSymbol(client: FastpathClient, args: unknown) {
  const parsed = symbolSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  return runHits(client, 'symbol', `## symbol: ${parsed.data.name}`, () =>
    client.symbol(parsed.data.name, parsed.data.kind, parsed.data.top_k),
    'No symbol matched. Use the exact identifier (e.g. `AuthService`, not `auth service`). ' +
    'Use search for concepts, or grep for a literal string.',
  );
}

export async function handleContextForTask(client: FastpathClient, args: unknown) {
  const parsed = contextSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  return runHits(client, 'context_for_task', '## context_for_task', () =>
    client.context(parsed.data.task, parsed.data.max_chunks),
    'No context found. Try mode=symbol with a known identifier, or mode=search with a shorter concept phrase.',
  );
}

export async function handleGrepFast(client: FastpathClient, args: unknown) {
  const parsed = grepSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  return runHits(client, 'grep_fast', `## grep_fast: ${parsed.data.pattern}`, () =>
    client.grep(parsed.data.pattern, parsed.data.top_k, parsed.data.path_prefix),
    'No grep match. Use a single literal string or simple regex — `|` alternation is not supported. ' +
    'Call grep once per term, or use mode=symbol/search for multi-term lookups.',
  );
}

export async function handleImpact(client: FastpathClient, args: unknown) {
  const parsed = impactSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  try {
    const result = toolOk(
      client.impact(parsed.data.name, parsed.data.depth, parsed.data.top_k),
    );
    recordPlainMetric('impact', result);
    return result;
  } catch (err) {
    const result = toolErr(
      `impact failed: ${client.wrapError(err)}. ` +
      'Confirm the symbol exists first with find mode=symbol. ' +
      'If the index is missing run `fastpath index`.',
    );
    recordPlainMetric('impact', result);
    return result;
  }
}
