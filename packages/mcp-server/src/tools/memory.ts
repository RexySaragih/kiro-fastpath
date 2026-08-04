import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { MEMORY_KINDS, type MemoryEntry } from '@fastpath/core';
import type { FastpathClient } from '../clients/fastpath-client.js';
import { toolErr, toolOk } from '../utils/format.js';

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
