/** Same heuristic as packages/cli/src/viz-scope.ts `isEphemeralWorkspace`. */
export function isEphemeralWorkspace(p: string): boolean {
  const n = p.replace(/\\/g, '/');
  return n.includes('/var/folders/') || n.includes('/tmp/') || n.includes('/Temp/');
}

export function splitWired(
  workspaces: Record<string, { wiredAt: string }>,
): {
  durable: Array<[string, { wiredAt: string }]>;
  ephemeral: Array<[string, { wiredAt: string }]>;
} {
  const durable: Array<[string, { wiredAt: string }]> = [];
  const ephemeral: Array<[string, { wiredAt: string }]> = [];
  for (const entry of Object.entries(workspaces)) {
    if (isEphemeralWorkspace(entry[0])) ephemeral.push(entry);
    else durable.push(entry);
  }
  durable.sort(([a], [b]) => a.localeCompare(b));
  ephemeral.sort(([a], [b]) => a.localeCompare(b));
  return { durable, ephemeral };
}

export function pickDurableWorkspace(state: {
  wired: string[];
  config: { lastWorkspace: string | null; workspaces: Record<string, unknown> };
}): string {
  const last = state.config.lastWorkspace;
  if (last && !isEphemeralWorkspace(last)) return last;
  const durable = Object.keys(state.config.workspaces)
    .filter((p) => !isEphemeralWorkspace(p))
    .sort();
  if (durable[0]) return durable[0];
  return state.wired.find((p) => !isEphemeralWorkspace(p)) ?? '';
}
