import { motion } from 'framer-motion';
import { memo } from 'react';

const TONE: Record<'ok' | 'run' | 'bad' | 'idle', string> = {
  ok: 'bg-emerald-500/80',
  run: 'bg-accent',
  bad: 'bg-rose-500/80',
  idle: 'bg-zinc-500',
};

export const BreathingDot = memo(function BreathingDot({
  tone,
}: {
  tone: 'ok' | 'run' | 'bad' | 'idle';
}) {
  return (
    <motion.span
      aria-hidden
      className={`inline-block size-2 rounded-full ${TONE[tone]}`}
      animate={{ opacity: [0.35, 1, 0.35], scale: [1, 1.2, 1] }}
      transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
    />
  );
});
