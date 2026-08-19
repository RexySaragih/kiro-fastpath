import { ArrowsClockwise } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { fetchViz } from '../api';
import type { CountRow, JobResult, JobSpec, VizMetricsSummary, VizPageData } from '../types';
import { EmptyState, InlineError, Panel, PanelLabel } from '../components/EmptyState';
import { MagneticButton } from '../components/MagneticButton';
import { ScreenSkeleton } from '../components/Skeleton';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

function formatTokens(value: number | null): string {
  if (value == null) return 'n/a';
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

function formatHit(value: number | null): string {
  if (value == null) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

function usageAdvice(
  m: VizMetricsSummary,
  workspace?: string,
  coveragePct?: number | null,
): string[] {
  const ws = workspace ? ` ${workspace}` : '';
  if (m.events === 0) return [`Run: fastpath use${ws} and start a Kiro session`];
  const lines: string[] = [];
  if (m.retrievalInjects > 0 && m.hitRate != null && m.hitRate < 0.25) {
    lines.push(`Run: fastpath index${ws}`);
  }
  if (m.mcpCalls === 0) {
    lines.push('Agent not using MCP tools. Spawn Scout to gather, or call find/window.');
  }
  if (m.netTokens != null && m.netTokens < 0) {
    lines.push('Prefer MCP find/window over host file reads.');
  }
  if (coveragePct === 0) {
    lines.push('Run: fastpath warm && fastpath index --rebuild');
  }
  if (m.timeouts > 0) {
    lines.push('Consider: fastpath watch for live reindexing');
  }
  return lines;
}

function Ring({ value, label }: { value: number | null; label: string }) {
  const pct = value == null ? 0 : Math.max(0, Math.min(1, value));
  const r = 36;
  const c = 2 * Math.PI * r;
  return (
    <div className="flex items-center gap-4">
      <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
        <circle cx="48" cy="48" r={r} fill="none" stroke="#d6d3d1" strokeWidth="8" />
        <motion.circle
          cx="48"
          cy="48"
          r={r}
          fill="none"
          stroke="#b45309"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={c}
          initial={{ strokeDashoffset: c }}
          animate={{ strokeDashoffset: c * (1 - pct) }}
          transition={SPRING}
        />
      </svg>
      <div>
        <p className="font-mono text-2xl tabular-nums tracking-tight text-stone-900">
          {formatHit(value)}
        </p>
        <p className="text-xs text-stone-500">{label}</p>
      </div>
    </div>
  );
}

function CountList({ rows }: { rows: CountRow[] }) {
  const max = rows[0]?.count ?? 1;
  return (
    <ul className="space-y-2">
      {rows.slice(0, 8).map((row, i) => (
        <li key={row.label} className="grid grid-cols-[1fr_auto] gap-3 text-sm">
          <div>
            <p className="truncate text-stone-700">{row.label}</p>
            <div className="mt-1 h-px bg-stone-200">
              <motion.div
                className="h-px bg-accent/70"
                initial={{ width: 0 }}
                animate={{ width: `${(row.count / max) * 100}%` }}
                transition={{ ...SPRING, delay: i * 0.04 }}
              />
            </div>
          </div>
          <span className="font-mono tabular-nums text-stone-500">{row.count}</span>
        </li>
      ))}
    </ul>
  );
}

export function SignalScreen({
  workspace,
  onRun,
}: {
  workspace: string;
  onRun: (spec: JobSpec) => Promise<JobResult>;
}) {
  const [data, setData] = useState<VizPageData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<'project' | 'global'>('project');

  const reload = useCallback(() => {
    setLoading(true);
    return fetchViz(workspace)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setLoading(false));
  }, [workspace]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function indexAndReload() {
    setBusy(true);
    try {
      await onRun({ verb: 'index', workspace });
      await reload();
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <ScreenSkeleton />;
  if (error) {
    return (
      <EmptyState
        title="No index snapshot"
        body={error}
        command={`fastpath index ${workspace}`}
        action={
          <MagneticButton disabled={busy} onClick={() => void indexAndReload()}>
            {busy ? 'Indexing…' : 'Run index now'}
          </MagneticButton>
        }
      />
    );
  }
  if (!data) return <InlineError message="No viz data" />;

  const metrics = scope === 'project' ? data.projectMetrics : data.globalMetrics;
  const coverage =
    data.summary.symbols > 0 ? data.summary.vectors / data.summary.symbols : null;
  const advice = usageAdvice(metrics, workspace, coverage === 0 ? 0 : coverage);

  const ledger = [
    { k: 'Injected', v: metrics.injectedTokens },
    { k: 'Spent', v: metrics.spentTokens },
    { k: 'Avoided', v: metrics.tokensAvoided },
    { k: 'Net', v: metrics.netTokens },
  ];

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-8">
        <div>
          <Panel>
            <div className="flex items-end justify-between gap-4">
              <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
                Token ledger
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void reload()}
                title="Refresh metrics"
                className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-700 active:scale-[0.98] disabled:opacity-40"
              >
                <ArrowsClockwise weight="regular" className="size-3.5" />
                Refresh
              </button>
              <div className="relative flex rounded-full border border-stone-200 p-1">
                {(['project', 'global'] as const).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setScope(id)}
                    className="relative px-3 py-1 text-xs tracking-tight text-stone-700 active:scale-[0.98]"
                  >
                    {scope === id ? (
                      <motion.span
                        layoutId="scope-pill"
                        className="absolute inset-0 rounded-full bg-stone-200"
                        transition={SPRING}
                      />
                    ) : null}
                    <span className="relative">{id}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="mt-6 grid grid-cols-2 gap-6">
              {ledger.map((row) => (
                <div key={row.k}>
                  <p className="text-[11px] text-stone-500">{row.k}</p>
                  <p className="font-mono text-2xl tabular-nums tracking-tight text-stone-900">
                    {formatTokens(row.v)}
                  </p>
                </div>
              ))}
            </div>
            <p className="mt-6 max-w-[65ch] text-sm leading-relaxed text-stone-600">
              {metrics.insight || 'No insight yet — wait for inject or MCP samples.'}
            </p>
          </Panel>
          <PanelLabel title="Ledger" body="Avoided minus spent. n/a until the journal has samples." />
        </div>

        <div>
          <Panel>
            <div className="grid gap-8 md:grid-cols-2">
              <Ring value={metrics.hitRate} label="Inject hit" />
              <Ring value={metrics.codeHitRate} label="Code-intent hit" />
            </div>
          </Panel>
          <PanelLabel title="Hit rate" body="Retrieval injects only. Housekeeping noPrompt events are excluded." />
        </div>

        <div>
          <Panel>
            <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
              Index
            </p>
            <dl className="mt-6 grid grid-cols-2 gap-4 font-mono text-sm md:grid-cols-3">
              <Stat k="Files" v={data.summary.files} />
              <Stat k="Symbols" v={data.summary.symbols} />
              <Stat k="Vectors" v={data.summary.vectors} />
              <Stat k="Calls" v={data.summary.callEdges} />
              <Stat k="Memories" v={data.summary.memories} />
              <Stat
                k="Coverage"
                v={coverage == null ? 'n/a' : `${(coverage * 100).toFixed(1)}%`}
              />
            </dl>
            <div className="mt-8 grid gap-8 md:grid-cols-2">
              <CountList rows={data.folders} />
              <CountList rows={data.symbolKinds} />
            </div>
          </Panel>
          <PanelLabel title="Snapshot" body="Coverage is symbol_vectors / symbols." />
        </div>
      </div>

      <div className="space-y-8">
        <div>
          <Panel>
            <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
              Actions
            </p>
            {advice.length === 0 ? (
              <p className="mt-4 text-sm text-stone-500">Nothing queued.</p>
            ) : (
              <ul className="mt-4 divide-y divide-stone-200">
                {advice.map((line) => (
                  <li key={line} className="py-3 text-sm leading-relaxed text-stone-700">
                    {line}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <PanelLabel title="Advice" body="Same rules as fastpath viz." />
        </div>
        <div>
          <Panel>
            <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
              Event mix
            </p>
            <div className="mt-4">
              <CountList rows={data.eventMix} />
            </div>
          </Panel>
          <PanelLabel title="Journal" body="All-machine metrics.jsonl grouped by event type." />
        </div>
        {metrics.events === 0 ? (
          <EmptyState
            title="No journal events"
            body="Start a Kiro session in a wired workspace so inject and MCP write the ledger."
            command={`fastpath use ${workspace}`}
          />
        ) : null}
      </div>
    </div>
  );
}

function Stat({ k, v }: { k: string; v: number | string }) {
  return (
    <div>
      <dt className="text-[11px] text-stone-500">{k}</dt>
      <dd className="tabular-nums text-stone-900">{v}</dd>
    </div>
  );
}
