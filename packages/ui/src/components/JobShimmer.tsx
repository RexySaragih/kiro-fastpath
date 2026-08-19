import { motion } from 'framer-motion';
import { memo } from 'react';

export const JobShimmer = memo(function JobShimmer() {
  return (
    <span className="pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]">
      <motion.span
        aria-hidden
        className="absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-accent/25 to-transparent"
        animate={{ x: ['-120%', '220%'] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: 'linear' }}
      />
    </span>
  );
});
