import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('golden eval reports graded metrics and gates on thresholds', async () => {
  const { runGoldenEval, goldenFailures, scoreCase, thresholdsForBackend } = await import(
    join(root, 'packages/cli/dist/eval-golden.js')
  );

  const metrics = await runGoldenEval(root);
  assert.ok(metrics.cases >= 5);
  for (const key of ['recallAt5', 'recallAt10', 'mrr', 'ndcgAt10']) {
    assert.ok(metrics[key] >= 0 && metrics[key] <= 1, `${key}=${metrics[key]} out of range`);
  }
  assert.deepEqual(goldenFailures(metrics), [], 'retrieval quality regressed below thresholds');
  assert.ok(thresholdsForBackend().recallAt5 > 0);

  // Perfect ranking scores 1; empty results score 0.
  const ideal = scoreCase(
    [{ path: 'a.ts', symbol: 'f', kind: 'function', line: 1, score: 1, snippet: '' }],
    { 'a.ts#f': 3 },
  );
  assert.equal(ideal.rr, 1);
  assert.equal(ideal.ndcg, 1);
  assert.equal(scoreCase([], { 'a.ts': 3 }).rr, 0);
});

test('bench reports measured injected tokens against an estimated baseline', async () => {
  const { runBench, formatBench } = await import(join(root, 'packages/cli/dist/bench.js'));
  const { indexWorkspace } = await import(join(root, 'packages/core/dist/index.js'));
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-bench-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);

    const report = await runBench(dir, [
      { prompt: 'where do we validate the auth token' },
      { prompt: 'how is tax calculated' },
    ]);
    assert.equal(report.tasks, 2);
    assert.ok(report.injectedTokens > 0);
    assert.ok(report.baselineTokensEstimated > report.injectedTokens);
    assert.equal(report.netTokens, report.baselineTokensEstimated - report.injectedTokens);
    assert.match(formatBench(report), /measured/);
    assert.match(formatBench(report), /estimated/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
