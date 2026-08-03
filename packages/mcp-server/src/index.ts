#!/usr/bin/env node

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
  contextForTaskTool,
  grepFastTool,
  handleContextForTask,
  handleGrepFast,
  handleImpact,
  handleSearch,
  handleSymbol,
  impactTool,
  resolveWorkspace,
  searchTool,
  symbolTool,
} from './tools/search.js';

const SERVER_NAME = 'fastpath-mcp';
const SERVER_VERSION = '0.2.0';

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
  const tools = [
    searchTool,
    symbolTool,
    contextForTaskTool,
    grepFastTool,
    impactTool,
  ];

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = request.params.arguments ?? {};
    const started = Date.now();
    try {
      let result;
      switch (name) {
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
