export function resolveWorkspace(): string {
  return process.env.FASTPATH_WORKSPACE?.trim() || process.cwd();
}
