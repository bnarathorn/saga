import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AppContext } from '../composition.js';
import { presentSystemEvent } from '../lib/presenters.js';

const HEARTBEAT_MS = 20_000;
const POLL_MS = 1_000;
const REPLAY_LIMIT = 200;

/**
 * Server-Sent Events for Guild Hall (spec 11.4).
 *
 * `shrine.system_events.sequence` is the SSE event id, so a reconnecting browser sends
 * `Last-Event-ID` and receives exactly what it missed — no gap, no duplicate replay of the
 * whole feed.
 *
 * The stream is driven by polling the sequence rather than `LISTEN`/`NOTIFY`: the outbox is
 * already the durable transport (ADR-0004), and polling one indexed `max(sequence)` query is
 * cheap and survives a database failover without a subscription to re-establish.
 */
export function registerEventRoutes(app: FastifyInstance, ctx: AppContext): void {
  let clients = 0;
  ctx.metricsContributors.sseClients = () => clients;

  app.get('/api/events/stream', async (request, reply) => {
    request.requirePermission('shrine:read');

    const query = request.query as { last_event_id?: string; project_id?: string };
    const headerId = request.headers['last-event-id'];
    const rawLastId =
      (typeof headerId === 'string' ? headerId : undefined) ?? query.last_event_id ?? null;

    const projectFilter =
      request.actor.type === 'agent' ? request.actor.projectId : (query.project_id ?? null);

    let cursor = Number.parseInt(rawLastId ?? '', 10);
    if (!Number.isFinite(cursor) || cursor < 0) {
      // No resume point: start from now rather than replaying the whole history.
      cursor = await ctx.repositories.events.latestSequence(ctx.pool);
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Tells nginx not to buffer, alongside `proxy_buffering off` in the site config.
      'x-accel-buffering': 'no',
    });

    clients += 1;
    let closed = false;

    const send = (payload: string): void => {
      if (!closed) reply.raw.write(payload);
    };

    send(`retry: 3000\n`);
    send(`event: ready\ndata: ${JSON.stringify({ from_sequence: cursor })}\n\n`);

    const pump = async (): Promise<void> => {
      if (closed) return;
      try {
        const events = await ctx.repositories.events.since(ctx.pool, cursor, REPLAY_LIMIT);
        for (const event of events) {
          cursor = event.sequence;
          if (
            projectFilter !== null &&
            event.projectId !== null &&
            event.projectId !== projectFilter
          ) {
            continue;
          }
          // The `id:` line is what makes Last-Event-ID resume work.
          send(`id: ${event.sequence}\ndata: ${JSON.stringify(presentSystemEvent(event))}\n\n`);
        }
      } catch (error) {
        request.log.warn({ err: error, operation: 'sse.pump' }, 'event stream query failed');
      }
    };

    const pumpTimer = setInterval(() => void pump(), POLL_MS);
    // A comment frame keeps intermediaries from closing an idle connection.
    const heartbeatTimer = setInterval(() => send(`: heartbeat\n\n`), HEARTBEAT_MS);

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clients -= 1;
      clearInterval(pumpTimer);
      clearInterval(heartbeatTimer);
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
    reply.raw.on('close', cleanup);

    await pump();

    // Hand the socket to the timers: Fastify must not end the response.
    return reply;
  });
}

/** Used by tests to drain an SSE response without hanging. */
export function parseSseFrames(text: string): { id: string | null; data: unknown }[] {
  const frames: { id: string | null; data: unknown }[] = [];
  for (const block of text.split('\n\n')) {
    if (block.trim().length === 0 || block.startsWith(':')) continue;
    let id: string | null = null;
    let data: string | null = null;
    for (const line of block.split('\n')) {
      if (line.startsWith('id: ')) id = line.slice(4);
      else if (line.startsWith('data: ')) data = line.slice(6);
    }
    if (data !== null) {
      try {
        frames.push({ id, data: JSON.parse(data) });
      } catch {
        frames.push({ id, data });
      }
    }
  }
  return frames;
}

export type SseReply = FastifyReply;
