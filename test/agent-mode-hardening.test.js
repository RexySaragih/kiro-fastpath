/**
 * Unit checks for extractPrompt + routingAdvice (Agent Mode Hardening).
 */
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import test from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

test('extractPrompt reads nested and alternate Kiro fields', async () => {
  const hookUtilPath = join(root, 'packages/cli/dist/hook-util.js');
  if (!existsSync(hookUtilPath)) {
    assert.ok(true, 'dist not built yet — skip');
    return;
  }
  const { extractPrompt } = await import(pathToFileURL(hookUtilPath).href);

  assert.equal(extractPrompt({ prompt: 'hello' }, ''), 'hello');
  assert.equal(extractPrompt({ userPrompt: 'from userPrompt' }, ''), 'from userPrompt');
  assert.equal(extractPrompt({ message: 'from message' }, ''), 'from message');
  assert.equal(
    extractPrompt({ input: { text: 'nested input text' } }, ''),
    'nested input text',
  );
  assert.equal(extractPrompt({}, 'plain raw prompt'), 'plain raw prompt');
  assert.equal(extractPrompt({}, '{"x":1}'), '');
});

test('routingAdvice: Scout ≤5, Architect ≥6', async () => {
  const routingPath = join(root, 'packages/cli/dist/routing.js');
  if (!existsSync(routingPath)) {
    assert.ok(true, 'dist not built yet — skip');
    return;
  }
  const { routingAdvice } = await import(pathToFileURL(routingPath).href);

  const scout = routingAdvice('fix typo in login', ['src/auth.ts']);
  assert.equal(scout?.agent, 'Scout');
  assert.equal(scout?.confidence, 'high');

  const architect = routingAdvice(
    'refactor the login validation architecture across the system',
    ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
  );
  assert.equal(architect?.agent, 'Architect');
  assert.match(architect?.reason ?? '', /multi-file keywords/);
});
