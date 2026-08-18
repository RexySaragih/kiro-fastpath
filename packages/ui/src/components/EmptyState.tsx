import type { InputHTMLAttributes, ReactNode } from 'react';
import { Check } from '@phosphor-icons/react';

export function EmptyState({
  title,
  body,
  command,
  action,
}: {
  title: string;
  body: string;
  command?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-[2rem] border border-stone-200 bg-white p-8 shadow-[0_20px_40px_-15px_rgba(28,25,23,0.08)]">
      <h3 className="text-xl tracking-tight text-stone-900">{title}</h3>
      <p className="mt-2 max-w-[65ch] text-base leading-relaxed text-stone-600">{body}</p>
      {command ? (
        <p className="mt-4 font-mono text-sm text-accent">{command}</p>
      ) : null}
      {action ? <div className="mt-6">{action}</div> : null}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium tracking-tight text-stone-800">{label}</label>
      {hint ? <p className="text-sm leading-relaxed text-stone-600">{hint}</p> : null}
      {children}
      {error ? <p className="text-sm text-rose-700">{error}</p> : null}
    </div>
  );
}

export function TextInput(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-2xl border border-stone-300 bg-white px-4 py-3 font-mono text-sm text-stone-900 outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20 ${props.className ?? ''}`}
    />
  );
}

export function Panel({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-[2rem] border border-stone-200 bg-white p-8 shadow-[0_20px_40px_-15px_rgba(28,25,23,0.08)] ${className}`}
    >
      {children}
    </div>
  );
}

export function PanelLabel({ title, body }: { title: string; body?: string }) {
  return (
    <div className="mt-3 px-2">
      <p className="text-sm tracking-tight text-stone-800">{title}</p>
      {body ? <p className="mt-1 text-sm leading-relaxed text-stone-600">{body}</p> : null}
    </div>
  );
}

export function InlineError({ message, code }: { message: string; code?: number | null }) {
  return (
    <p className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
      {message}
      {code != null ? <span className="ml-2 font-mono text-xs">exit {code}</span> : null}
    </p>
  );
}

export function StepBadge({ n, done }: { n: number; done?: boolean }) {
  return (
    <span
      className={`inline-flex size-8 shrink-0 items-center justify-center rounded-full font-mono text-sm ${
        done ? 'bg-emerald-700 text-white' : 'bg-stone-900 text-white'
      }`}
    >
      {done ? <Check weight="bold" className="size-4" /> : n}
    </span>
  );
}
