/**
 * `fastpath viz` — local, self-contained HTML dashboard of the index.
 * No CDN, no server. Design: dense instrument panel (zinc + amber accent).
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { collectVizSnapshot, type CountRow, type VizSnapshot } from '@fastpath/core';
import {
  collectDualMetrics,
  healthClass,
  isEphemeralWorkspace,
  sameWorkspace,
  UNTAGGED_WORKSPACE,
  usageAdvice,
  type HealthKind,
  type VizMetricsSummary,
  type WorkspaceUsageRow,
} from './viz-scope.js';
import {
  escapeHtml,
  kpiLabel,
  sectionTitle,
  type TipId,
} from './viz-tooltips.js';

export type { VizMetricsSummary, WorkspaceUsageRow };

export interface VizPageData extends VizSnapshot {
  projectMetrics: VizMetricsSummary;
  globalMetrics: VizMetricsSummary;
  workspaces: WorkspaceUsageRow[];
  untaggedEvents: number;
  eventMix: CountRow[];
  generatedAt: string;
}

export interface VizOptions {
  workspace: string;
  outPath?: string;
  openBrowser: boolean;
}

/** Format ledger numbers — n/a only when no events in pane. */
function formatLedgerTok(value: number | null): string {
  if (value == null) return 'n/a';
  return formatTokens(value);
}

export function formatHitAll(m: VizMetricsSummary): string {
  if (m.events === 0) return 'n/a';
  if (m.injects === 0) return '--';
  if (m.retrievalInjects === 0) return '0% (no retrieval)';
  return `${((m.hitRate ?? 0) * 100).toFixed(0)}%`;
}

export function formatHitCode(m: VizMetricsSummary): string {
  if (m.events === 0) return 'n/a';
  if (m.codeHitRate == null) return '--';
  return `${(m.codeHitRate * 100).toFixed(0)}%`;
}

export function formatP50(m: VizMetricsSummary): string {
  if (m.events === 0) return 'n/a';
  if (m.p50DeltaMs == null) return '--';
  return String(m.p50DeltaMs);
}

function valueClass(health?: HealthKind | null): string {
  return health ? `v health-${health}` : 'v';
}

/** Format token counts with k/M suffix for viz. */
export function formatTokens(count: number): string {
  const sign = count < 0 ? '-' : '';
  const abs = Math.abs(count);
  if (abs >= 1_000_000) return sign + (abs / 1_000_000).toFixed(1) + 'M';
  if (abs >= 1_000) return sign + (abs / 1_000).toFixed(1) + 'k';
  return String(count);
}

/** Amber → zinc scale (design DNA). No purple. */
const INK_TONES = ['#d97706', '#e8a54b', '#c4a574', '#8b939e', '#6b7280', '#a1a1aa', '#d4d4d8'];

/** Lightweight SVG lollipop chart — thin stems + amber dots. */
function lollipopChart(rows: CountRow[], maxBars = 12): string {
  if (!rows.length) return '';
  const slice = rows.slice(0, maxBars);
  const max = Math.max(...slice.map((r) => r.count), 1);
  const total = slice.reduce((a, r) => a + r.count, 0) || 1;
  const rowH = 22;
  const labelW = 118;
  const chartW = 200;
  const padR = 52;
  const h = slice.length * rowH + 4;
  const w = labelW + chartW + padR;
  const items = slice
    .map((r, i) => {
      const y = 14 + i * rowH;
      const x0 = labelW;
      const x1 = labelW + Math.max(4, (r.count / max) * chartW);
      const share = ((r.count / total) * 100).toFixed(0);
      const label = r.label.length > 16 ? `${r.label.slice(0, 15)}…` : r.label;
      return `<g class="lol-row">
        <text x="${labelW - 8}" y="${y + 4}" text-anchor="end" class="lol-label">${escapeHtml(label)}</text>
        <line x1="${x0}" y1="${y}" x2="${x1}" y2="${y}" class="lol-stem"/>
        <circle cx="${x1}" cy="${y}" r="3.5" class="lol-dot"/>
        <text x="${x1 + 8}" y="${y + 4}" class="lol-val">${r.count}<tspan class="lol-share"> ${share}%</tspan></text>
      </g>`;
    })
    .join('');
  return `<svg class="diagram" viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img">${items}</svg>`;
}

/** Lightweight SVG donut for categorical mix. */
function donutChart(rows: CountRow[], title: string): string {
  if (!rows.length) return '';
  const slice = rows.slice(0, 7);
  const total = slice.reduce((a, r) => a + r.count, 0) || 1;
  const cx = 48;
  const cy = 48;
  const r = 34;
  const stroke = 10;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = slice
    .map((row, i) => {
      const len = (row.count / total) * c;
      const el = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${INK_TONES[i % INK_TONES.length]}" stroke-width="${stroke}"
        stroke-dasharray="${len} ${c - len}" stroke-dashoffset="${-offset}"
        transform="rotate(-90 ${cx} ${cy})">
        <title>${escapeHtml(row.label)}: ${row.count}</title>
      </circle>`;
      offset += len;
      return el;
    })
    .join('');
  const legend = slice
    .map((row, i) => {
      const share = ((row.count / total) * 100).toFixed(0);
      return `<li><i style="background:${INK_TONES[i % INK_TONES.length]}"></i>
        <span>${escapeHtml(row.label)}</span>
        <b>${row.count}</b><em>${share}%</em></li>`;
    })
    .join('');
  return `<div class="donut-wrap">
    <svg class="diagram donut" viewBox="0 0 96 96" width="96" height="96" role="img" aria-label="${escapeHtml(title)}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(42,38,34,0.06)" stroke-width="${stroke}"/>
      ${arcs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" class="donut-n">${total}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" class="donut-sub">total</text>
    </svg>
    <ul class="donut-legend">${legend}</ul>
  </div>`;
}

function usageRing(m: VizMetricsSummary): string {
  const r = 30;
  const circ = 2 * Math.PI * r;
  let rate = 0;
  let caption = 'hit';
  if (m.hitRate != null) {
    rate = m.hitRate;
    caption = 'hit';
  } else if (m.mcpCalls > 0) {
    rate = m.mcpOk / m.mcpCalls;
    caption = 'mcp';
  }
  const pct = Math.round(rate * 100);
  const dash = (pct / 100) * circ;
  return `<div class="hit-ring" data-ring="${caption}">
    <svg viewBox="0 0 80 80" width="80" height="80" aria-hidden="true">
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="rgba(42,38,34,0.08)" stroke-width="5"/>
      <circle cx="40" cy="40" r="${r}" fill="none" stroke="#e8a54b" stroke-width="5"
        stroke-linecap="round" stroke-dasharray="${dash} ${circ}"
        transform="rotate(-90 40 40)"/>
    </svg>
    <div class="hit-ring-label"><strong>${pct}%</strong><span>${escapeHtml(caption)}</span></div>
  </div>`;
}

function kpiCell(id: TipId, value: string, health?: HealthKind | null): string {
  return `<div class="kpi">${kpiLabel(id)}<span class="${valueClass(health)}">${value}</span></div>`;
}

function statCard(id: TipId, value: string, health?: HealthKind | null): string {
  return `<div class="stat">${kpiLabel(id, 'div')}<div class="${valueClass(health)}">${value}</div></div>`;
}

function formatCoverage(vectors: number, symbols: number): string {
  if (!symbols) return '--';
  return `${Math.round((vectors / symbols) * 100)}%`;
}

function ledgerStrip(m: VizMetricsSummary): string {
  const netHealth = m.events ? healthClass('net', m.netTokens ?? 0) : null;
  return `<div class="grid-stats-ledger">
    ${statCard('injected', formatLedgerTok(m.injectedTokens))}
    ${statCard('mcpOut', formatLedgerTok(m.mcpResponseTokens))}
    ${statCard('avoided', formatLedgerTok(m.tokensAvoided))}
    ${statCard('net', formatLedgerTok(m.netTokens), netHealth)}
  </div>`;
}

function injectMetricsBlock(m: VizMetricsSummary): string {
  const vals = [m.events, m.injects, m.indexes, m.doctors];
  const max = Math.max(...vals, 1);
  const spark = vals
    .map((v, i) => {
      const h = Math.max(2, Math.round((v / max) * 36));
      const x = 6 + i * 18;
      return `<rect x="${x}" y="${40 - h}" width="10" height="${h}" fill="${i === 1 ? '#e8a54b' : '#a1a1aa'}" rx="1"/>`;
    })
    .join('');
  const hitHealth =
    m.retrievalInjects > 0 ? healthClass('hitRate', m.hitRate) : null;
  const codeHealth =
    m.codeHitRate != null ? healthClass('hitRate', m.codeHitRate) : null;
  const timeoutHealth = m.events ? healthClass('timeouts', m.timeouts) : null;
  const mcpHealth =
    m.mcpCalls > 0 ? healthClass('mcpOk', m.mcpOk / m.mcpCalls) : null;
  return `<div class="inject-grid">
    ${usageRing(m)}
    <div>
      <svg class="diagram spark" viewBox="0 0 78 44" width="78" height="44" aria-hidden="true">${spark}</svg>
      <div class="kpi-grid">
        ${kpiCell('events', String(m.events))}
        ${kpiCell('injects', String(m.injects))}
        ${kpiCell('injectHit', formatHitAll(m), hitHealth)}
        ${kpiCell('injectHitCode', formatHitCode(m), codeHealth)}
        ${kpiCell('p50Delta', formatP50(m))}
        ${kpiCell('timeouts', String(m.timeouts), timeoutHealth)}
        ${kpiCell('indexDoctor', `${m.indexes} / ${m.doctors}`)}
        ${kpiCell('mcpOk', `${m.mcpOk}/${m.mcpCalls}`, mcpHealth)}
        ${kpiCell('walksBlocked', `${m.walksBlocked}/${m.walksSeen}`)}
        ${kpiCell('spent', formatLedgerTok(m.spentTokens))}
        ${kpiCell('walkBlock', formatLedgerTok(m.avoidedBlockedWalk))}
        ${kpiCell('windowVsFile', formatLedgerTok(m.avoidedWindowVsFile))}
        ${kpiCell('discover', formatLedgerTok(m.avoidedDiscovery))}
      </div>
      <p class="muted ledger-legend">Injected/MCP out = measured · Avoided buckets = estimate (deduped paths, discovery once/session)</p>
      <p class="ledger-insight">${escapeHtml(m.insight)}</p>
    </div>
  </div>`;
}

function usageBody(m: VizMetricsSummary, emptyCopy?: string): string {
  if (emptyCopy && m.events === 0) {
    return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  }
  return `${ledgerStrip(m)}${injectMetricsBlock(m)}`;
}

function workspaceRowsHtml(rows: WorkspaceUsageRow[], current: string): string {
  return rows
    .map((r) => {
      const currentCls =
        r.workspace !== UNTAGGED_WORKSPACE && sameWorkspace(r.workspace, current)
          ? ' class="is-current"'
          : '';
      return `<tr${currentCls}>
        <td class="mono path">${escapeHtml(r.workspace)}</td>
        <td class="num">${r.injects}</td>
        <td class="num">${r.mcpCalls}</td>
        <td class="num">${formatLedgerTok(r.spentTokens)}</td>
        <td class="num">${formatLedgerTok(r.netTokens)}</td>
      </tr>`;
    })
    .join('\n');
}

function workspaceTable(rows: WorkspaceUsageRow[], current: string): string {
  if (!rows.length) return '<p class="muted">No journal events yet.</p>';
  const real = rows.filter((r) => !isEphemeralWorkspace(r.workspace));
  const eph = rows.filter((r) => isEphemeralWorkspace(r.workspace));
  const head =
    '<thead><tr><th>Workspace</th><th>Injects</th><th>MCP</th><th>Spent</th><th>Net ≈</th></tr></thead>';
  const realTable = real.length
    ? `<table>${head}<tbody>${workspaceRowsHtml(real, current)}</tbody></table>`
    : '<p class="muted">No durable workspaces in the journal.</p>';
  if (!eph.length) return realTable;
  const spent = eph.reduce((s, r) => s + (r.spentTokens ?? 0), 0);
  const injects = eph.reduce((s, r) => s + r.injects, 0);
  const mcp = eph.reduce((s, r) => s + r.mcpCalls, 0);
  return `${realTable}
    <details class="ephemeral-ws">
      <summary>Ephemeral (${eph.length}) — ${injects} injects · ${mcp} MCP · spent ${formatTokens(spent)}</summary>
      <table>${head}<tbody>${workspaceRowsHtml(eph, current)}</tbody></table>
    </details>`;
}

function adviceBlock(
  m: VizMetricsSummary,
  opts: { workspace?: string; coveragePct?: number | null } = {},
): string {
  const lines = usageAdvice(m, opts);
  if (!lines.length) return '';
  const items = lines
    .map((line) => {
      const split = line.match(/^(Run: |Consider: )(.+)$/);
      if (split) {
        return `<li>${escapeHtml(split[1]!)}<code>${escapeHtml(split[2]!)}</code></li>`;
      }
      return `<li>${escapeHtml(line)}</li>`;
    })
    .join('');
  return `<section class="panel full advice-panel">
    ${sectionTitle('actions')}
    <ul class="advice-list">${items}</ul>
  </section>`;
}

function openInBrowser(filePath: string): void {
  const platform = process.platform;
  if (platform === 'darwin') {
    spawn('open', [filePath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', filePath], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [filePath], { detached: true, stdio: 'ignore' }).unref();
}

export function buildVizPageData(workspace: string): VizPageData {
  const snap = collectVizSnapshot(workspace);
  const dual = collectDualMetrics(workspace);
  return {
    ...snap,
    ...dual,
    generatedAt: new Date().toISOString(),
  };
}

export function renderVizHtml(data: VizPageData): string {
  const s = data.summary;
  const graphJson = JSON.stringify(data.callGraph);
  const memBlock = data.memories.length
    ? data.memories
        .map(
          (m) => `<li class="mem">
            <span class="pill">${escapeHtml(m.kind)}</span>
            <span class="mem-text">${escapeHtml(m.text.slice(0, 280))}</span>
            <span class="muted">#${m.id} · used ${m.useCount}x</span>
          </li>`,
        )
        .join('\n')
    : '';

  const heavyMax = Math.max(...data.heavyFiles.map((f) => f.symbols), 1);
  const heavyRows = data.heavyFiles
    .map((f) => {
      const pct = Math.max(2, Math.round((f.symbols / heavyMax) * 100));
      return `<tr>
        <td class="mono path">${escapeHtml(f.path)}</td>
        <td class="heavy-bar-cell" title="${f.symbols} symbols (${pct}% of heaviest)">
          <div class="heavy-bar">
            <div class="bar-track">
              <span class="bar-fill" style="width:${pct}%"></span>
            </div>
            <span class="heavy-bar-val">${f.symbols}</span>
          </div>
        </td>
        <td class="muted">${escapeHtml(f.language)}</td>
      </tr>`;
    })
    .join('\n');

  const coverageRatio = s.symbols ? s.vectors / s.symbols : null;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>FastPath viz · ${escapeHtml(data.workspace.split('/').pop() || 'workspace')}</title>
<style>
  :root {
    --bg: #f4f5f7;
    --bg-2: #ffffff;
    --ink: #18181b;
    --line: #e4e4e7;
    --text: #27272a;
    --muted: #71717a;
    --accent: #e8a54b;
    --accent-2: #d97706;
    --accent-dim: rgba(232, 165, 75, 0.14);
    --ok: #0f766e;
    --warn: #d97706;
    --bad: #dc2626;
    --shadow: 0 1px 0 rgba(24, 24, 27, 0.03), 0 8px 24px rgba(24, 24, 27, 0.04);
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
    --display: "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
    --graph-bg: #fafafa;
    --page-grid: 32px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    color: var(--text);
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.45;
    background-color: var(--bg);
    background-image:
      linear-gradient(rgba(113, 113, 122, 0.12) 1px, transparent 1px),
      linear-gradient(90deg, rgba(113, 113, 122, 0.12) 1px, transparent 1px);
    background-size: var(--page-grid) var(--page-grid);
  }
  body { padding: 36px 28px 72px; }
  .page {
    max-width: 1180px;
    margin: 0 auto;
  }
  header {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 20px;
    align-items: end;
    margin-bottom: 28px;
    padding: 22px 24px;
    background: var(--bg-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    position: relative;
  }
  header::before {
    content: "";
    position: absolute;
    left: 0; top: 0; bottom: 0;
    width: 4px;
    background: linear-gradient(180deg, var(--accent), var(--accent-2));
  }
  .brand-row {
    display: flex;
    align-items: baseline;
    gap: 10px;
    flex-wrap: wrap;
  }
  .brand-mark {
    font-family: var(--mono);
    font-size: 10px;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: var(--accent-2);
    background: var(--accent-dim);
    border: 1px solid rgba(232, 165, 75, 0.35);
    padding: 3px 7px;
  }
  h1 {
    margin: 0;
    font-family: var(--display);
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1.1;
  }
  .sub {
    margin-top: 8px;
    color: var(--muted);
    font-family: var(--mono);
    font-size: 12px;
    word-break: break-all;
  }
  .meta-right {
    text-align: right;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    display: grid;
    gap: 4px;
  }
  .meta-right strong { color: var(--accent-2); font-weight: 600; }
  .meta-chip {
    display: inline-block;
    margin-left: 4px;
    padding: 1px 6px;
    background: rgba(42, 38, 34, 0.04);
    border: 1px solid var(--line);
    color: var(--text);
  }
  .grid-stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 12px;
    overflow: visible;
  }
  .grid-stats-ledger {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 28px;
    overflow: visible;
  }
  .ledger-legend {
    margin: 10px 0 0;
    font-size: 11px;
    line-height: 1.35;
  }
  .ledger-insight {
    margin: 8px 0 0;
    font-size: 12px;
    line-height: 1.4;
    color: var(--text);
    font-family: var(--mono);
  }
  @media (max-width: 900px) {
    .grid-stats { grid-template-columns: repeat(2, 1fr); }
    .grid-stats-ledger { grid-template-columns: repeat(2, 1fr); }
  }
  .stat {
    background: var(--bg-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    padding: 16px 16px 14px;
    position: relative;
    overflow: visible;
  }
  .stat:hover, .stat:focus-within { z-index: 8; }
  .stat::after {
    content: "";
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: 2px;
    background: linear-gradient(90deg, var(--accent), transparent 70%);
    opacity: 0.55;
  }
  .stat .k {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    display: flex;
    align-items: center;
  }
  .stat .v {
    margin-top: 8px;
    font-family: var(--mono);
    font-size: 26px;
    font-weight: 600;
    letter-spacing: -0.04em;
    color: var(--ink);
  }
  .layout {
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 960px) {
    .layout { grid-template-columns: 1fr; }
    body { padding: 20px 14px 48px; }
    h1 { font-size: 24px; }
  }
  section.panel {
    margin: 0;
    background: var(--bg-2);
    border: 1px solid var(--line);
    box-shadow: var(--shadow);
    padding: 18px 18px 16px;
    overflow: visible;
    position: relative;
  }
  h2 {
    margin: 0 0 14px;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    display: flex;
    align-items: center;
    gap: 8px;
    position: relative;
    overflow: visible;
    z-index: 1;
  }
  h2:hover, h2:focus-within { z-index: 8; }
  h2::before {
    content: "";
    width: 8px;
    height: 8px;
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-dim);
    flex-shrink: 0;
  }
  .diagram { display: block; max-width: 100%; overflow: visible; }
  .lol-label { font: 11px var(--mono); fill: var(--text); }
  .lol-stem { stroke: #d4d4d8; stroke-width: 1.25; }
  .lol-dot { fill: var(--accent); }
  .lol-val { font: 11px var(--mono); fill: var(--text); }
  .lol-share { fill: var(--muted); font-size: 9px; }
  .donut-wrap {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 16px;
    align-items: center;
  }
  .donut-n { font: 600 14px var(--mono); fill: var(--ink); }
  .donut-sub { font: 9px var(--mono); fill: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
  .donut-legend {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 6px;
  }
  .donut-legend li {
    display: grid;
    grid-template-columns: 8px 1fr auto auto;
    gap: 8px;
    align-items: center;
    font-family: var(--mono);
    font-size: 11px;
  }
  .donut-legend i {
    width: 8px; height: 8px; border-radius: 50%; display: block;
  }
  .donut-legend em { color: var(--muted); font-style: normal; font-size: 10px; }
  .donut-legend b { font-weight: 600; }
  .inject-grid {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 14px;
    align-items: start;
  }
  @media (max-width: 560px) {
    .inject-grid, .donut-wrap { grid-template-columns: 1fr; justify-items: start; }
  }
  .hit-ring {
    position: relative;
    width: 80px;
    height: 80px;
  }
  .hit-ring-label {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
    pointer-events: none;
  }
  .hit-ring-label strong {
    font-family: var(--mono);
    font-size: 16px;
    color: var(--accent-2);
    letter-spacing: -0.03em;
  }
  .hit-ring-label span {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .spark { margin-bottom: 10px; }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px;
    overflow: visible;
  }
  .kpi {
    border: 1px solid var(--line);
    background: rgba(24, 24, 27, 0.02);
    padding: 7px 9px;
    position: relative;
    overflow: visible;
  }
  .kpi:hover, .kpi:focus-within { z-index: 8; }
  .kpi .k {
    display: flex;
    align-items: center;
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  .kpi .v {
    display: block;
    margin-top: 2px;
    font-family: var(--mono);
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.03em;
  }
  .stat .v.health-ok, .kpi .v.health-ok { color: var(--ok); }
  .stat .v.health-warn, .kpi .v.health-warn { color: var(--warn); }
  .stat .v.health-bad, .kpi .v.health-bad { color: var(--bad); }
  .advice-list {
    margin: 0;
    padding: 0 0 0 18px;
  }
  .advice-list li {
    margin: 6px 0;
    font-size: 13px;
    line-height: 1.45;
  }
  .advice-list code {
    font-family: var(--mono);
    font-size: 12px;
    background: rgba(24, 24, 27, 0.05);
    border: 1px solid var(--line);
    padding: 1px 6px;
  }
  .ephemeral-ws {
    margin-top: 14px;
  }
  .ephemeral-ws summary {
    cursor: pointer;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 8px;
  }
  .bar-track {
    height: 10px;
    background: rgba(24, 24, 27, 0.06);
    border: 1px solid var(--line);
    overflow: hidden;
    border-radius: 2px;
  }
  .bar-fill {
    display: block;
    height: 100%;
    min-width: 2px;
    background: linear-gradient(90deg, var(--accent), var(--accent-2));
  }
  .heavy-bar {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 10px;
    align-items: center;
    min-width: 160px;
  }
  .heavy-bar .bar-track {
    width: 100%;
    min-width: 120px;
  }
  .heavy-bar-val {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
    min-width: 2.5ch;
    text-align: right;
  }
  .heavy-bar-cell {
    width: 42%;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }
  th, td {
    text-align: left;
    padding: 9px 10px;
    border-bottom: 1px solid var(--line);
  }
  tr:last-child td { border-bottom: none; }
  th {
    color: var(--muted);
    font-weight: 600;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    background: rgba(42, 38, 34, 0.03);
  }
  tbody tr:hover td { background: rgba(232, 165, 75, 0.08); }
  .mono { font-family: var(--mono); }
  .path { word-break: break-all; }
  .num { font-family: var(--mono); text-align: right; }
  .muted { color: var(--muted); }
  .mem-list { list-style: none; margin: 0; padding: 0; }
  .mem {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 10px;
    align-items: start;
    padding: 10px 0;
    border-bottom: 1px solid var(--line);
  }
  .pill {
    font-family: var(--mono);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--accent-2);
    background: var(--accent-dim);
    border: 1px solid rgba(232, 165, 75, 0.35);
    padding: 3px 7px;
    white-space: nowrap;
  }
  .mem-text { font-size: 13px; }
  footer {
    margin-top: 28px;
    padding: 14px 16px;
    border: 1px solid var(--line);
    background: rgba(255, 253, 249, 0.72);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
  }
  .full { grid-column: 1 / -1; }
  .graph-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 12px;
  }
  .graph-head h2 { margin: 0; }
  .graph-actions { display: flex; gap: 8px; }
  .graph-btn {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
    background: var(--bg-2);
    border: 1px solid var(--line);
    padding: 7px 12px;
    cursor: pointer;
    box-shadow: var(--shadow);
  }
  .graph-btn:hover {
    border-color: rgba(232, 165, 75, 0.55);
    color: var(--accent-2);
    background: #fff;
  }
  .graph-shell {
    position: relative;
    border: 1px solid var(--line);
    --grid: 28px;
    background-color: var(--graph-bg);
    background-image:
      linear-gradient(rgba(113, 113, 122, 0.14) 1px, transparent 1px),
      linear-gradient(90deg, rgba(113, 113, 122, 0.14) 1px, transparent 1px),
      radial-gradient(ellipse at 48% 42%, rgba(255, 255, 255, 0.9) 0%, transparent 68%);
    background-size: var(--grid) var(--grid), var(--grid) var(--grid), 100% 100%;
    background-position: 0 0, 0 0, center;
    height: 560px;
    overflow: hidden;
    touch-action: none;
  }
  .graph-shell:fullscreen,
  .graph-shell:-webkit-full-screen {
    width: 100vw;
    height: 100vh;
    border: none;
    --grid: 32px;
    background-color: var(--graph-bg);
  }
  .graph-shell canvas {
    width: 100%;
    height: 100%;
    display: block;
    cursor: grab;
  }
  .graph-shell canvas.dragging { cursor: grabbing; }
  .graph-hud {
    position: absolute;
    left: 12px;
    top: 12px;
    z-index: 2;
    pointer-events: none;
  }
  .graph-hint {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid var(--line);
    padding: 8px 10px;
  }
  .graph-panel {
    position: absolute;
    top: 12px;
    right: 12px;
    bottom: 12px;
    width: min(320px, 42%);
    z-index: 3;
    display: none;
    flex-direction: column;
    gap: 10px;
    padding: 14px 14px 12px;
    background: rgba(255, 255, 255, 0.96);
    border: 1px solid var(--line);
    box-shadow: 0 12px 40px rgba(24, 24, 27, 0.08);
    overflow: auto;
    pointer-events: auto;
  }
  .graph-panel.open { display: flex; }
  .graph-panel-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
  }
  .graph-panel-title {
    font-family: var(--mono);
    font-size: 13px;
    font-weight: 600;
    color: var(--text);
    word-break: break-word;
  }
  .graph-panel-close {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    background: transparent;
    border: 1px solid var(--line);
    padding: 3px 8px;
    cursor: pointer;
    flex-shrink: 0;
  }
  .graph-panel-close:hover { color: var(--text); border-color: var(--muted); }
  .graph-kv {
    display: grid;
    grid-template-columns: 88px 1fr;
    gap: 4px 10px;
    font-family: var(--mono);
    font-size: 11px;
  }
  .graph-kv .k { color: var(--muted); }
  .graph-kv .v { color: var(--text); word-break: break-word; }
  .graph-panel h3 {
    margin: 4px 0 0;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--muted);
  }
  .graph-chip-list {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .graph-chip-list li {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--text);
    background: var(--accent-dim);
    border: 1px solid rgba(232, 165, 75, 0.35);
    padding: 3px 7px;
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }
  .graph-chip-list li:hover { background: rgba(232, 165, 75, 0.22); }
  .graph-path-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .graph-path-list li {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--muted);
    padding: 3px 0;
    word-break: break-all;
    border-bottom: 1px solid rgba(224, 216, 204, 0.7);
  }
  .graph-sig {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--text);
    background: rgba(255,255,255,0.65);
    border: 1px solid var(--line);
    padding: 8px;
    white-space: pre-wrap;
    word-break: break-word;
  }
  .scope-tabs {
    display: flex;
    gap: 0;
    margin: 0 0 16px;
    border: 1px solid var(--line);
    background: var(--bg-2);
    box-shadow: var(--shadow);
    width: fit-content;
  }
  .scope-tab {
    font-family: var(--mono);
    font-size: 11px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--muted);
    background: transparent;
    border: none;
    border-right: 1px solid var(--line);
    padding: 9px 16px;
    cursor: pointer;
  }
  .scope-tab:last-child { border-right: none; }
  .scope-tab:hover { color: var(--accent-2); }
  .scope-tab.is-active {
    color: var(--accent-2);
    background: var(--accent-dim);
    font-weight: 600;
  }
  .scope-pane[hidden] { display: none; }
  tbody tr.is-current td { background: var(--accent-dim); }
  .tip {
    position: static;
    display: inline-flex;
    margin-left: 6px;
    vertical-align: middle;
    flex-shrink: 0;
  }
  .tip-mark {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 1px solid var(--line);
    background: rgba(24, 24, 27, 0.04);
    color: var(--muted);
    font-size: 9px;
    font-weight: 700;
    font-family: var(--mono);
    display: grid;
    place-items: center;
    cursor: help;
    line-height: 1;
    text-transform: none;
    letter-spacing: 0;
  }
  .tip-body {
    display: none;
    position: fixed;
    z-index: 9999;
    width: 260px;
    padding: 10px 12px;
    background: #18181b;
    color: #f4f4f5;
    font-family: var(--sans);
    font-size: 11px;
    font-weight: 400;
    letter-spacing: 0;
    text-transform: none;
    line-height: 1.45;
    box-shadow: 0 8px 24px rgba(24, 24, 27, 0.18);
    white-space: normal;
    pointer-events: none;
  }
  .stat .tip-body, .kpi .tip-body {
    width: 260px;
  }
</style>
</head>
<body>
<div class="page">
  <header>
    <div>
      <div class="brand-row">
        <span class="brand-mark">Local</span>
        <h1>FastPath report</h1>
      </div>
      <div class="sub">${escapeHtml(data.workspace)}</div>
    </div>
    <div class="meta-right">
      <div>indexed <strong>${escapeHtml(data.indexedAt || 'never')}</strong></div>
      <div>embed <span class="meta-chip">${escapeHtml(data.embedBackend || '?')}</span>
        schema <span class="meta-chip">${escapeHtml(data.schemaVersion || '?')}</span>
        ann <span class="meta-chip">${escapeHtml(data.annBackend || '?')}</span></div>
      <div>snapshot ${escapeHtml(data.generatedAt)}</div>
    </div>
  </header>

  <nav class="scope-tabs" role="tablist" aria-label="Report scope">
    <button type="button" class="scope-tab is-active" data-tab="project" role="tab" aria-selected="true">This project</button>
    <button type="button" class="scope-tab" data-tab="global" role="tab" aria-selected="false">All FastPath</button>
  </nav>

  <div class="scope-pane" data-scope="project">
  <div class="grid-stats" id="index-stats">
    ${statCard('files', String(s.files))}
    ${statCard('symbols', String(s.symbols))}
    ${statCard('imports', String(s.importEdges))}
    ${statCard('callEdges', String(s.callEdges))}
    ${statCard('vectors', String(s.vectors))}
    ${statCard('ngrams', String(s.ngrams))}
    ${statCard('memories', String(s.memories))}
    ${statCard('coverage', formatCoverage(s.vectors, s.symbols), healthClass('coverage', coverageRatio))}
  </div>

  <div class="layout">
    <section class="panel">
      ${sectionTitle('filesByFolder')}
      ${lollipopChart(data.folders) || '<p class="muted">No files indexed.</p>'}
    </section>
    <section class="panel">
      ${sectionTitle('symbolKinds')}
      ${donutChart(data.symbolKinds, 'Symbol kinds') || '<p class="muted">No symbols.</p>'}
    </section>
    <section class="panel">
      ${sectionTitle('languages')}
      ${donutChart(data.languages, 'Languages') || '<p class="muted">No languages.</p>'}
    </section>
    <section class="panel">
      ${sectionTitle('usageProject')}
      ${usageBody(data.projectMetrics, 'No events tagged to this path. Untagged and other-repo numbers live on All FastPath.')}
    </section>
    ${adviceBlock(data.projectMetrics, { workspace: data.workspace, coveragePct: coverageRatio })}

    <section class="panel full">
      ${sectionTitle('heaviestFiles')}
      ${
        heavyRows
          ? `<table>
        <thead><tr><th>Path</th><th>Symbols (vs heaviest)</th><th>Lang</th></tr></thead>
        <tbody>${heavyRows}</tbody>
      </table>`
          : '<p class="muted">No symbols yet.</p>'
      }
    </section>

    <section class="panel full">
      <div class="graph-head">
        ${sectionTitle('callGraph')}
        <div class="graph-actions">
          <button type="button" class="graph-btn" id="graph-fullscreen">Fullscreen</button>
        </div>
      </div>
      ${
        data.callGraph.nodes.length
          ? `<div class="graph-shell" id="graph-shell">
        <canvas id="graph"></canvas>
        <div class="graph-hud">
          <div class="graph-hint">Drag · scroll zoom · pan · click node for details</div>
        </div>
        <aside class="graph-panel" id="graph-panel" aria-live="polite">
          <div class="graph-panel-head">
            <div class="graph-panel-title" id="gp-title">—</div>
            <button type="button" class="graph-panel-close" id="gp-close">Close</button>
          </div>
          <div class="graph-kv" id="gp-kv"></div>
          <div id="gp-sig-wrap" hidden>
            <h3>Signature</h3>
            <div class="graph-sig" id="gp-sig"></div>
          </div>
          <div id="gp-paths-wrap" hidden>
            <h3>Paths</h3>
            <ul class="graph-path-list" id="gp-paths"></ul>
          </div>
          <div id="gp-callers-wrap" hidden>
            <h3>Top callers</h3>
            <ul class="graph-chip-list" id="gp-callers"></ul>
          </div>
          <div id="gp-callees-wrap" hidden>
            <h3>Top callees</h3>
            <ul class="graph-chip-list" id="gp-callees"></ul>
          </div>
        </aside>
      </div>
      <p class="muted" style="margin-top:8px;font-family:var(--mono);font-size:11px">
        ${data.callGraph.nodes.length} nodes · ${data.callGraph.edges.length} edges · noise (jest/expect/JSON/…) filtered
      </p>`
          : '<p class="muted">No call edges.</p>'
      }
    </section>

    <section class="panel full">
      ${sectionTitle('memoriesList')}
      ${
        memBlock
          ? `<ul class="mem-list">${memBlock}</ul>`
          : '<p class="muted">No memories yet.</p>'
      }
    </section>
  </div>
  </div>

  <div class="scope-pane" data-scope="global" hidden>
    ${ledgerStrip(data.globalMetrics)}
    <div class="layout">
      <section class="panel">
        ${sectionTitle('usageGlobal')}
        ${injectMetricsBlock(data.globalMetrics)}
      </section>
      <section class="panel">
        ${sectionTitle('eventMix')}
        ${donutChart(data.eventMix, 'Event mix') || '<p class="muted">No journal events yet.</p>'}
      </section>
      ${adviceBlock(data.globalMetrics)}
      <section class="panel full">
        ${sectionTitle('workspaces')}
        ${workspaceTable(data.workspaces, data.workspace)}
        <p class="muted ledger-legend">${data.untaggedEvents} untagged events (legacy journal rows with no workspace field).</p>
      </section>
    </div>
  </div>

  <footer>
    Local read-only snapshot from ${escapeHtml(data.dbPath)}. Nothing leaves this machine.
    This project = index + tagged usage. All FastPath = user-level journal.
    Re-run <span style="color:var(--accent)">fastpath viz</span> after indexing.
  </footer>
</div>

  <script>
  (function () {
    document.querySelectorAll('.tip').forEach(function (tip) {
      var body = tip.querySelector('.tip-body');
      if (!body) return;
      function hide() { body.style.display = 'none'; }
      function show() {
        var mark = tip.querySelector('.tip-mark') || tip;
        var r = mark.getBoundingClientRect();
        var w = Math.min(280, window.innerWidth - 16);
        var left = r.left;
        if (left + w > window.innerWidth - 8) left = window.innerWidth - w - 8;
        if (left < 8) left = 8;
        var top = r.bottom + 8;
        if (top + 120 > window.innerHeight) top = Math.max(8, r.top - 8 - 120);
        body.style.left = left + 'px';
        body.style.top = top + 'px';
        body.style.display = 'block';
      }
      tip.addEventListener('mouseenter', show);
      tip.addEventListener('focus', show);
      tip.addEventListener('mouseleave', hide);
      tip.addEventListener('blur', hide);
    });
  })();
  </script>

  <script>
  (function () {
    var tabs = document.querySelectorAll('.scope-tab');
    var panes = document.querySelectorAll('.scope-pane');
    function show(name) {
      tabs.forEach(function (t) {
        var on = t.getAttribute('data-tab') === name;
        t.classList.toggle('is-active', on);
        t.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      panes.forEach(function (p) {
        p.hidden = p.getAttribute('data-scope') !== name;
      });
      if (history.replaceState) history.replaceState(null, '', '#' + name);
      window.dispatchEvent(new Event('resize'));
    }
    tabs.forEach(function (t) {
      t.addEventListener('click', function () { show(t.getAttribute('data-tab')); });
    });
    var hash = (location.hash || '#project').slice(1);
    if (hash !== 'global' && hash !== 'project') hash = 'project';
    show(hash);
  })();
  </script>

  <script>
  (function () {
    var graph = ${graphJson};
    var shell = document.getElementById('graph-shell');
    var canvas = document.getElementById('graph');
    var panel = document.getElementById('graph-panel');
    var fsBtn = document.getElementById('graph-fullscreen');
    var gpClose = document.getElementById('gp-close');
    if (!shell || !canvas || !graph.nodes.length) return;

    var ctx = canvas.getContext('2d');
    var dpr = 1;
    var cssW = 0, cssH = 0;
    var scale = 1, ox = 0, oy = 0;
    var hoverId = null;
    var selectedId = null;
    var dragNode = null;
    var panning = false;
    var moved = false;
    var downX = 0, downY = 0;
    var lastX = 0, lastY = 0;
    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var META = {};
    graph.nodes.forEach(function (n) { META[n.id] = n; });

    function resize() {
      dpr = window.devicePixelRatio || 1;
      cssW = shell.clientWidth;
      cssH = shell.clientHeight;
      canvas.width = Math.max(1, Math.floor(cssW * dpr));
      canvas.height = Math.max(1, Math.floor(cssH * dpr));
      canvas.style.width = cssW + 'px';
      canvas.style.height = cssH + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    resize();
    window.addEventListener('resize', resize);
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resize).observe(shell);

    var nodes = graph.nodes.map(function (n, i) {
      var angle = (i / Math.max(graph.nodes.length, 1)) * Math.PI * 2;
      var spread = Math.min(cssW, cssH) * 0.3;
      return {
        id: n.id,
        label: n.label,
        degree: n.degree || 1,
        x: cssW / 2 + Math.cos(angle) * spread,
        y: cssH / 2 + Math.sin(angle) * spread,
        z: 0.35 + (i % 7) * 0.09,
        vx: 0,
        vy: 0,
        r: 4 + Math.min(14, Math.log2((n.degree || 1) + 1) * 2.8)
      };
    });
    var byId = {};
    nodes.forEach(function (n) { byId[n.id] = n; });
    var edges = graph.edges.filter(function (e) { return byId[e.from] && byId[e.to]; });
    var neighbors = {};
    nodes.forEach(function (n) { neighbors[n.id] = {}; });
    edges.forEach(function (e) {
      neighbors[e.from][e.to] = true;
      neighbors[e.to][e.from] = true;
    });

    function pointerPos(ev) {
      var rect = canvas.getBoundingClientRect();
      var rw = rect.width || 1, rh = rect.height || 1;
      return {
        x: (ev.clientX - rect.left) * (cssW / rw),
        y: (ev.clientY - rect.top) * (cssH / rh)
      };
    }
    function screenToWorld(sx, sy) {
      return { x: (sx - ox) / scale, y: (sy - oy) / scale };
    }
    function hitTest(sx, sy) {
      var p = screenToWorld(sx, sy);
      var best = null, bestD = Infinity;
      var pad = 10 / scale;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var rr = n.r * (0.75 + n.z * 0.55);
        var dx = n.x - p.x, dy = n.y - p.y;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= rr + pad && d < bestD) { best = n; bestD = d; }
      }
      return best;
    }
    function focusId() { return selectedId || hoverId; }
    function linked(a, b) {
      return a === b || (neighbors[a] && neighbors[a][b]);
    }

    function tick() {
      if (dragNode) return;
      var i, j, a, b, dx, dy, dist, force, fx, fy;
      for (i = 0; i < nodes.length; i++) {
        for (j = i + 1; j < nodes.length; j++) {
          a = nodes[i]; b = nodes[j];
          dx = a.x - b.x; dy = a.y - b.y;
          dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
          force = (2400 + nodes.length * 10) / (dist * dist);
          fx = (dx / dist) * force; fy = (dy / dist) * force;
          a.vx += fx; a.vy += fy;
          b.vx -= fx; b.vy -= fy;
        }
      }
      for (i = 0; i < edges.length; i++) {
        var e = edges[i];
        a = byId[e.from]; b = byId[e.to];
        dx = b.x - a.x; dy = b.y - a.y;
        var ideal = 100 + Math.min(50, (e.weight || 1) * 2);
        dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        force = (dist - ideal) * 0.011;
        fx = (dx / dist) * force; fy = (dy / dist) * force;
        a.vx += fx; a.vy += fy;
        b.vx -= fx; b.vy -= fy;
      }
      for (i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        n.vx += (cssW / 2 - n.x) * 0.0028;
        n.vy += (cssH / 2 - n.y) * 0.0028;
        n.vx *= 0.84; n.vy *= 0.84;
        n.x += n.vx; n.y += n.vy;
      }
    }

    function drawSphere(n, mode, dim) {
      var focus = mode === 'focus';
      var neighbor = mode === 'neighbor';
      var rr = n.r * (0.75 + n.z * 0.55) * (focus ? 1.15 : 1);
      var alpha = dim ? 0.12 : (0.5 + n.z * 0.45);
      if (focus || neighbor) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr * (focus ? 2.6 : 1.8), 0, Math.PI * 2);
        var halo = ctx.createRadialGradient(n.x, n.y, rr * 0.15, n.x, n.y, rr * (focus ? 2.6 : 1.8));
        halo.addColorStop(0, focus ? 'rgba(232,165,75,0.4)' : 'rgba(232,165,75,0.2)');
        halo.addColorStop(1, 'rgba(232,165,75,0)');
        ctx.fillStyle = halo;
        ctx.globalAlpha = 1;
        ctx.fill();
      }
      var g = ctx.createRadialGradient(
        n.x - rr * 0.35, n.y - rr * 0.4, rr * 0.05,
        n.x, n.y, rr
      );
      if (focus || neighbor) {
        g.addColorStop(0, '#fde68a');
        g.addColorStop(0.4, '#e8a54b');
        g.addColorStop(1, '#b45309');
      } else {
        g.addColorStop(0, '#f4f4f5');
        g.addColorStop(0.55, '#d4d4d8');
        g.addColorStop(1, '#a1a1aa');
      }
      ctx.beginPath();
      ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = g;
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    function draw() {
      ctx.clearRect(0, 0, cssW, cssH);
      ctx.save();
      ctx.translate(ox, oy);
      ctx.scale(scale, scale);
      var fid = focusId();

      for (var i = 0; i < edges.length; i++) {
        var e = edges[i];
        var a = byId[e.from], b = byId[e.to];
        var active = !fid || linked(fid, a.id) || linked(fid, b.id);
        var hot = fid && (a.id === fid || b.id === fid) && linked(a.id, b.id);
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.strokeStyle = hot ? 'rgba(217,119,6,0.5)' : (active ? 'rgba(113,113,122,0.22)' : 'rgba(113,113,122,0.04)');
        ctx.lineWidth = (hot ? 1.2 : 0.65) / scale;
        ctx.stroke();
      }

      var ordered = nodes.slice().sort(function (a, b) { return a.z - b.z; });
      for (i = 0; i < ordered.length; i++) {
        var n = ordered[i];
        var on = !fid || linked(fid, n.id);
        var isFocus = fid === n.id;
        var isNeighbor = !!(fid && !isFocus && linked(fid, n.id));
        var mode = isFocus ? 'focus' : (isNeighbor ? 'neighbor' : 'idle');
        drawSphere(n, mode, !on);
        var rr = n.r * (0.75 + n.z * 0.55);
        ctx.font = (isFocus ? 12 : 10) / Math.sqrt(scale) + 'px ui-monospace, Menlo, monospace';
        if (isFocus) ctx.fillStyle = 'rgba(24,24,27,0.92)';
        else if (on) ctx.fillStyle = 'rgba(63,63,70,0.75)';
        else ctx.fillStyle = 'rgba(113,113,122,0.28)';
        ctx.fillText(n.label.slice(0, 36), n.x + rr + 5, n.y + 3);
      }
      ctx.restore();
    }

    function esc(s) {
      return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function setList(el, wrap, items, clickable) {
      if (!el || !wrap) return;
      el.innerHTML = '';
      if (!items || !items.length) { wrap.hidden = true; return; }
      wrap.hidden = false;
      items.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item;
        li.title = item;
        if (clickable && byId[item]) {
          li.addEventListener('click', function () { selectNode(byId[item]); });
        }
        el.appendChild(li);
      });
    }
    function selectNode(n) {
      if (!n) return;
      selectedId = n.id;
      hoverId = n.id;
      var meta = META[n.id] || {};
      var links = Object.keys(neighbors[n.id] || {}).length;
      if (panel) panel.classList.add('open');
      var title = document.getElementById('gp-title');
      if (title) title.textContent = n.label;
      var kv = document.getElementById('gp-kv');
      if (kv) {
        kv.innerHTML =
          '<div class="k">Kind</div><div class="v">' + esc(meta.symbolKind || meta.kind || 'symbol') + '</div>' +
          '<div class="k">Degree</div><div class="v">' + esc(n.degree) + ' inbound calls</div>' +
          '<div class="k">Graph links</div><div class="v">' + links + ' neighbors in sample</div>' +
          '<div class="k">Callers</div><div class="v">' + esc(meta.callers != null ? meta.callers : '—') + '</div>' +
          '<div class="k">Callees</div><div class="v">' + esc(meta.callees != null ? meta.callees : '—') + '</div>' +
          (meta.line != null ? '<div class="k">Line</div><div class="v">' + esc(meta.line) + '</div>' : '');
      }
      var sig = document.getElementById('gp-sig');
      var sigWrap = document.getElementById('gp-sig-wrap');
      if (sig && sigWrap) {
        if (meta.signature) { sig.textContent = meta.signature; sigWrap.hidden = false; }
        else sigWrap.hidden = true;
      }
      setList(document.getElementById('gp-paths'), document.getElementById('gp-paths-wrap'), meta.paths || [], false);
      setList(document.getElementById('gp-callers'), document.getElementById('gp-callers-wrap'), meta.topCallers || [], true);
      setList(document.getElementById('gp-callees'), document.getElementById('gp-callees-wrap'), meta.topCallees || [], true);
    }
    function clearSelection() {
      selectedId = null;
      if (panel) panel.classList.remove('open');
    }
    if (gpClose) gpClose.addEventListener('click', clearSelection);

    function loop() {
      if (!reduceMotion) tick();
      draw();
      requestAnimationFrame(loop);
    }
    for (var s = 0; s < (reduceMotion ? 180 : 100); s++) tick();
    loop();

    function isFullscreen() {
      return document.fullscreenElement === shell || document.webkitFullscreenElement === shell;
    }
    function syncFsLabel() {
      if (fsBtn) fsBtn.textContent = isFullscreen() ? 'Exit fullscreen' : 'Fullscreen';
    }
    async function toggleFullscreen() {
      try {
        if (isFullscreen()) {
          if (document.exitFullscreen) await document.exitFullscreen();
          else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        } else if (shell.requestFullscreen) await shell.requestFullscreen();
        else if (shell.webkitRequestFullscreen) shell.webkitRequestFullscreen();
      } catch (err) {}
      resize();
      syncFsLabel();
    }
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', function () { resize(); syncFsLabel(); });
    document.addEventListener('webkitfullscreenchange', function () { resize(); syncFsLabel(); });

    canvas.addEventListener('wheel', function (ev) {
      ev.preventDefault();
      var p = pointerPos(ev);
      var before = screenToWorld(p.x, p.y);
      var factor = ev.deltaY < 0 ? 1.08 : 0.92;
      scale = Math.max(0.35, Math.min(4.5, scale * factor));
      ox = p.x - before.x * scale;
      oy = p.y - before.y * scale;
    }, { passive: false });

    canvas.addEventListener('pointerdown', function (ev) {
      var p = pointerPos(ev);
      downX = p.x; downY = p.y;
      lastX = p.x; lastY = p.y;
      moved = false;
      var hit = hitTest(p.x, p.y);
      if (hit) {
        dragNode = hit;
        hit.vx = 0; hit.vy = 0;
      } else {
        panning = true;
      }
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('dragging');
    });

    canvas.addEventListener('pointermove', function (ev) {
      var p = pointerPos(ev);
      if (Math.abs(p.x - downX) + Math.abs(p.y - downY) > 4) moved = true;
      if (dragNode) {
        var w = screenToWorld(p.x, p.y);
        dragNode.x = w.x; dragNode.y = w.y;
        dragNode.vx = 0; dragNode.vy = 0;
      } else if (panning) {
        ox += p.x - lastX;
        oy += p.y - lastY;
        lastX = p.x; lastY = p.y;
      } else {
        var hit = hitTest(p.x, p.y);
        hoverId = hit ? hit.id : null;
        canvas.style.cursor = hit ? 'pointer' : 'grab';
      }
    });

    function endDrag(ev) {
      var p = pointerPos(ev);
      var hit = hitTest(p.x, p.y);
      if (!moved) {
        if (hit) selectNode(hit);
        else clearSelection();
      }
      dragNode = null;
      panning = false;
      canvas.classList.remove('dragging');
      try { canvas.releasePointerCapture(ev.pointerId); } catch (e) {}
    }
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    canvas.addEventListener('pointerleave', function () {
      if (!dragNode && !panning) hoverId = null;
    });
  })();
  </script>
</body>
</html>`;
}

export function runViz(options: VizOptions): { outPath: string; data: VizPageData } {
  const data = buildVizPageData(options.workspace);
  const html = renderVizHtml(data);
  const hash = createHash('sha1').update(options.workspace).digest('hex').slice(0, 8);
  const stamp = Date.now().toString(36);
  const outPath =
    options.outPath || join(tmpdir(), `fastpath-viz-${hash}-${stamp}.html`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, 'utf8');
  if (options.openBrowser) openInBrowser(outPath);
  return { outPath, data };
}
