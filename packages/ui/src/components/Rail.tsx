import {
  FirstAid,
  FolderSimple,
  GearSix,
  Pulse,
} from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import type { ScreenId } from '../types';

const ITEMS: Array<{ id: ScreenId; label: string; Icon: typeof GearSix }> = [
  { id: 'setup', label: 'Setup', Icon: GearSix },
  { id: 'repos', label: 'Repos', Icon: FolderSimple },
  { id: 'health', label: 'Health', Icon: FirstAid },
  { id: 'signal', label: 'Signal', Icon: Pulse },
];

export function Rail({
  screen,
  onChange,
  version,
}: {
  screen: ScreenId;
  onChange: (id: ScreenId) => void;
  version: string;
}) {
  return (
    <aside className="flex flex-row items-end gap-2 px-4 py-6 md:flex-col md:items-stretch md:gap-1 md:px-0 md:py-0">
      <p className="hidden font-mono text-[11px] tracking-[0.18em] text-stone-500 uppercase md:mb-8 md:block">
        FastPath
      </p>
      {ITEMS.map(({ id, label, Icon }) => {
        const active = screen === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className="relative flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left text-sm tracking-tight text-stone-600 transition-colors hover:text-stone-900 active:scale-[0.98]"
          >
            {active ? (
              <motion.span
                layoutId="rail-active"
                className="absolute inset-0 rounded-2xl bg-white shadow-sm"
                transition={{ type: 'spring', stiffness: 100, damping: 20 }}
              />
            ) : null}
            <Icon weight="regular" className="relative size-5" />
            <span className="relative hidden md:inline">{label}</span>
          </button>
        );
      })}
      <p className="mt-auto hidden font-mono text-[11px] text-stone-500 md:block">v{version}</p>
    </aside>
  );
}
