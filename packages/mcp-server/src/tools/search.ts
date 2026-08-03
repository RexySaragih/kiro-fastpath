import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { HARD_MAX_TOP_K, type SearchHit } from '@fastpath/core';
import type { FastpathClient } from '../clients/fastpath-client.js';
import { formatHits, toolErr, toolOk } from '../utils/format.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const searchTool: Tool = {
  name: 'search',
  description:
    'Hybrid search (FTS5 BM25 + feature-hash vectors via RRF). Prefer before walking the repo. Returns few ranked hits with short snippets.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (identifiers or natural language)' },
      top_k: {
        type: 'number',
        description: `Max results (default 8, max ${HARD_MAX_TOP_K})`,
      },
      path_prefix: {
        type: 'string',
        description: 'Optional path prefix filter, e.g. src/auth',
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
    'Exact/fuzzy symbol lookup by name (functions, classes, methods, types).',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name or partial name' },
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
      },
      top_k: { type: 'number', description: 'Max results (default 8)' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const contextForTaskTool: Tool = {
  name: 'context_for_task',
  description:
    'One-shot context pack for a coding task: top entry points + snippets + imports. Cap is small by design.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'Natural-language task description' },
      max_chunks: {
        type: 'number',
        description: 'Max code chunks (default 5, max 8)',
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
    'Fast regex/literal search using sparse n-gram index prefilter, then verify matches. Prefer over scanning the whole tree.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex or literal pattern',
      },
      top_k: { type: 'number', description: 'Max matches (default 8)' },
      path_prefix: { type: 'string', description: 'Optional path prefix filter' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

export const impactTool: Tool = {
  name: 'impact',
  description:
    'Blast-radius for a symbol: definitions, callers (call graph), importers (import edges), and textual references.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Symbol name' },
      depth: {
        type: 'number',
        description: 'Importer traversal depth (1-3, default 1)',
      },
      top_k: { type: 'number', description: 'Max items per section' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

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

export function resolveWorkspace(): string {
  return process.env.FASTPATH_WORKSPACE?.trim() || process.cwd();
}

async function runHits(
  client: FastpathClient,
  title: string,
  fn: () => SearchHit[] | Promise<SearchHit[]>,
) {
  try {
    return toolOk(formatHits(await fn(), title));
  } catch (err) {
    return toolErr(client.wrapError(err));
  }
}

export async function handleSearch(client: FastpathClient, args: unknown) {
  const parsed = searchSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  return runHits(client, `## search: ${parsed.data.query}`, () =>
    client.search(parsed.data.query, parsed.data.top_k, parsed.data.path_prefix),
  );
}

export async function handleSymbol(client: FastpathClient, args: unknown) {
  const parsed = symbolSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  return runHits(client, `## symbol: ${parsed.data.name}`, () =>
    client.symbol(parsed.data.name, parsed.data.kind, parsed.data.top_k),
  );
}

export async function handleContextForTask(client: FastpathClient, args: unknown) {
  const parsed = contextSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  return runHits(client, '## context_for_task', () =>
    client.context(parsed.data.task, parsed.data.max_chunks),
  );
}

export async function handleGrepFast(client: FastpathClient, args: unknown) {
  const parsed = grepSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  return runHits(client, `## grep_fast: ${parsed.data.pattern}`, () =>
    client.grep(parsed.data.pattern, parsed.data.top_k, parsed.data.path_prefix),
  );
}

export async function handleImpact(client: FastpathClient, args: unknown) {
  const parsed = impactSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  try {
    return toolOk(
      client.impact(parsed.data.name, parsed.data.depth, parsed.data.top_k),
    );
  } catch (err) {
    return toolErr(client.wrapError(err));
  }
}
