import { AnimatePresence, motion } from 'framer-motion';
import { useCallback, useEffect, useState } from 'react';
import { captureToken, fetchState, killJob, patchJob, postJob, streamJob } from './api';
import { JobDock } from './components/JobDock';
import { Rail } from './components/Rail';
import { ScreenSkeleton } from './components/Skeleton';
import { HealthScreen } from './screens/Health';
import { ReposScreen } from './screens/Repos';
import { SetupScreen } from './screens/Setup';
import { SignalScreen } from './screens/Signal';
import type { ActiveJob, JobSpec, ScreenId, StatePayload } from './types';
import { isEphemeralWorkspace, pickDurableWorkspace } from './workspace';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

const TITLES: Record<ScreenId, { h: string; p: string }> = {
  setup: {
    h: 'After you clone: copy, download, connect.',
    p: 'Four steps. This page talks to FastPath on this machine only.',
  },
  repos: {
    h: 'Repos Kiro can search',
    p: 'Real projects you connected. Temp test folders stay under Ephemeral.',
  },
  health: {
    h: 'Is this repo ready?',
    p: 'Doctor checks the index, hooks, and agents for the selected workspace.',
  },
  signal: {
    h: 'Did FastPath save tokens?',
    p: 'Hit rate and ledger from this machine’s journal.',
  },
};

export function App() {
  const [screen, setScreen] = useState<ScreenId>('setup');
  const [state, setState] = useState<StatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jobs, setJobs] = useState<ActiveJob[]>([]);
  const [workspace, setWorkspace] = useState('');

  const refresh = useCallback(async () => {
    const next = await fetchState();
    setState(next);
    setWorkspace((current) => {
      if (current && !isEphemeralWorkspace(current)) return current;
      return pickDurableWorkspace(next);
    });
  }, []);

  useEffect(() => {
    captureToken();
    refresh().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    );
  }, [refresh]);

  const runJob = useCallback(async (spec: JobSpec): Promise<number | null> => {
    const { jobId } = await postJob(spec);
    const job: ActiveJob = {
      id: jobId,
      verb: spec.verb,
      workspace: spec.workspace,
      running: true,
      lines: [],
      exitCode: null,
    };
    setJobs((prev) => [job, ...prev].slice(0, 8));
    return new Promise((resolve, reject) => {
      streamJob(
        jobId,
        (line) => {
          setJobs((prev) =>
            prev.map((j) =>
              j.id === jobId ? { ...j, lines: [...j.lines, line].slice(-400) } : j,
            ),
          );
        },
        (code) => {
          setJobs((prev) => patchJob(prev, jobId, { running: false, exitCode: code }));
          resolve(code);
        },
      ).catch(reject);
    });
  }, []);

  const onKill = useCallback(async (id: string) => {
    await killJob(id);
  }, []);

  return (
    <div className="relative min-h-[100dvh] bg-canvas text-stone-900">
      <div className="grain" />
      <div className="mx-auto grid min-h-[100dvh] max-w-[1400px] grid-cols-1 gap-8 px-4 py-8 pb-28 md:grid-cols-[11rem_1fr] md:px-8">
        <Rail
          screen={screen}
          onChange={setScreen}
          version={state?.version ?? '—'}
        />
        <main>
          <header className="mb-10 max-w-[40rem]">
            <h1 className="text-4xl tracking-tighter text-stone-900 md:text-5xl">
              {TITLES[screen].h}
            </h1>
            <p className="mt-3 max-w-[65ch] text-base leading-relaxed text-stone-600">
              {TITLES[screen].p}
            </p>
          </header>
          {error ? (
            <p className="mb-6 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
              {error}
            </p>
          ) : null}
          {!state ? (
            <ScreenSkeleton />
          ) : (
            <AnimatePresence mode="wait">
              <motion.div
                key={screen}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={SPRING}
              >
                {screen === 'setup' ? (
                  <SetupScreen state={state} onRun={runJob} onRefresh={refresh} />
                ) : null}
                {screen === 'repos' ? (
                  <ReposScreen
                    state={state}
                    jobs={jobs}
                    onRun={runJob}
                    onRefresh={refresh}
                    onSelect={setWorkspace}
                  />
                ) : null}
                {screen === 'health' ? (
                  <HealthScreen workspace={workspace || state.home} />
                ) : null}
                {screen === 'signal' ? (
                  <SignalScreen workspace={workspace || state.home} />
                ) : null}
              </motion.div>
            </AnimatePresence>
          )}
        </main>
      </div>
      <JobDock jobs={jobs} onKill={onKill} />
    </div>
  );
}
