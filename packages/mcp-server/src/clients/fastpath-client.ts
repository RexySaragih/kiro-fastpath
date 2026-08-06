import {
  contextForTask,
  DEFAULT_TOP_K,
  formatImpact,
  grepFast,
  impactForSymbol,
  lookupSymbol,
  readWindow,
  recallMemories,
  saveMemory,
  searchIndex,
  type CodeWindow,
  type MemoryEntry,
  type SaveMemoryInput,
  type SearchHit,
} from '@fastpath/core';
import { sanitizeErrorMessage } from './base-client.js';

export class FastpathClient {
  constructor(private readonly workspace: string) {}

  async search(
    query: string,
    topK?: number,
    pathPrefix?: string,
  ): Promise<SearchHit[]> {
    return searchIndex(this.workspace, query, {
      topK,
      pathPrefix,
    });
  }

  symbol(name: string, kind?: string, topK?: number): SearchHit[] {
    return lookupSymbol(this.workspace, name, { kind, topK });
  }

  async context(task: string, maxChunks?: number): Promise<SearchHit[]> {
    return contextForTask(this.workspace, task, maxChunks);
  }

  grep(pattern: string, topK?: number, pathPrefix?: string): SearchHit[] {
    return grepFast(this.workspace, pattern, { topK, pathPrefix });
  }

  impact(name: string, depth?: number, topK?: number): string {
    return formatImpact(
      impactForSymbol(this.workspace, name, {
        depth,
        topK: topK ?? DEFAULT_TOP_K,
      }),
    );
  }

  window(path: string, startLine: number, endLine: number): CodeWindow {
    return readWindow(this.workspace, path, startLine, endLine);
  }

  async memorySave(input: SaveMemoryInput): Promise<MemoryEntry> {
    return saveMemory(this.workspace, input);
  }

  async memoryRecall(query: string, topK?: number): Promise<MemoryEntry[]> {
    return recallMemories(this.workspace, query, topK);
  }

  wrapError(err: unknown): string {
    return sanitizeErrorMessage(err);
  }
}
