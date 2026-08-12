import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MEMORY_KINDS, type MemoryEntry } from '@fastpath/core';
import type { FastpathClient } from '../clients/fastpath-client.js';
import { recordPlainMetric } from '../record-metric.js';
import { toolErr, toolOk, zodErr } from '../utils/format.js';

const MEMORY_KIND_ENUM = ['decision', 'fact', 'preference', 'session'] as const;

export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    'Save one durable project memory into the local .fastpath store for later recall. ' +
    'USE when: you (or the user) made a lasting decision, established a fact about the codebase, or captured a preference worth reusing next session. ' +
    'DO NOT use when: looking up code (use search/symbol/grep_fast); recalling past notes (use memory_recall); dumping long chat transcripts or secrets. ' +
    'Write one concise statement. kind=session is for automatic turn summaries — prefer decision|fact|preference for manual saves.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...MEMORY_KIND_ENUM],
        description:
          'decision = why we chose X; fact = how Y works in this repo; preference = user/style constraint; session = auto turn summary (avoid manual use).',
      },
      text: {
        type: 'string',
        description:
          'Single concise memorable statement (1–2 sentences). Example: "Auth uses validateJwt in src/auth.ts; tokens expire in 15m."',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional short topic tags, e.g. ["auth", "jwt"].',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional related workspace-relative file paths, e.g. ["src/auth.ts"].',
      },
    },
    required: ['kind', 'text'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export const memoryRecallTool: Tool = {
  name: 'memory_recall',
  description:
    'Recall previously saved project memories (decisions/facts/preferences/sessions) via keyword + semantic match. ' +
    'USE when: before re-deriving project knowledge ("what auth approach did we pick?", "user prefers X"). ' +
    'DO NOT use when: searching source code (use search/symbol/grep_fast); saving a new memory (use memory_save). ' +
    'Returns short memory lines, not file contents.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'What to recall in plain language, e.g. "auth token expiry" or "blacklist export decision".',
      },
      top_k: {
        type: 'number',
        description: 'Max memories to return (default 3, max 10).',
      },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

/** One schema for both memory operations — half the per-turn tool overhead. */
export const memoryTool: Tool = {
  name: 'memory',
  description:
    'Project memory. op=recall past decisions/facts; op=save one durable line; ' +
    'op=list recent memories; op=forget by id (text = numeric id).',
  inputSchema: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['recall', 'save', 'list', 'forget'],
        description: 'Default recall. list ignores text. forget: text = memory id.',
      },
      text: {
        type: 'string',
        description: 'recall: query. save: the memory line. forget: numeric id. list: unused.',
      },
      kind: { type: 'string', enum: [...MEMORY_KIND_ENUM], description: 'save only.' },
      tags: { type: 'array', items: { type: 'string' }, description: 'save only.' },
      paths: { type: 'array', items: { type: 'string' }, description: 'save only.' },
      top_k: { type: 'number', description: 'recall/list (default 3 / 20).' },
    },
    required: [],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const memorySchema = z.object({
  op: z.enum(['recall', 'save', 'list', 'forget']).optional(),
  text: z.string().max(2000).optional(),
  kind: z.enum(MEMORY_KIND_ENUM).optional(),
  tags: z.array(z.string().max(50)).max(10).optional(),
  paths: z.array(z.string().max(300)).max(10).optional(),
  top_k: z.number().int().positive().max(100).optional(),
});

export async function handleMemory(client: FastpathClient, args: unknown) {
  const parsed = memorySchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  const { op = 'recall', text, kind, tags, paths, top_k } = parsed.data;

  if (op === 'list') {
    try {
      const memories = client.memoryList(top_k ?? 20);
      const result = toolOk(formatMemories(memories, '## memory list'));
      recordPlainMetric('memory', result, memories.length);
      return result;
    } catch (err) {
      const result = toolErr(client.wrapError(err));
      recordPlainMetric('memory', result);
      return result;
    }
  }

  if (op === 'forget') {
    const id = Number(text);
    if (!Number.isFinite(id) || id <= 0) {
      return toolErr(
        'forget requires text = numeric memory id (e.g. text="42"). ' +
        'Call op=list first to see saved memories and their ids.',
      );
    }
    try {
      const ok = client.memoryForget(id);
      const result = toolOk(ok ? `Forgot memory #${id}` : `No memory #${id} — call op=list to see valid ids.`);
      recordPlainMetric('memory', result);
      return result;
    } catch (err) {
      const result = toolErr(client.wrapError(err));
      recordPlainMetric('memory', result);
      return result;
    }
  }

  if (!text?.trim()) {
    return toolErr(
      op === 'save'
        ? 'save requires text = the memory statement to store (1–2 sentences).'
        : 'recall requires text = your query string (e.g. "auth token expiry").',
    );
  }

  if (op === 'save') {
    return handleMemorySave(client, { kind: kind ?? 'fact', text, tags, paths });
  }
  return handleMemoryRecall(client, { query: text, top_k });
}

const saveSchema = z.object({
  kind: z.enum(MEMORY_KIND_ENUM),
  text: z.string().min(1).max(2000),
  tags: z.array(z.string().max(50)).max(10).optional(),
  paths: z.array(z.string().max(300)).max(10).optional(),
});

const recallSchema = z.object({
  query: z.string().min(1).max(500),
  top_k: z.number().int().positive().max(10).optional(),
});

export function formatMemories(memories: MemoryEntry[], title: string): string {
  if (!memories.length) return `${title}\n\n(no memories saved yet — use op=save to store decisions/facts/preferences)`;
  const lines = [title, ''];
  for (const m of memories) {
    const paths = m.paths.length ? ` — \`${m.paths.join('`, `')}\`` : '';
    const tags = m.tags.length ? ` [${m.tags.join(', ')}]` : '';
    lines.push(`- (#${m.id} ${m.kind}${tags}) ${m.text}${paths}`);
  }
  return lines.join('\n');
}

export async function handleMemorySave(client: FastpathClient, args: unknown) {
  const parsed = saveSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  try {
    const saved = await client.memorySave(parsed.data);
    const result = toolOk(`Saved memory #${saved.id} (${saved.kind}): ${saved.text}`);
    recordPlainMetric('memory', result);
    return result;
  } catch (err) {
    const result = toolErr(client.wrapError(err));
    recordPlainMetric('memory', result);
    return result;
  }
}

export async function handleMemoryRecall(client: FastpathClient, args: unknown) {
  const parsed = recallSchema.safeParse(args);
  if (!parsed.success) return toolErr(zodErr(parsed.error));
  try {
    const memories = await client.memoryRecall(parsed.data.query, parsed.data.top_k);
    const result = toolOk(
      formatMemories(memories, `## memory_recall: ${parsed.data.query}`),
    );
    recordPlainMetric('memory', result, memories.length);
    return result;
  } catch (err) {
    const result = toolErr(client.wrapError(err));
    recordPlainMetric('memory', result);
    return result;
  }
}

// Keep the enum in sync with core at compile time.
type _AssertKinds = (typeof MEMORY_KIND_ENUM)[number] extends (typeof MEMORY_KINDS)[number]
  ? true
  : never;
const _assertKinds: _AssertKinds = true;
void _assertKinds;
