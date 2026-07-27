import { useLive } from '../lib/live.jsx';
import { RelativeTime, classNames } from './primitives.jsx';

const LABELS = {
  connecting: { text: 'Connecting', dot: 'bg-ink-500' },
  streaming: { text: 'Live', dot: 'bg-moss-500' },
  polling: { text: 'Polling', dot: 'bg-gold-500' },
  offline: { text: 'Offline', dot: 'bg-rust-500' },
} as const;

/**
 * Tells the operator whether what they are looking at is live, refreshed on a timer, or
 * possibly stale — the spec requires all three to be visible, not inferred.
 */
export function LiveIndicator() {
  const live = useLive();
  const label = LABELS[live.mode];
  const reference = live.lastEventAt ?? live.lastRefreshAt;

  const detail =
    live.mode === 'polling' && live.reconnectAttempts > 0
      ? `Event stream unavailable; retried ${live.reconnectAttempts} time${live.reconnectAttempts === 1 ? '' : 's'}. Refreshing on a timer.`
      : live.mode === 'streaming'
        ? 'Receiving live updates from the event stream.'
        : live.mode === 'polling'
          ? 'Refreshing on a timer.'
          : 'Trying to reach the event stream.';

  return (
    <div
      className="flex items-center gap-2 text-xs text-ink-500 dark:text-parchment-300/70"
      role="status"
      aria-live="polite"
      title={detail}
    >
      <span aria-hidden="true" className={classNames('h-1.5 w-1.5 rounded-full', label.dot)} />
      <span className="font-medium">{label.text}</span>
      {reference !== null && (
        <span className="hidden md:inline">
          · updated <RelativeTime value={reference.toISOString()} />
        </span>
      )}
      {live.stale && (
        <span className="font-medium text-gold-600 dark:text-gold-400">· may be stale</span>
      )}
      <span className="sr-only">{detail}</span>
    </div>
  );
}
