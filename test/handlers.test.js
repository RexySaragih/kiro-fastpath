import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('mcp handlers return markdown and reject bad input', async () => {
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const {
    handleSearch,
    handleSymbol,
    handleGrepFast,
    handleImpact,
    handleContextForTask,
  } = await import(join(root, 'packages/mcp-server/dist/tools/search.js'));
  const { FastpathClient } = await import(
    join(root, 'packages/mcp-server/dist/clients/fastpath-client.js')
  );

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-handlers-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);
    const client = new FastpathClient(dir);

    const bad = await handleSearch(client, {});
    assert.equal(bad.isError, true);

    const ok = await handleSearch(client, { query: 'AuthService' });
    assert.equal(ok.isError, undefined);
    assert.match(ok.content[0].text, /search/);

    assert.match(
      (await handleSymbol(client, { name: 'AuthService' })).content[0].text,
      /symbol/,
    );
    assert.match(
      (await handleGrepFast(client, { pattern: 'login' })).content[0].text,
      /grep_fast/,
    );
    assert.match(
      (await handleImpact(client, { name: 'AuthService' })).content[0].text,
      /impact/,
    );
    assert.match(
      (await handleContextForTask(client, { task: 'authenticate user login' })).content[0]
        .text,
      /context_for_task/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
