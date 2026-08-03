import type { SearchHit } from '@fastpath/core';

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

export function formatHits(hits: SearchHit[], title: string): string {
  if (!hits.length) return `${title}\n\n(no matches — run \`fastpath index\` if the index is empty/stale)`;
  const lines = [title, ''];
  for (const hit of hits) {
    const loc = hit.line ? `${hit.path}:${hit.line}` : hit.path;
    const head = hit.symbol
      ? `- **${hit.symbol}** (${hit.kind ?? 'symbol'}) — \`${loc}\``
      : `- \`${loc}\`${hit.kind ? ` (${hit.kind})` : ''}`;
    lines.push(head);
    if (hit.snippet) {
      lines.push('```');
      lines.push(hit.snippet);
      lines.push('```');
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
