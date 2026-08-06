/**
 * Behavioral: viz snapshot + HTML render from an indexed fixture workspace.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  existsSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages/cli/dist/index.js');

const env = {
  ...process.env,
  FASTPATH_EMBED: 'hash',
  FASTPATH_RERANK: 'off',
  FASTPATH_PARSER: 'legacy',
  FASTPATH_ALLOW_HASH: '1',
};

test('Viz: snapshot + HTML dashboard from fixture index', async () => {
  const { indexWorkspace, collectVizSnapshot } = await import(
    join(root, 'packages/core/dist/index.js')
  );
  const { renderVizHtml, buildVizPageData } = await import(
    join(root, 'packages/cli/dist/viz.js')
  );

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-viz-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-viz-user-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    // Given: synthetic inject + blocked walk metrics for the token ledger
    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'metrics.jsonl'),
      [
        JSON.stringify({
          type: 'inject',
          at: new Date().toISOString(),
          mode: 'on',
          dirty: 0,
          deltaMs: 10,
          retrieveMs: 20,
          hits: 2,
          injectedTokens: 100,
          windowVsFileTokens: 400,
          discoveryTokens: 200,
          timedOutDelta: false,
          timedOutRetrieve: false,
        }),
        JSON.stringify({
          type: 'mcp',
          at: new Date().toISOString(),
          tool: 'window',
          ok: true,
          hits: 1,
          responseTokens: 40,
          windowVsFileTokens: 300,
          discoveryTokens: 0,
          paths: ['src/auth.ts'],
        }),
        JSON.stringify({
          type: 'guardrail',
          at: new Date().toISOString(),
          tool: 'listDirectory',
          blocked: true,
          tokensAvoided: 1200,
        }),
      ].join('\n') + '\n',
    );
    process.env.FASTPATH_USER_DIR = userDir;

    const snap = collectVizSnapshot(dir);
    assert.ok(snap.summary.files > 0);
    assert.ok(snap.summary.symbols > 0);
    assert.ok(snap.folders.length > 0);
    assert.ok(snap.symbolKinds.length > 0);
    assert.equal(snap.workspace, dir);

    const page = buildVizPageData(dir);
    assert.equal(page.metrics.injectedTokens, 100);
    assert.equal(page.metrics.mcpResponseTokens, 40);
    assert.equal(page.metrics.spentTokens, 140);
    assert.equal(page.metrics.avoidedWindowVsFile, 700);
    assert.equal(page.metrics.avoidedDiscovery, 200);
    assert.equal(page.metrics.avoidedBlockedWalk, 1200);
    assert.equal(page.metrics.tokensAvoided, 2100);
    assert.equal(page.metrics.netTokens, 1960);
    assert.equal(page.metrics.walksBlocked, 1);
    assert.equal(page.metrics.mcpOk, 1);

    const html = renderVizHtml(page);
    assert.match(html, /FastPath index/);
    assert.match(html, /Files by folder/);
    assert.match(html, /Symbol kinds/);
    assert.match(html, /graph-shell/);
    assert.match(html, /graph-panel/);
    assert.match(html, /requestAnimationFrame/);
    assert.match(html, /Fullscreen/);
    assert.match(html, /#e8a54b/);
    assert.match(html, /class="page"/);
    assert.match(html, /section class="panel"/);
    assert.match(html, /lol-dot|donut|hit-ring/);
    assert.match(html, />Injected</);
    assert.match(html, />MCP out</);
    assert.match(html, /Avoided ≈/);
    assert.match(html, /Net ≈/);
    assert.match(html, /Window vs file ≈/);
    assert.match(html, /Injected\/MCP out = measured/);
    assert.match(html, /MCP path credited/);
    assert.match(html, />100</);
    assert.match(html, />2\.1k</);
    assert.match(html, />2\.0k</);
    assert.doesNotMatch(html, /#c026d3/);
    assert.ok(Array.isArray(snap.callGraph.nodes));
    if (snap.callGraph.nodes.length) {
      const n = snap.callGraph.nodes[0];
      assert.ok(Array.isArray(n.paths));
      assert.ok(Array.isArray(n.topCallers));
      assert.ok(Array.isArray(n.topCallees));
    }
    assert.ok(html.includes(escapeAttr(dir)) || html.includes(dir));
    assert.ok(html.length > 2000);

    const out = join(dir, 'dashboard.html');
    const result = spawnSync(
      process.execPath,
      [cli, 'viz', dir, '--no-open', '--out', out],
      { encoding: 'utf8', env: { ...env, FASTPATH_USER_DIR: userDir } },
    );
    assert.equal(result.status, 0, result.stderr + result.stdout);
    assert.ok(existsSync(out));
    const written = readFileSync(out, 'utf8');
    assert.match(written, /Heaviest files/);
    assert.match(written, /Avoided ≈/);
    assert.match(result.stdout, /FastPath viz/);
  } finally {
    delete process.env.FASTPATH_USER_DIR;
    rmSync(dir, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});

function escapeAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

test('Viz: missing index fails clearly', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-viz-empty-'));
  try {
    const result = spawnSync(process.execPath, [cli, 'viz', dir, '--no-open'], {
      encoding: 'utf8',
      env,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /index not found|fastpath index/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
