import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveIndicator } from '../components/LiveIndicator.jsx';
import { LiveProvider } from './live.jsx';

/**
 * A controllable stand-in for the browser's `EventSource`. jsdom has none, and the point of
 * these tests is exactly the transitions a real stream would drive: open, message, error.
 */
class FakeEventSource {
  static instances: FakeEventSource[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string; lastEventId: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  close(): void {
    this.closed = true;
  }

  static get last(): FakeEventSource {
    const source = FakeEventSource.instances.at(-1);
    if (source === undefined) throw new Error('No EventSource was constructed.');
    return source;
  }
}

function renderIndicator(): QueryClient {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <LiveProvider>
        <LiveIndicator />
      </LiveProvider>
    </QueryClientProvider>,
  );
  return queryClient;
}

describe('the live event stream', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('reports connecting before the stream opens', () => {
    renderIndicator();
    expect(screen.getByRole('status')).toHaveTextContent('Connecting');
  });

  it('reports live once the stream opens', async () => {
    renderIndicator();
    act(() => {
      FakeEventSource.last.onopen?.();
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Live'));
  });

  it('invalidates the caches an event affects, and only those', async () => {
    const queryClient = renderIndicator();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    act(() => {
      FakeEventSource.last.onopen?.();
    });

    act(() => {
      FakeEventSource.last.onmessage?.({
        data: JSON.stringify({ event_type: 'lore.update_published' }),
        lastEventId: '42',
      });
    });

    await waitFor(() => expect(invalidate).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey?.[0]);
    expect(keys).toEqual(['lore', 'projects']);
  });

  it('falls back to polling when the stream drops, and says the stream is unavailable', async () => {
    renderIndicator();
    act(() => {
      FakeEventSource.last.onopen?.();
    });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Live'));

    act(() => {
      FakeEventSource.last.onerror?.();
    });

    const status = await screen.findByRole('status');
    await waitFor(() => expect(status).toHaveTextContent('Polling'));
    // The operator is told *why* the view is refreshing on a timer, not left to infer it.
    expect(status).toHaveTextContent(/Event stream unavailable; retried 1 time/);
  });

  it('resumes from the last event it saw, so a reconnect replays no gap', async () => {
    vi.useFakeTimers();
    renderIndicator();
    act(() => {
      FakeEventSource.last.onopen?.();
    });
    act(() => {
      FakeEventSource.last.onmessage?.({
        data: JSON.stringify({ event_type: 'shrine.job_failed' }),
        lastEventId: '512',
      });
    });
    act(() => {
      FakeEventSource.last.onerror?.();
    });

    // The first backoff is two seconds; the reconnect carries the resume point.
    await vi.advanceTimersByTimeAsync(2_100);
    expect(FakeEventSource.last.url).toBe('/api/events/stream?last_event_id=512');
  });

  it('polls without a stream at all, rather than showing a frozen page', async () => {
    // Asserting the label alone was vacuous: it read "Polling" while no timer had been started
    // at all, so the page sat frozen under a badge claiming it was refreshing. The refetch is
    // the thing worth checking.
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined);
    const queryClient = renderIndicator();
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    expect(screen.getByRole('status')).toHaveTextContent('Polling');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_500);
    });
    expect(invalidate).toHaveBeenCalled();
  });
});
