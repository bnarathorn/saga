-- saga:no-transaction
-- Saga 0006 — support the job-latency query behind /api/shrine/metrics-summary.
--
-- Guild Hall polls that endpoint every 5 seconds, and the latency figures group succeeded jobs
-- by `completed_at`. No existing index covers that column (`jobs_state_idx` is keyed on
-- `created_at`), so the aggregate scanned the whole table on every poll — a cost that grows
-- with the job-retention window rather than with the hour actually being reported on.
--
-- CONCURRENTLY, because `shrine.jobs` is the busiest table in the system: a plain CREATE INDEX
-- takes a ShareLock, which blocks every job claim and every enqueue for the duration of the
-- build — and enqueue runs inside domain transactions, so API writes would stall with it.
-- That requires running outside a transaction, hence the directive on line 1.
--
-- IF NOT EXISTS, because a non-transactional migration records its ledger row separately: a
-- crash between the DDL and the ledger insert leaves this migration pending and re-runnable.
-- Note for operators: a CONCURRENTLY build that fails leaves an INVALID index behind, which
-- IF NOT EXISTS will then skip. Check `pg_index.indisvalid` after a failed upgrade and DROP
-- the invalid index before retrying.

CREATE INDEX CONCURRENTLY IF NOT EXISTS jobs_completed_idx
  ON shrine.jobs (completed_at DESC)
  WHERE state = 'succeeded' AND completed_at IS NOT NULL;
