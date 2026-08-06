/**
 * Behavioral: counterfactual token ledger — buckets, path dedup, discovery once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  cpSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('Token ledger: window credit, path dedup, discovery once, empty/error zero', async () => {
  const core = await import(join(root, 'packages/core/dist/index.js'));
  const {
    creditLocateHits,
    creditWindowRead,
    resetLedgerState,
    tokenLedger,
    appendMetric,
    readMetrics,
    estimateTokens,
    WALK_TOKENS_AVOIDED,
  } = core;

  const workspace = mkdtempSync(join(tmpdir(), 'fastpath-ledger-ws-'));
  const userDir = mkdtempSync(join(tmpdir(), 'fastpath-ledger-user-'));
  const prevUser = process.env.FASTPATH_USER_DIR;
  process.env.FASTPATH_USER_DIR = userDir;

  try {
    cpSync(join(root, 'fixtures/sample-src'), join(workspace, 'src'), {
      recursive: true,
    });
    resetLedgerState();

    const snippet = 'x'.repeat(80);
    const hit = {
      path: 'src/auth.ts',
      snippet,
      startLine: 1,
      endLine: 10,
      score: 1,
      kind: 'function',
      symbol: 'login',
    };

    // Given: first locate with quality hits
    const first = creditLocateHits(workspace, [hit]);
    assert.ok(first.windowVsFileTokens > 0, 'window vs file should credit');
    assert.ok(first.discoveryTokens > 0, 'discovery once on first locate');
    assert.deepEqual(first.paths, ['src/auth.ts']);

    // When: same path credited again
    const second = creditLocateHits(workspace, [hit]);
    assert.equal(second.windowVsFileTokens, 0, 'path dedup');
    assert.equal(second.discoveryTokens, 0, 'discovery already claimed');

    // When: empty hits
    const empty = creditLocateHits(workspace, []);
    assert.equal(empty.windowVsFileTokens, 0);
    assert.equal(empty.discoveryTokens, 0);

    resetLedgerState();
    const winBody = 'line\n'.repeat(20);
    const win1 = creditWindowRead(workspace, 'src/auth.ts', estimateTokens(winBody));
    assert.ok(win1.windowVsFileTokens > 0);
    const win2 = creditWindowRead(workspace, 'src/auth.ts', estimateTokens(winBody));
    assert.equal(win2.windowVsFileTokens, 0, 'window path dedup');

    // Ledger aggregation from synthetic events
    resetLedgerState();
    appendMetric({
      type: 'inject',
      at: new Date().toISOString(),
      mode: 'on',
      dirty: 0,
      deltaMs: 1,
      retrieveMs: 2,
      hits: 1,
      injectedTokens: 100,
      windowVsFileTokens: 500,
      discoveryTokens: 200,
      timedOutDelta: false,
      timedOutRetrieve: false,
    });
    appendMetric({
      type: 'mcp',
      at: new Date().toISOString(),
      tool: 'window',
      ok: true,
      hits: 1,
      responseTokens: 50,
      windowVsFileTokens: 300,
      discoveryTokens: 0,
      paths: ['src/billing.py'],
    });
    appendMetric({
      type: 'mcp',
      at: new Date().toISOString(),
      tool: 'find',
      ok: false,
      hits: 0,
      responseTokens: 10,
      windowVsFileTokens: 0,
      discoveryTokens: 0,
      paths: [],
    });
    appendMetric({
      type: 'guardrail',
      at: new Date().toISOString(),
      tool: 'listDirectory',
      blocked: true,
      tokensAvoided: WALK_TOKENS_AVOIDED,
    });

    const events = readMetrics(50);
    const ledger = tokenLedger(events);
    assert.equal(ledger.injectedTokens, 100);
    assert.equal(ledger.mcpResponseTokens, 60);
    assert.equal(ledger.spentTokens, 160);
    assert.equal(ledger.avoidedBlockedWalk, WALK_TOKENS_AVOIDED);
    assert.equal(ledger.avoidedWindowVsFile, 800);
    assert.equal(ledger.avoidedDiscovery, 200);
    assert.equal(ledger.tokensAvoided, WALK_TOKENS_AVOIDED + 800 + 200);
    assert.equal(ledger.net, ledger.tokensAvoided - ledger.spentTokens);
    assert.equal(ledger.mcpCalls, 2);
    assert.equal(ledger.mcpOk, 1);
    assert.equal(ledger.walksBlocked, 1);

    assert.ok(existsSync(join(userDir, 'metrics.jsonl')));
    assert.ok(readFileSync(join(userDir, 'metrics.jsonl'), 'utf8').includes('"type":"mcp"'));
  } finally {
    if (prevUser === undefined) delete process.env.FASTPATH_USER_DIR;
    else process.env.FASTPATH_USER_DIR = prevUser;
    rmSync(workspace, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  }
});
