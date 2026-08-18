import { motion, useMotionValue, useSpring } from 'framer-motion';
import { useRef, type ReactNode } from 'react';

const SPRING = { type: 'spring' as const, stiffness: 100, damping: 20 };

export function MagneticButton({
  children,
  onClick,
  disabled,
  variant = 'primary',
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost' | 'danger';
  type?: 'button' | 'submit';
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const sx = useSpring(x, { stiffness: 180, damping: 18 });
  const sy = useSpring(y, { stiffness: 180, damping: 18 });

  const tone =
    variant === 'danger'
      ? 'border-rose-300 bg-rose-50 text-rose-800 hover:border-rose-400'
      : variant === 'ghost'
        ? 'border-stone-300 bg-white text-stone-800 hover:border-stone-500'
        : 'border-accent bg-accent text-white hover:brightness-95';

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      style={{ x: sx, y: sy }}
      transition={SPRING}
      whileTap={{ scale: 0.98 }}
      onClick={onClick}
      onPointerMove={(e) => {
        const el = ref.current;
        if (!el || disabled) return;
        const r = el.getBoundingClientRect();
        x.set((e.clientX - r.left - r.width / 2) * 0.28);
        y.set((e.clientY - r.top - r.height / 2) * 0.28);
      }}
      onPointerLeave={() => {
        x.set(0);
        y.set(0);
      }}
      className={`relative inline-flex items-center justify-center gap-2 rounded-full border px-5 py-2.5 text-sm tracking-tight transition-colors disabled:cursor-not-allowed disabled:opacity-40 active:scale-[0.98] ${tone}`}
    >
      {children}
    </motion.button>
  );
}
