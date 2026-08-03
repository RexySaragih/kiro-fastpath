import { mkdtempSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  grepFast,
  impactForSymbol,
  indexWorkspace,
  lookupSymbol,
  searchIndex,
} from '@fastpath/core';

export interface EvalCase {
  name: string;
  run: (workspace: string) => boolean | Promise<boolean>;
}

export async function runBuiltinEval(
  fixtureRoot: string,
): Promise<{ passed: number; failed: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-eval-'));
  const failed: string[] = [];
  try {
    cpSync(join(fixtureRoot, 'fixtures/sample-src'), join(dir, 'src'), {
      recursive: true,
    });
    await indexWorkspace(dir);

    const cases: EvalCase[] = [
      {
        name: 'symbol AuthService',
        run: (ws) => lookupSymbol(ws, 'AuthService').some((h) => h.symbol === 'AuthService'),
      },
      {
        name: 'search authenticateUser',
        run: async (ws) => (await searchIndex(ws, 'authenticateUser')).length > 0,
      },
      {
        name: 'grep validateJwt',
        run: (ws) => grepFast(ws, 'validateJwt').length > 0,
      },
      {
        name: 'impact has definition',
        run: (ws) => impactForSymbol(ws, 'AuthService').definitions.length > 0,
      },
      {
        name: 'impact callers for login',
        run: (ws) =>
          impactForSymbol(ws, 'login').callers.some((h) => h.path.includes('app.ts')) ||
          impactForSymbol(ws, 'AuthService.login').callers.some((h) =>
            h.path.includes('app.ts'),
          ),
      },
      {
        name: 'python tax symbol',
        run: (ws) => lookupSymbol(ws, 'calculate_tax').length > 0,
      },
      {
        name: 'no nested local symbol noise',
        run: (ws) =>
          lookupSymbol(ws, 'NestedSvc').every((h) => h.symbol !== 'NestedSvc.ask') &&
          lookupSymbol(ws, 'NestedSvc').some((h) => h.symbol === 'NestedSvc'),
      },
    ];

    let passed = 0;
    for (const c of cases) {
      try {
        if (await c.run(dir)) passed += 1;
        else failed.push(c.name);
      } catch (err) {
        failed.push(`${c.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return { passed, failed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
