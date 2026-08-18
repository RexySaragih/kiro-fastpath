import { CheckCircle, Warning, Info } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useEffect, useState } from 'react';
import { fetchDoctor } from '../api';
import type { DoctorResult } from '../types';
import { BreathingDot } from '../components/BreathingDot';
import { EmptyState, InlineError, Panel, PanelLabel } from '../components/EmptyState';
import { ScreenSkeleton } from '../components/Skeleton';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

function Column({
  title,
  items,
  Icon,
  tone,
}: {
  title: string;
  items: string[];
  Icon: typeof CheckCircle;
  tone: string;
}) {
  return (
    <div>
      <p className={`flex items-center gap-2 text-sm tracking-tight ${tone}`}>
        <Icon weight="regular" className="size-4" />
        {title}
        <span className="font-mono text-xs text-stone-500">{items.length}</span>
      </p>
      {items.length === 0 ? (
        <p className="mt-3 text-xs text-stone-600">None</p>
      ) : (
        <ul className="mt-3 divide-y divide-stone-200">
          {items.map((line, i) => (
            <motion.li
              key={`${title}-${i}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...SPRING, delay: i * 0.04 }}
              className="py-3 text-sm leading-relaxed text-stone-700"
            >
              {line}
            </motion.li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function HealthScreen({ workspace }: { workspace: string }) {
  const [data, setData] = useState<DoctorResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetchDoctor(workspace)
      .then((d) => {
        if (live) {
          setData(d);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (live) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [workspace]);

  if (loading) return <ScreenSkeleton />;
  if (error) return <InlineError message={error} />;
  if (!data) {
    return (
      <EmptyState
        title="Doctor has not run"
        body="Open this screen against a workspace that exists on disk."
        command={`fastpath doctor ${workspace}`}
      />
    );
  }

  const live = data.hookLiveness;

  return (
    <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
      <div>
        <Panel>
          <div className="flex items-center gap-3">
            <BreathingDot tone={data.ready ? 'ok' : 'bad'} />
            <h2 className="text-3xl tracking-tighter text-stone-900">
              {data.ready ? 'Ready' : 'Not ready'}
            </h2>
          </div>
          <p className="mt-2 font-mono text-xs text-stone-500 break-all">{data.workspace}</p>
          <dl className="mt-8 grid grid-cols-2 gap-x-6 gap-y-4 font-mono text-sm">
            <div>
              <dt className="text-[11px] text-stone-500">Embed</dt>
              <dd className="text-stone-900">{data.embedBackend}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-stone-500">Schema</dt>
              <dd className="text-stone-900">{data.schemaVersion}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-stone-500">Files</dt>
              <dd className="tabular-nums text-stone-900">{data.stats.files}</dd>
            </div>
            <div>
              <dt className="text-[11px] text-stone-500">Symbols</dt>
              <dd className="tabular-nums text-stone-900">{data.stats.symbols}</dd>
            </div>
          </dl>
          <div className="mt-8 grid gap-8 md:grid-cols-2">
            <Column title="Issues" items={data.issues} Icon={Warning} tone="text-rose-300" />
            <Column title="Ok" items={data.ok} Icon={CheckCircle} tone="text-emerald-300" />
          </div>
          <div className="mt-8">
            <Column title="Notes" items={data.notes} Icon={Info} tone="text-stone-700" />
          </div>
        </Panel>
        <PanelLabel title="doctor" body="Same payload as fastpath doctor --json. Issues stay raw strings; no severity parser." />
      </div>

      <div>
        <Panel>
          <p className="font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase">
            Hook liveness
          </p>
          <p className="mt-2 text-sm text-stone-600">
            {live.verified ? 'Heartbeat verified' : 'No heartbeat yet'}
          </p>
          <div className="mt-6 space-y-5">
            <LiveGroup title="Fired" items={live.fired} />
            <LiveGroup title="Never" items={live.never} />
            <LiveGroup title="Stale" items={live.stale} />
          </div>
        </Panel>
        <PanelLabel title="Heartbeats" body="Written to ~/.fastpath/heartbeats.json when hooks fire." />
      </div>
    </div>
  );
}

function LiveGroup({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <p className="text-xs tracking-tight text-stone-500">{title}</p>
      {items.length === 0 ? (
        <p className="mt-2 font-mono text-xs text-stone-600">—</p>
      ) : (
        <ul className="mt-2 divide-y divide-stone-200">
          {items.map((h) => (
            <li key={h} className="py-2 font-mono text-xs text-stone-700">
              {h}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
