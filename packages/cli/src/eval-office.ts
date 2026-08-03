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

/**
 * Golden prompts shaped like office verify tasks (no "use FastPath" wording).
 * Runs against fixtures/sample-src — same symbols as the office runbook spirit.
 */
export async function runOfficeEval(
  fixtureRoot: string,
): Promise<{ passed: number; failed: string[] }> {
  const dir = mkdtempSync(join(tmpdir(), 'fastpath-office-eval-'));
  const failed: string[] = [];
  try {
    cpSync(join(fixtureRoot, 'fixtures/sample-src'), join(dir, 'src'), {
      recursive: true,
    });
    await indexWorkspace(dir);

    const cases: Array<{ name: string; run: () => boolean | Promise<boolean> }> = [
      {
        name: 'where is AuthService defined',
        run: () => lookupSymbol(dir, 'AuthService').some((h) => h.path.includes('auth')),
      },
      {
        name: 'who calls login / AuthService.login',
        run: () => {
          const impact = impactForSymbol(dir, 'login');
          return (
            impact.callers.some((h) => h.path.includes('app')) ||
            impactForSymbol(dir, 'AuthService.login').callers.length > 0
          );
        },
      },
      {
        name: 'find validateJwt without walking repo',
        run: () => grepFast(dir, 'validateJwt').length > 0,
      },
      {
        name: 'natural language locate authenticate',
        run: async () => (await searchIndex(dir, 'user authentication login')).length > 0,
      },
      {
        name: 'python calculate_tax locate',
        run: () => lookupSymbol(dir, 'calculate_tax').length > 0,
      },
    ];

    let passed = 0;
    for (const c of cases) {
      try {
        if (await c.run()) passed += 1;
        else failed.push(c.name);
      } catch (err) {
        failed.push(`${c.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
    return { passed, failed };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
