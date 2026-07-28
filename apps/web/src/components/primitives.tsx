import type { HealthState } from '@saga/contracts';
import type { ReactNode } from 'react';
import { ApiError } from '../lib/api.js';

export function classNames(...values: (string | false | null | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export function Panel({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={classNames('panel', className)}>
      {title !== undefined && (
        <header className="panel-header">
          <h2 className="panel-title">{title}</h2>
          {actions !== undefined && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const STATUS_STYLES: Record<HealthState, { dot: string; text: string; label: string }> = {
  healthy: { dot: 'bg-moss-500', text: 'text-moss-600 dark:text-moss-400', label: 'Healthy' },
  degraded: { dot: 'bg-gold-500', text: 'text-gold-600 dark:text-gold-400', label: 'Degraded' },
  unhealthy: { dot: 'bg-rust-500', text: 'text-rust-600 dark:text-rust-400', label: 'Unhealthy' },
  unknown: { dot: 'bg-ink-500', text: 'text-ink-500 dark:text-parchment-300', label: 'Unknown' },
};

/**
 * Status is never communicated by colour alone: every pill carries its own text label and an
 * accessible name.
 */
export function StatusPill({ status, label }: { status: HealthState; label?: string }) {
  const style = STATUS_STYLES[status];
  return (
    <span
      className={classNames(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-semibold',
        'border-current/25',
        style.text,
      )}
      role="status"
    >
      <span aria-hidden="true" className={classNames('h-1.5 w-1.5 rounded-full', style.dot)} />
      {label ?? style.label}
    </span>
  );
}

const BADGE_TONES = {
  neutral:
    'border-parchment-300 bg-parchment-100 text-ink-600 dark:border-night-700 dark:bg-night-800 dark:text-parchment-200',
  info: 'border-sigil-500/30 bg-sigil-500/10 text-sigil-600 dark:text-sigil-300',
  good: 'border-moss-500/30 bg-moss-500/10 text-moss-600 dark:text-moss-400',
  warn: 'border-gold-500/30 bg-gold-500/10 text-gold-600 dark:text-gold-400',
  bad: 'border-rust-500/30 bg-rust-500/10 text-rust-600 dark:text-rust-400',
} as const;

export type BadgeTone = keyof typeof BADGE_TONES;

export function Badge({ tone = 'neutral', children }: { tone?: BadgeTone; children: ReactNode }) {
  return (
    <span
      className={classNames(
        'inline-flex items-center rounded border px-1.5 py-0.5 text-xs font-medium',
        BADGE_TONES[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Metric({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: BadgeTone;
  hint?: string;
}) {
  return (
    <div className="px-4 py-3">
      <div className="metric-label">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span
          className={classNames(
            'metric-value',
            tone === 'bad' && 'text-rust-600 dark:text-rust-400',
            tone === 'warn' && 'text-gold-600 dark:text-gold-400',
          )}
        >
          {value}
        </span>
        {hint !== undefined && (
          <span className="text-xs text-ink-500 dark:text-parchment-300/70">{hint}</span>
        )}
      </div>
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-8 text-sm text-ink-500 dark:text-parchment-300/70"
      role="status"
    >
      <span aria-hidden="true" className="h-3 w-3 animate-pulse rounded-full bg-sigil-400" />
      {label}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="px-4 py-10 text-center">
      <p className="font-display text-lg text-ink-700 dark:text-parchment-200">{title}</p>
      {description !== undefined && (
        <p className="mx-auto mt-2 max-w-prose text-sm text-ink-500 dark:text-parchment-300/70">
          {description}
        </p>
      )}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

/**
 * Renders an API failure as something the operator can act on: what failed, the stable code,
 * and the request id to quote when reading the logs.
 */
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const apiError = error instanceof ApiError ? error : null;
  const message = error instanceof Error ? error.message : 'Something went wrong.';

  return (
    <div className="px-4 py-6" role="alert">
      <p className="font-medium text-rust-600 dark:text-rust-400">{message}</p>
      <dl className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-500 dark:text-parchment-300/70">
        {apiError !== null && (
          <div className="flex gap-1">
            <dt>Code:</dt>
            <dd className="font-mono">{apiError.code}</dd>
          </div>
        )}
        {apiError?.requestId != null && (
          <div className="flex gap-1">
            <dt>Request:</dt>
            <dd className="font-mono">{apiError.requestId}</dd>
          </div>
        )}
      </dl>
      {onRetry !== undefined && (
        <button type="button" className="btn-secondary mt-3" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function RelativeTime({ value }: { value: string | null }) {
  if (value === null) return <span className="text-ink-500 dark:text-parchment-300/60">never</span>;
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  return (
    <time dateTime={value} title={date.toLocaleString()}>
      {formatRelative(seconds)}
    </time>
  );
}

function formatRelative(seconds: number): string {
  const abs = Math.abs(seconds);
  const suffix = seconds >= 0 ? 'ago' : 'from now';
  if (abs < 10) return 'just now';
  if (abs < 60) return `${abs}s ${suffix}`;
  if (abs < 3_600) return `${Math.round(abs / 60)}m ${suffix}`;
  if (abs < 86_400) return `${Math.round(abs / 3_600)}h ${suffix}`;
  return `${Math.round(abs / 86_400)}d ${suffix}`;
}

export function Table({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-parchment-200 dark:border-night-800">
          <tr>
            {headers.map((header) => (
              <th key={header} scope="col" className="table-head">
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-parchment-200/70 dark:divide-night-800/70">
          {children}
        </tbody>
      </table>
    </div>
  );
}
