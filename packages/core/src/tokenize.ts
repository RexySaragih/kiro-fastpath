/** Split camelCase / snake_case / kebab-case into FTS-friendly tokens. */
export function tokenizeIdentifier(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((p) => p.toLowerCase());
  return [...new Set([name.toLowerCase(), ...parts])].join(' ');
}

export function clampTopK(value: number | undefined, fallback: number, hardMax: number): number {
  if (value === undefined || Number.isNaN(value)) return fallback;
  return Math.min(hardMax, Math.max(1, Math.floor(value)));
}

export function snippetAround(content: string, line: number, radius = 2): string {
  const lines = content.split('\n');
  const idx = Math.max(0, line - 1);
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length, idx + radius + 1);
  return lines
    .slice(start, end)
    .map((l, i) => `${start + i + 1}| ${l}`)
    .join('\n')
    .slice(0, 800);
}
