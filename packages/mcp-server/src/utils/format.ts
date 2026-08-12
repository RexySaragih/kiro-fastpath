import type { SearchHit } from '@fastpath/core';

/** Flatten Zod issues to a readable one-liner. */
export function zodErr(err: import('zod').ZodError): string {
  return err.issues.map((i) => `${i.path.length ? i.path.join('.') + ': ' : ''}${i.message}`).join('; ');
}

export function toolOk(text: string): {
  content: Array<{ type: 'text'; text: string }>;
} {
  return { content: [{ type: 'text', text }] };
}

export function toolErr(message: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
}

/** Prefer `path:start-end` when a focused window is present. */
export function formatHitLoc(hit: SearchHit): string {
  if (hit.startLine != null && hit.endLine != null) {
    return hit.startLine === hit.endLine
      ? `${hit.path}:${hit.startLine}`
      : `${hit.path}:${hit.startLine}-${hit.endLine}`;
  }
  return hit.line ? `${hit.path}:${hit.line}` : hit.path;
}

export function formatHits(hits: SearchHit[], title: string, noMatchHint?: string): string {
  if (!hits.length) {
    const hint = noMatchHint ?? 'No matches. If the index is empty/stale run `fastpath index` to rebuild; otherwise try a different query or mode (search/symbol/grep).';
    return `${title}\n\n${hint}`;
  }
  const lines = [title, ''];
  for (const hit of hits) {
    const loc = formatHitLoc(hit);
    const head = hit.symbol
      ? `- **${hit.symbol}** (${hit.kind ?? 'symbol'}) — \`${loc}\``
      : `- \`${loc}\`${hit.kind ? ` (${hit.kind})` : ''}`;
    lines.push(head);
    if (hit.snippet) {
      lines.push('```', hit.snippet, '```');
    }
    lines.push('');
  }
  lines.push(
    'Prefer these windows for edits. Use FastPath `window` for more lines — avoid whole-file host reads.',
  );
  return lines.join('\n').trimEnd();
}
