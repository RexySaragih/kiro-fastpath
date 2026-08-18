export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={`animate-pulse rounded-2xl bg-stone-200/80 ${className}`}
    />
  );
}

export function ScreenSkeleton() {
  return (
    <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
      <div className="space-y-4">
        <Skeleton className="h-40 w-full rounded-[2.5rem]" />
        <Skeleton className="h-24 w-full rounded-[2.5rem]" />
        <Skeleton className="h-24 w-3/4 rounded-[2.5rem]" />
      </div>
      <div className="space-y-4">
        <Skeleton className="h-28 w-full rounded-[2.5rem]" />
        <Skeleton className="h-52 w-full rounded-[2.5rem]" />
      </div>
    </div>
  );
}
