#!/usr/bin/env node

import { mkdtempSync, cpSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { indexWorkspace } from '@fastpath/core';
import { FastpathClient } from '../clients/fastpath-client.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-smoke-'));
  try {
    cpSync(join(root, 'fixtures/sample-src'), join(dir, 'src'), { recursive: true });
    await indexWorkspace(dir);
    const client = new FastpathClient(dir);
    const search = await client.search('AuthService');
    const symbol = client.symbol('calculate_tax');
    const grep = client.grep('validateJwt');
    const impact = client.impact('AuthService');
    const callers = client.impact('login');
    if (!search.length) throw new Error('search returned no hits');
    if (!symbol.length) throw new Error('symbol returned no hits');
    if (!grep.length) throw new Error('grep_fast returned no hits');
    if (!impact.includes('impact')) throw new Error('impact malformed');
    if (!callers.includes('### callers')) throw new Error('impact missing callers section');
    writeFileSync(join(dir, 'ok'), '1');
    console.error('[fastpath smoke] ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
