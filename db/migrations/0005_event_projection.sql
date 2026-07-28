-- Saga 0005 — make the outbox projection into the Shrine feed exactly-once.
--
-- Outbox delivery is at-least-once (ADR-0004): a crash between dispatch and `markPublished`
-- redelivers the event. Without this index that redelivery inserted a *second* human-readable
-- system event, so Shrine and the SSE stream showed the same thing twice. The unique index
-- lets the projection insert with ON CONFLICT DO NOTHING and become genuinely idempotent, and
-- it is also what lets the `event_projection` job re-run safely over an arbitrary window.

-- Any duplicates already recorded by an at-least-once redelivery have to go first, otherwise
-- the index cannot be built. The oldest row of each group is the one readers already saw.
DELETE FROM shrine.system_events e
 WHERE e.metadata ? 'outbox_event_id'
   AND EXISTS (
     SELECT 1
       FROM shrine.system_events keep
      WHERE keep.metadata ->> 'outbox_event_id' = e.metadata ->> 'outbox_event_id'
        AND keep.sequence < e.sequence
   );

CREATE UNIQUE INDEX system_events_outbox_event_uniq
  ON shrine.system_events ((metadata ->> 'outbox_event_id'))
  WHERE metadata ? 'outbox_event_id';
