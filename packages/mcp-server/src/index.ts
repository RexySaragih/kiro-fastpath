#!/usr/bin/env node

import { createRequire } from 'node:module';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { warnIfRepoDotEnvPresent } from './clients/base-client.js';
import { FastpathClient } from './clients/fastpath-client.js';
import {
  handleMemory,
  handleMemoryRecall,
  handleMemorySave,
  memoryTool,
} from './tools/memory.js';
import {
  findTool,
  handleContextForTask,
  handleFind,
  handleGrepFast,
  handleImpact,
  handleSearch,
  handleSymbol,
  impactTool,
} from './tools/search.js';
import { handleWindow, windowTool } from './tools/window.js';
import { resolveWorkspace } from './workspace.js';

const SERVER_NAME = 'fastpath-mcp';

function readServerVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../package.json') as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SERVER_VERSION = readServerVersion();

const server = new Server(
  { name: SERVER_NAME, version: SERVER_VERSION },
  { capabilities: { tools: {} } },
);

function logTool(tool: string, status: 'ok' | 'error', durationMs: number): void {
  console.error(
    `[mcp=${SERVER_NAME} tool=${tool} status=${status} duration_ms=${durationMs} workspace=${resolveWorkspace()}]`,
  );
}

async function start(): Promise<void> {
  warnIfRepoDotEnvPresent();
  const client = new FastpathClient(resolveWorkspace());
  // Advertised surface is 4 tools; legacy names stay callable below so
  // older agent profiles keep working without paying for extra schemas.
  const tools = [findTool, impactTool, windowTool, memoryTool];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const started = Date.now();
    try {
      let result;
      switch (name) {
        case 'find':
          result = await handleFind(client, args);
          break;
        case 'memory':
          result = await handleMemory(client, args);
          break;
        case 'window':
          result = handleWindow(args);
          break;
        case 'search':
          result = await handleSearch(client, args);
          break;
        case 'symbol':
          result = await handleSymbol(client, args);
          break;
        case 'context_for_task':
          result = await handleContextForTask(client, args);
          break;
        case 'grep_fast':
          result = await handleGrepFast(client, args);
          break;
        case 'impact':
          result = await handleImpact(client, args);
          break;
        case 'memory_save':
          result = await handleMemorySave(client, args);
          break;
        case 'memory_recall':
          result = await handleMemoryRecall(client, args);
          break;
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
      const failed = 'isError' in result && result.isError === true;
      logTool(name, failed ? 'error' : 'ok', Date.now() - started);
      return result;
    } catch (err) {
      logTool(name, 'error', Date.now() - started);
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[mcp=${SERVER_NAME} status=ready version=${SERVER_VERSION} workspace=${resolveWorkspace()}]`,
  );
}

start().catch((err) => {
  console.error(`[mcp=${SERVER_NAME} status=fatal]`, err);
  process.exit(1);
});
