#!/usr/bin/env node
/**
 * PostFileSave / PostFileCreate / PostFileDelete hook helper.
 * Keeps the index warm as the agent edits: delta-indexes (or removes) the
 * reported file immediately, so prompt-time injection rarely finds dirty files.
 * Always exits 0 — freshness must never break the agent loop.
 */
import { extname, isAbsolute, resolve } from 'node:path';
import {
  findDirtyFiles,
  INDEXABLE_EXTENSIONS,
  indexWorkspacePaths,
  removeIndexedPaths,
} from '@fastpath/core';
import {
  extractFilePaths,
  parseHookPayload,
  readStdinText,
  recordHeartbeat,
  recordHookPayload,
  workspaceFromPayload,
  withTimeout,
} from './hook-util.js';
import { appendMetric } from './metrics.js';
import { recordTouchedPaths } from './state.js';

const FILE_EVENT_BUDGET_MS = 10_000;
/** When the payload shape is unknown, fall back to a small dirty scan. */
const FALLBACK_DIRTY_CAP = 5;

function isIndexable(path: string): boolean {
  return INDEXABLE_EXTENSIONS.has(extname(path).toLowerCase());
}

async function run(): Promise<void> {
  const isDelete = process.argv.includes('--delete');
  const isCreate = process.argv.includes('--create');
  const hookName = isDelete ? 'file-delete' : isCreate ? 'file-create' : 'file-save';
  recordHeartbeat(hookName);
  const raw = await readStdinText();
  const payload = parseHookPayload(raw);
  recordHookPayload(hookName, raw, payload);
  const workspace = workspaceFromPayload(payload);
  const sessionId =
    (typeof payload.session_id === 'string' && payload.session_id) ||
    (typeof payload.sessionId === 'string' && payload.sessionId) ||
    '';
  const started = Date.now();

  const reported = extractFilePaths(payload).filter(isIndexable);

  if (isDelete) {
    if (!reported.length) return;
    const removed = removeIndexedPaths(workspace, reported);
    appendMetric({
      type: 'file-event',
      at: new Date().toISOString(),
      workspace,
      action: 'delete',
      files: removed,
      ms: Date.now() - started,
    });
    console.error(`[fastpath file-event] removed=${removed}`);
    return;
  }

  const absPaths = reported.length
    ? reported.map((p) => (isAbsolute(p) ? p : resolve(workspace, p)))
    : findDirtyFiles(workspace, FALLBACK_DIRTY_CAP);

  if (!absPaths.length) return;

  const raced = await withTimeout(
    indexWorkspacePaths(workspace, absPaths),
    FILE_EVENT_BUDGET_MS,
  );
  const indexed = raced.value?.filesIndexed ?? 0;
  recordTouchedPaths(workspace, absPaths, sessionId); // feeds Stop-hook session memory
  appendMetric({
    type: 'file-event',
    at: new Date().toISOString(),
    workspace,
    action: 'index',
    files: indexed,
    ms: Date.now() - started,
  });
  console.error(
    `[fastpath file-event] indexed=${indexed} reported=${reported.length} timedOut=${raced.timedOut}`,
  );
}

run()
  .catch((err) => {
    console.error('[fastpath file-event]', err instanceof Error ? err.message : err);
  })
  .finally(() => {
    process.exit(0);
  });
