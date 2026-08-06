import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { readWindow, WindowLimits } from '@fastpath/core';
import { recordWindowMetric } from '../record-metric.js';
import { toolErr, toolOk } from '../utils/format.js';
import { resolveWorkspace } from '../workspace.js';

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const windowTool: Tool = {
  name: 'window',
  description:
    'Read a focused line-range from an indexed workspace file. ' +
    'USE when: find/impact gave a path but you need a few more lines (or a known span). ' +
    'DO NOT use when: you need to discover where code lives → use find first. ' +
    'Prefer this over host whole-file reads. Caps apply (max lines/chars).',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Workspace-relative path, e.g. "src/auth.ts".',
      },
      start_line: {
        type: 'number',
        description: '1-based inclusive start line.',
      },
      end_line: {
        type: 'number',
        description: `1-based inclusive end line (capped at ${WindowLimits.MAX_LINES} lines).`,
      },
    },
    required: ['path', 'start_line', 'end_line'],
    additionalProperties: false,
  },
  annotations: READ_ONLY,
};

const windowSchema = z.object({
  path: z.string().min(1).max(500),
  start_line: z.number().int().positive().max(1_000_000),
  end_line: z.number().int().positive().max(1_000_000),
});

export function handleWindow(args: unknown) {
  const parsed = windowSchema.safeParse(args);
  if (!parsed.success) return toolErr(parsed.error.message);
  const { path, start_line, end_line } = parsed.data;
  if (end_line < start_line) {
    return toolErr('end_line must be >= start_line');
  }
  try {
    const win = readWindow(resolveWorkspace(), path, start_line, end_line);
    const loc =
      win.startLine === win.endLine
        ? `${win.path}:${win.startLine}`
        : `${win.path}:${win.startLine}-${win.endLine}`;
    const note = win.clamped ? '\n(clamped to file/caps)\n' : '\n';
    const result = toolOk(
      `## window: \`${loc}\`${note}\`\`\`\n${win.body}\n\`\`\``,
    );
    recordWindowMetric(result, win.path, win.body);
    return result;
  } catch (err) {
    const result = toolErr(err instanceof Error ? err.message : String(err));
    recordWindowMetric(result, path, '');
    return result;
  }
}
