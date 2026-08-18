import { CaretDown, Stop, Terminal } from '@phosphor-icons/react';
import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useRef, useState } from 'react';
import type { ActiveJob } from '../types';
import { BreathingDot } from './BreathingDot';
import { JobShimmer } from './JobShimmer';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

export function JobDock({
  jobs,
  onKill,
}: {
  jobs: ActiveJob[];
  onKill: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const logRef = useRef<HTMLPreElement>(null);
  const running = jobs.find((j) => j.running);
  const latest = running ?? jobs[0];

  useEffect(() => {
    if (running) setOpen(true);
  }, [running]);

  const failed = Boolean(latest && !latest.running && latest.exitCode && latest.exitCode !== 0);
  useEffect(() => {
    if (failed) setOpen(true);
  }, [failed, latest?.id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [latest?.lines.length, open]);

  const tone = !latest
    ? 'idle'
    : latest.running
      ? 'run'
      : latest.exitCode && latest.exitCode !== 0
        ? 'bad'
        : 'ok';

  const label = !latest
    ? 'No jobs'
    : latest.running
      ? `${latest.verb} running`
      : `${latest.verb} exit ${latest.exitCode ?? 0}`;

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <motion.div
        layout
        layoutId="job-dock"
        transition={SPRING}
        className={`pointer-events-auto relative overflow-hidden border border-stone-300 bg-white/90 shadow-[0_20px_40px_-15px_rgba(28,25,23,0.12)] backdrop-blur-xl ${
          open ? 'w-full max-w-3xl rounded-[2rem]' : 'rounded-full'
        }`}
        style={{
          borderWidth: 1,
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.8), 0 20px 40px -15px rgba(28,25,23,0.12)',
        }}
      >
        {latest?.running ? <JobShimmer /> : null}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="relative flex w-full items-center gap-3 px-5 py-3 text-left active:scale-[0.98]"
        >
          <BreathingDot tone={tone} />
          <span className="font-mono text-sm tracking-tight text-stone-900">{label}</span>
          <span className="ml-auto flex items-center gap-2 text-stone-500">
            <Terminal weight="regular" className="size-4" />
            <motion.span animate={{ rotate: open ? 180 : 0 }} transition={SPRING}>
              <CaretDown weight="regular" className="size-4" />
            </motion.span>
          </span>
        </button>
        <AnimatePresence initial={false}>
          {open && latest ? (
            <motion.div
              key={latest.id}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={SPRING}
              className="relative border-t border-stone-200"
            >
              <pre
                ref={logRef}
                className="max-h-56 overflow-auto px-5 py-4 font-mono text-[12px] leading-relaxed text-stone-700"
              >
                {latest.lines.length === 0
                  ? 'waiting for output…'
                  : latest.lines.map((l, i) => (
                      <span
                        key={`${i}-${l.line}`}
                        className={l.stream === 'stderr' ? 'text-rose-400' : ''}
                      >
                        {l.line}
                        {'\n'}
                      </span>
                    ))}
              </pre>
              {latest.running ? (
                <div className="flex justify-end px-5 pb-4">
                  <button
                    type="button"
                    onClick={() => onKill(latest.id)}
                    className="inline-flex items-center gap-1 rounded-full border border-stone-300 px-3 py-1.5 text-xs text-stone-800 active:scale-[0.98]"
                  >
                    <Stop weight="regular" className="size-3.5" />
                    Stop
                  </button>
                </div>
              ) : null}
            </motion.div>
          ) : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
