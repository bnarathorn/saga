import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type LiveMode = 'connecting' | 'streaming' | 'polling' | 'offline';

export interface LiveState {
  mode: LiveMode;
  lastEventAt: Date | null;
  lastRefreshAt: Date | null;
  reconnectAttempts: number;
  /** True when the UI cannot vouch for the freshness of what is on screen. */
  stale: boolean;
}

const LiveContext = createContext<LiveState>({
  mode: 'connecting',
  lastEventAt: null,
  lastRefreshAt: null,
  reconnectAttempts: 0,
  stale: false,
});

const STREAM_URL = '/api/events/stream';
const POLL_FALLBACK_MS = 7_000;
const STALE_AFTER_MS = 30_000;

/**
 * Subscribes to the Shrine event stream and invalidates the affected query caches.
 *
 * If the stream is unavailable — an older server, a proxy that buffers SSE, a dropped
 * connection — the provider degrades to periodic refetching and says so, rather than showing
 * stale data as if it were live.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<LiveMode>('connecting');
  const [lastEventAt, setLastEventAt] = useState<Date | null>(null);
  const [lastRefreshAt, setLastRefreshAt] = useState<Date | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const lastEventId = useRef<string | null>(null);

  const invalidateFor = useCallback(
    (eventType: string) => {
      const domain = eventType.split('.')[0];
      const keys: Record<string, string[]> = {
        core: ['projects'],
        lore: ['lore', 'projects'],
        quest: ['quests', 'projects'],
        party: ['party', 'projects'],
        shrine: ['shrine'],
      };
      for (const key of keys[domain ?? 'shrine'] ?? ['shrine']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
      setLastRefreshAt(new Date());
    },
    [queryClient],
  );

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      setMode('polling');
      return;
    }

    let source: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    let disposed = false;

    const startPolling = () => {
      if (pollTimer !== null) return;
      setMode('polling');
      pollTimer = setInterval(() => {
        void queryClient.invalidateQueries();
        setLastRefreshAt(new Date());
      }, POLL_FALLBACK_MS);
    };

    const stopPolling = () => {
      if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    const connect = () => {
      if (disposed) return;
      const url =
        lastEventId.current === null
          ? STREAM_URL
          : `${STREAM_URL}?last_event_id=${encodeURIComponent(lastEventId.current)}`;
      source = new EventSource(url, { withCredentials: true });

      source.onopen = () => {
        attempts = 0;
        setReconnectAttempts(0);
        stopPolling();
        setMode('streaming');
        setLastRefreshAt(new Date());
      };

      source.onmessage = (event) => {
        if (event.lastEventId.length > 0) lastEventId.current = event.lastEventId;
        setLastEventAt(new Date());
        try {
          const payload = JSON.parse(event.data) as { event_type?: string };
          invalidateFor(payload.event_type ?? 'shrine.unknown');
        } catch {
          // A malformed frame should still nudge the caches rather than break the stream.
          void queryClient.invalidateQueries();
          setLastRefreshAt(new Date());
        }
      };

      source.onerror = () => {
        source?.close();
        source = null;
        if (disposed) return;
        attempts += 1;
        setReconnectAttempts(attempts);
        // Keep the UI usable while the stream is down.
        startPolling();
        const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempts, 5));
        retryTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      disposed = true;
      source?.close();
      stopPolling();
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [invalidateFor, queryClient]);

  const value = useMemo<LiveState>(() => {
    const reference = lastEventAt ?? lastRefreshAt;
    return {
      mode,
      lastEventAt,
      lastRefreshAt,
      reconnectAttempts,
      stale:
        mode === 'offline' ||
        (reference !== null && Date.now() - reference.getTime() > STALE_AFTER_MS && mode !== 'streaming'),
    };
  }, [mode, lastEventAt, lastRefreshAt, reconnectAttempts]);

  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveState {
  return useContext(LiveContext);
}
