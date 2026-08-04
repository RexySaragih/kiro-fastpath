import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MEMORY_KINDS, type MemoryEntry } from '@fastpath/core';
import type { FastpathClient } from '../clients/fastpath-client.js';
import { toolErr, toolOk } from '../utils/format.js';

const MEMORY_KIND_ENUM = ['decision', 'fact', 'preference', 'session'] as const;

export const memorySaveTool: Tool = {
  name: 'memory_save',
  description:
    'Persist a durable project memory (decision, fact, or preference) so future sessions recall it without re-deriving. Writes only to the local .fastpath store.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: [...MEMORY_KIND_ENUM],
        description: 'decision (why we chose X), fact (how Y works), preference (user style), session (auto)',
      },
      text: { type: 'string', description: 'One concise statement worth remembering' },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional topic tags',
      },
      paths: {
        type: 'array',
        items: { type: 'string' },
        description: 'Optional related file paths',
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
    'Semantic + keyword recall over saved project memories (decisions, facts, preferences, past sessions).',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to recall' },
      top_k: { type: 'number', description: 'Max memories (default 3, max 10)' },
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
  if (!memories.length) return `${title}\n\n(no memories found)`;
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
  if (!parsed.success) return toolErr(parsed.error.message);
  try {
    const saved = await client.memorySave(parsed.data);
    return toolOk(`Saved memory #${saved.id} (${saved.kind}): ${saved.text}`);
  } catch (err) {
    return toolErr(client.wrapError(err));
  }
}

export async function handleMemoryRecall(client: FastpathClient, args: unknown) {
  const parsed = recallSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  try {
    const memories = await client.memoryRecall(parsed.data.query, parsed.data.top_k);
    return toolOk(formatMemories(memories, `## memory_recall: ${parsed.data.query}`));
  } catch (err) {
    return toolErr(client.wrapError(err));
  }
}

// Keep the enum in sync with core at compile time.
type _AssertKinds = (typeof MEMORY_KIND_ENUM)[number] extends (typeof MEMORY_KINDS)[number]
  ? true
  : never;
const _assertKinds: _AssertKinds = true;
void _assertKinds;
