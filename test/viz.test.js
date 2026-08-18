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

function injectEvent(extra) {
  return {
    type: 'inject',
    at: new Date().toISOString(),
    mode: 'on',
    dirty: 0,
    deltaMs: 10,
    retrieveMs: 20,
    hits: 2,
    injectedTokens: 100,
    windowVsFileTokens: 0,
    discoveryTokens: 0,
    timedOutDelta: false,
    timedOutRetrieve: false,
    ...extra,
  };
}

test('Viz: snapshot + HTML dashboard from fixture index', async () => {
  const { indexWorkspace, collectVizSnapshot } = await import(
    join(root, 'packages/core/dist/index.js')
  );
  const { renderVizHtml, buildVizPageData } = await import(
    join(root, 'packages/cli/dist/viz.js')
  );
  const { VIZ_TIP_IDS } = await import(
    join(root, 'packages/cli/dist/viz-tooltips.js')
  );

  const dir = mkdtempSync(join(tmpdir(), 'fastpath-viz-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-viz-user-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    mkdirSync(userDir, { recursive: true });
    writeFileSync(
      join(userDir, 'metrics.jsonl'),
      [
        JSON.stringify(
          injectEvent({
            workspace: dir,
            injectedTokens: 100,
            windowVsFileTokens: 400,
            discoveryTokens: 200,
            intent: 'code',
          }),
        ),
        JSON.stringify({
          type: 'mcp',
          at: new Date().toISOString(),
          workspace: dir,
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
          workspace: dir,
          tool: 'listDirectory',
          blocked: true,
          tokensAvoided: 1200,
        }),
        JSON.stringify(
          injectEvent({
            workspace: '/other/repo',
            injectedTokens: 50,
            hits: 1,
          }),
        ),
        JSON.stringify({
          type: 'mcp',
          at: new Date().toISOString(),
          workspace: '/other/repo',
          tool: 'find',
          ok: true,
          hits: 1,
          responseTokens: 10,
          windowVsFileTokens: 0,
          discoveryTokens: 0,
          paths: [],
        }),
        JSON.stringify(
          injectEvent({
            injectedTokens: 25,
            hits: 0,
            timedOutRetrieve: true,
          }),
        ),
        JSON.stringify(
          injectEvent({
            workspace: '/tmp/fastpath-viz-ephemeral',
            injectedTokens: 10,
            hits: 0,
          }),
        ),
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
    assert.equal(page.projectMetrics.injectedTokens, 100);
    assert.equal(page.projectMetrics.mcpResponseTokens, 40);
    assert.equal(page.projectMetrics.spentTokens, 140);
    assert.equal(page.projectMetrics.avoidedWindowVsFile, 700);
    assert.equal(page.projectMetrics.avoidedDiscovery, 200);
    assert.equal(page.projectMetrics.avoidedBlockedWalk, 1200);
    assert.equal(page.projectMetrics.tokensAvoided, 2100);
    assert.equal(page.projectMetrics.netTokens, 1960);
    assert.equal(page.projectMetrics.walksBlocked, 1);
    assert.equal(page.projectMetrics.mcpOk, 1);
    assert.equal(page.projectMetrics.events, 3);

    assert.equal(page.globalMetrics.injectedTokens, 185);
    assert.equal(page.globalMetrics.mcpResponseTokens, 50);
    assert.equal(page.globalMetrics.spentTokens, 235);
    assert.equal(page.untaggedEvents, 1);
    assert.equal(page.projectMetrics.codeHitRate, 1);
    assert.ok(page.workspaces.length >= 4);
    assert.ok(page.eventMix.length > 0);

    const html = renderVizHtml(page);
    const checks = [
      /FastPath report/,
      /This project/,
      /All FastPath/,
      /data-scope="project"/,
      /data-scope="global"/,
      /Files by folder/,
      /Symbol kinds/,
      /graph-shell/,
      /graph-panel/,
      /requestAnimationFrame/,
      /Fullscreen/,
      /#e8a54b/,
      /class="page"/,
      /section class="panel"/,
      /donut|hit-ring/,
      /data-ring="hit"/,
      /hit-ring-label"><strong>\d+%<\/strong>/,
      /Injected/,
      /MCP out/,
      /Avoided ≈/,
      /Net ≈/,
      /Window vs file ≈/,
      /Injected\/MCP out = measured/,
      /MCP path credited/,
      />100</,
      />2\.1k</,
      />2\.0k</,
      /ceil\(chars\/4\)/,
      /Avoided − Spent/,
      /querySelectorAll\('\.tip'\)/,
      /position: fixed/,
      /health-ok/,
      /advice-list/,
      /Hit \(all\)/,
      /Hit \(code\)/,
      /Ephemeral \(2\)/,
      /ephemeral-ws/,
    ];
    for (const re of checks) {
      assert.ok(re.test(html), `Missing pattern: ${re}`);
    }
    const indexStats = html.match(/id="index-stats"[^>]*>([\s\S]*?)<div class="layout">/);
    assert.ok(indexStats, 'index-stats block missing');
    assert.match(indexStats[1], /Coverage/);
    assert.doesNotMatch(indexStats[1], /Inject hit/);
    for (const id of VIZ_TIP_IDS) {
      assert.ok(html.includes(`data-tip="${id}"`), `missing tip ${id}`);
    }
    assert.ok(!/#c026d3/.test(html), 'Should not contain #c026d3');
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
    assert.match(written, /This project/);
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

test('Viz: n/a rules, health, ephemeral, advice', async () => {
  const { summarizeEvents, healthClass, isEphemeralWorkspace, usageAdvice } =
    await import(join(root, 'packages/cli/dist/viz-scope.js'));
  const { formatHitAll, formatHitCode, formatP50 } = await import(
    join(root, 'packages/cli/dist/viz.js')
  );

  const empty = summarizeEvents([]);
  assert.equal(empty.events, 0);
  assert.equal(empty.injectedTokens, null);
  assert.equal(formatHitAll(empty), 'n/a');
  assert.equal(formatHitCode(empty), 'n/a');
  assert.equal(formatP50(empty), 'n/a');
  assert.match(usageAdvice(empty)[0], /fastpath use/);

  const noPrompt = summarizeEvents([
    {
      type: 'inject',
      at: new Date().toISOString(),
      dirty: 0,
      deltaMs: 12,
      retrieveMs: 0,
      hits: 0,
      noPrompt: true,
      injectedTokens: 40,
      timedOutDelta: false,
      timedOutRetrieve: false,
    },
  ]);
  assert.equal(noPrompt.events, 1);
  assert.equal(noPrompt.injects, 1);
  assert.equal(noPrompt.retrievalInjects, 0);
  assert.equal(noPrompt.hitRate, null);
  assert.equal(noPrompt.injectedTokens, 40);
  assert.equal(formatHitAll(noPrompt), '0% (no retrieval)');
  assert.equal(formatHitCode(noPrompt), '--');
  assert.equal(formatP50(noPrompt), '12');

  const mcpOnly = summarizeEvents([
    {
      type: 'mcp',
      at: new Date().toISOString(),
      tool: 'find',
      ok: true,
      hits: 1,
      responseTokens: 8,
      windowVsFileTokens: 0,
      discoveryTokens: 0,
      paths: [],
    },
  ]);
  assert.equal(mcpOnly.injects, 0);
  assert.equal(formatHitAll(mcpOnly), '--');
  assert.equal(formatP50(mcpOnly), '--');
  assert.equal(mcpOnly.mcpResponseTokens, 8);

  assert.equal(healthClass('hitRate', 0.6), 'ok');
  assert.equal(healthClass('hitRate', 0.3), 'warn');
  assert.equal(healthClass('hitRate', 0.1), 'bad');
  assert.equal(healthClass('net', 10), 'ok');
  assert.equal(healthClass('net', 0), 'warn');
  assert.equal(healthClass('net', -10), 'bad');
  assert.equal(healthClass('timeouts', 0), 'ok');
  assert.equal(healthClass('mcpOk', 1), 'ok');
  assert.equal(healthClass('coverage', 0.4), 'bad');

  assert.equal(isEphemeralWorkspace('/var/folders/aa/xyz/T/foo'), true);
  assert.equal(isEphemeralWorkspace('/tmp/fastpath-x'), true);
  assert.equal(isEphemeralWorkspace('/Users/me/proj'), false);

  const lowHit = summarizeEvents([
    injectEvent({ hits: 0, injectedTokens: 20, workspace: '/ws' }),
    injectEvent({ hits: 0, injectedTokens: 20, workspace: '/ws' }),
  ]);
  const advice = usageAdvice(lowHit, { workspace: '/ws', coveragePct: 0 });
  assert.ok(advice.some((l) => l.includes('fastpath index')));
  assert.ok(advice.some((l) => l.includes('Scout')));
  assert.ok(advice.some((l) => l.includes('fastpath warm')));
});

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
