import { existsSync, watch, type FSWatcher } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { IgnoreMatcher } from '../ignore.js';
import {
  findDirtyFiles,
  getIndexStats,
  indexWorkspacePaths,
  removeIndexedPaths,
  type IndexResult,
} from '../index/indexer.js';
import { INDEXABLE_EXTENSIONS } from '../types.js';

export interface WatchOptions {
  debounceMs?: number;
  onIndexed?: (
    result: IndexResult & { removed: number },
    changed: string[],
  ) => void;
  onError?: (err: unknown) => void;
}

const DEFAULT_DEBOUNCE_MS = 400;
/** Polling cadence when recursive fs.watch is unavailable (older Linux/Node). */
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_FILES = 50;

function isIndexable(relPath: string): boolean {
  const base = relPath.split('/').pop() ?? '';
  const ext = base.includes('.') ? `.${base.split('.').pop()?.toLowerCase()}` : '';
  return INDEXABLE_EXTENSIONS.has(ext);
}

/**
 * Watch workspace for source changes and path-delta re-index.
 * Uses Node recursive fs.watch (macOS/Windows; Linux may need polling fallback).
 */
export function watchWorkspace(
  workspace: string,
  options: WatchOptions = {},
): { close: () => void } {
  const root = resolve(workspace);
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ignore = new IgnoreMatcher(root);
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let running = false;

  const flush = async (): Promise<void> => {
    if (closed || running) return;
    const changed = [...pending];
    pending.clear();
    if (!changed.length) return;
    running = true;
    try {
      const existing: string[] = [];
      const deleted: string[] = [];
      for (const rel of changed) {
        const abs = resolve(root, rel);
        if (existsSync(abs) && isIndexable(rel)) existing.push(abs);
        else deleted.push(rel);
      }
      const removed = removeIndexedPaths(root, deleted);
      const result =
        existing.length > 0
          ? await indexWorkspacePaths(root, existing)
          : {
              stats: getIndexStats(root),
              filesIndexed: 0,
              filesSkipped: 0,
              embedBackend: 'n/a',
              embedDim: 0,
            };
      options.onIndexed?.({ ...result, removed }, changed);
    } catch (err) {
      options.onError?.(err);
    } finally {
      running = false;
      if (pending.size) schedule();
    }
  };

  const schedule = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, debounceMs);
  };

  const onEvent = (event: string, filename: string | null): void => {
    if (!filename) return;
    const abs = resolve(root, filename);
    const rel = relative(root, abs).split(sep).join('/');
    if (!rel || rel.startsWith('..')) return;
    if (ignore.ignores(root, abs)) return;
    if (event !== 'rename' && !isIndexable(rel)) return;
    pending.add(rel);
    schedule();
  };

  let watcher: FSWatcher;
  try {
    watcher = watch(root, { recursive: true }, onEvent);
  } catch (err) {
    // Recursive fs.watch unsupported (older Linux/Node) — fall back to
    // hash-based dirty polling so `fastpath watch` still works everywhere.
    options.onError?.(err);
    return startPollingFallback(root, options);
  }

  watcher.on('error', (err) => options.onError?.(err));

  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      watcher.close();
    },
  };
}

function startPollingFallback(
  root: string,
  options: WatchOptions,
): { close: () => void } {
  let running = false;
  const interval = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const dirty = findDirtyFiles(root, POLL_MAX_FILES);
      if (dirty.length) {
        const result = await indexWorkspacePaths(root, dirty);
        options.onIndexed?.(
          { ...result, removed: 0 },
          dirty.map((p) => relative(root, p).split(sep).join('/')),
        );
      }
    } catch (err) {
      options.onError?.(err);
    } finally {
      running = false;
    }
  }, POLL_INTERVAL_MS);
  interval.unref?.();

  return {
    close: () => clearInterval(interval),
  };
}
