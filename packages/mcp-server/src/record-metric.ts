import {
  appendMetric,
  creditLocateHits,
  creditWindowRead,
  estimateTokens,
  type SearchHit,
} from '@fastpath/core';
import { resolveWorkspace } from './workspace.js';

function responseText(result: {
  content?: Array<{ type: string; text?: string }>;
}): string {
  const parts = result.content ?? [];
  return parts
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n');
}

/** Record a locate-style MCP call (find / search / symbol / grep / context). */
export function recordLocateMetric(
  tool: string,
  result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  hits: SearchHit[],
): void {
  const ok = result.isError !== true;
  const responseTokens = estimateTokens(responseText(result));
  const workspace = resolveWorkspace();
  if (!ok || !hits.length) {
    appendMetric({
      type: 'mcp',
      at: new Date().toISOString(),
      workspace,
      tool,
      ok,
      hits: hits.length,
      responseTokens,
      windowVsFileTokens: 0,
      discoveryTokens: 0,
      paths: [],
    });
    return;
  }
  const credit = creditLocateHits(workspace, hits);
  appendMetric({
    type: 'mcp',
    at: new Date().toISOString(),
    workspace,
    tool,
    ok: true,
    hits: hits.length,
    responseTokens,
    windowVsFileTokens: credit.windowVsFileTokens,
    discoveryTokens: credit.discoveryTokens,
    paths: credit.paths,
  });
}

/** Record a window MCP call. */
export function recordWindowMetric(
  result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  path: string,
  body: string,
): void {
  const ok = result.isError !== true;
  const responseTokens = estimateTokens(responseText(result));
  const workspace = resolveWorkspace();
  if (!ok) {
    appendMetric({
      type: 'mcp',
      at: new Date().toISOString(),
      workspace,
      tool: 'window',
      ok: false,
      hits: 0,
      responseTokens,
      windowVsFileTokens: 0,
      discoveryTokens: 0,
      paths: [],
    });
    return;
  }
  const credit = creditWindowRead(
    workspace,
    path,
    estimateTokens(body),
  );
  appendMetric({
    type: 'mcp',
    at: new Date().toISOString(),
    workspace,
    tool: 'window',
    ok: true,
    hits: 1,
    responseTokens,
    windowVsFileTokens: credit.windowVsFileTokens,
    discoveryTokens: 0,
    paths: credit.paths,
  });
}

/** Memory / impact / other: measured response only (no window-vs-file in v1). */
export function recordPlainMetric(
  tool: string,
  result: { content?: Array<{ type: string; text?: string }>; isError?: boolean },
  hits = 0,
): void {
  appendMetric({
    type: 'mcp',
    at: new Date().toISOString(),
    workspace: resolveWorkspace(),
    tool,
    ok: result.isError !== true,
    hits,
    responseTokens: estimateTokens(responseText(result)),
    windowVsFileTokens: 0,
    discoveryTokens: 0,
    paths: [],
  });
}
