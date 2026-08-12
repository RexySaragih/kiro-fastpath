import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Rough token estimate — same 4-chars-per-token rule the CLI ledger uses. */
function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

test('advertised MCP surface is 4 tools under the fixed-overhead budget', async () => {
  const { findTool, impactTool } = await import(
    join(root, 'packages/mcp-server/dist/tools/search.js')
  );
  const { memoryTool } = await import(join(root, 'packages/mcp-server/dist/tools/memory.js'));
  const { windowTool } = await import(join(root, 'packages/mcp-server/dist/tools/window.js'));
  const tools = [findTool, impactTool, windowTool, memoryTool];
  assert.equal(tools.length, 4);

  const schemaTokens = estimateTokens(JSON.stringify(tools));
  const steeringTokens = estimateTokens(
    readFileSync(join(root, 'packages/agent-pack/steering/fastpath.md'), 'utf8') +
      readFileSync(join(root, 'packages/agent-pack/steering/caveman.md'), 'utf8') +
      readFileSync(join(root, 'packages/agent-pack/steering/ponytail.md'), 'utf8'),
  );
  // Window tool + always-on steering (retrieval + caveman + ponytail).
  assert.ok(
    schemaTokens + steeringTokens < 2800,
    `fixed per-turn overhead too high: schemas=${schemaTokens} steering=${steeringTokens}`,
  );
});

test('steering does not duplicate the tool-pick table', () => {
  const retrieval = readFileSync(
    join(root, 'packages/agent-pack/steering/fastpath.md'),
    'utf8',
  );
  const caveman = readFileSync(
    join(root, 'packages/agent-pack/steering/caveman.md'),
    'utf8',
  );
  const ponytail = readFileSync(
    join(root, 'packages/agent-pack/steering/ponytail.md'),
    'utf8',
  );
  assert.doesNotMatch(retrieval, /\| Need \| Tool \|/);
  assert.doesNotMatch(retrieval, /context_for_task|grep_fast|memory_recall|memory_save/);
  assert.match(retrieval, /grep -r/);
  assert.match(retrieval, /Architect/);
  assert.match(retrieval, /caveman\.md/);
  assert.match(caveman, /Caveman full/);
  assert.match(caveman, /MANDATORY on every response/);
  assert.match(caveman, /OUTPUT MODE = caveman full/);
  assert.match(ponytail, /lazy senior/i);
  assert.match(ponytail, /YAGNI/);
  assert.match(ponytail, /CODE MODE = ponytail full.*MANDATORY/i);
});

test('find dispatches every mode and memory round-trips through one tool', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const { FastpathClient } = await import(
    join(root, 'packages/mcp-server/dist/clients/fastpath-client.js')
  );
  const { handleFind } = await import(join(root, 'packages/mcp-server/dist/tools/search.js'));
  const { handleMemory } = await import(join(root, 'packages/mcp-server/dist/tools/memory.js'));

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-find-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);
    const client = new FastpathClient(dir);

    for (const [mode, query] of [
      ['search', 'validate token'],
      ['symbol', 'AuthService'],
      ['grep', 'class'],
      ['context', 'fix login validation'],
    ]) {
      const res = await handleFind(client, { query, mode });
      assert.notEqual(res.isError, true, `${mode} errored`);
      assert.ok(res.content[0].text.length > 0);
    }

    const saved = await handleMemory(client, {
      op: 'save',
      kind: 'decision',
      text: 'Collapsed the MCP surface to find/impact/memory.',
    });
    assert.notEqual(saved.isError, true);
    const recalled = await handleMemory(client, { text: 'MCP surface' });
    assert.match(recalled.content[0].text, /find\/impact\/memory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
