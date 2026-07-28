import type { Queryable } from '@saga/database';

export type ServiceRole = 'api' | 'worker' | 'scheduler';
export type ServiceState = 'starting' | 'running' | 'draining' | 'stopped';

export interface ServiceInstance {
  id: string;
  role: ServiceRole;
  instanceKey: string;
  version: string;
  hostname: string | null;
  processId: number | null;
  state: ServiceState;
  startedAt: Date;
  heartbeatAt: Date;
  leaseExpiresAt: Date;
  metadata: Record<string, unknown>;
}

interface Row {
  id: string;
  role: string;
  instance_key: string;
  version: string;
  hostname: string | null;
  process_id: number | null;
  state: string;
  started_at: Date;
  heartbeat_at: Date;
  lease_expires_at: Date;
  metadata: Record<string, unknown>;
}

const COLUMNS = `id, role, instance_key, version, hostname, process_id, state,
                 started_at, heartbeat_at, lease_expires_at, metadata`;

function toInstance(row: Row): ServiceInstance {
  return {
    id: row.id,
    role: row.role as ServiceRole,
    instanceKey: row.instance_key,
    version: row.version,
    hostname: row.hostname,
    processId: row.process_id,
    state: row.state as ServiceState,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
    metadata: row.metadata,
  };
}

export interface ServiceInstanceRepository {
  heartbeat(
    q: Queryable,
    input: {
      role: ServiceRole;
      instanceKey: string;
      version: string;
      hostname: string | null;
      processId: number | null;
      state: ServiceState;
      leaseSeconds: number;
      metadata: Record<string, unknown>;
    },
  ): Promise<ServiceInstance>;
  markStopped(q: Queryable, role: ServiceRole, instanceKey: string): Promise<void>;
  list(q: Queryable): Promise<ServiceInstance[]>;
  countLive(q: Queryable): Promise<Record<ServiceRole, number>>;
  /**
   * Seconds since the most recent heartbeat of each role, or null when no instance of that
   * role has ever registered. A rising worker age is the signal that job processing stalled
   * even while the row still claims `running`.
   */
  heartbeatAges(q: Queryable): Promise<Record<ServiceRole, number | null>>;
  deleteStaleBefore(q: Queryable, before: Date): Promise<number>;
}

export class PgServiceInstanceRepository implements ServiceInstanceRepository {
  /**
   * Register-or-renew in one statement. Heartbeats are idempotent by design: a process may
   * call this on every tick and only timestamps move.
   */
  async heartbeat(
    q: Queryable,
    input: {
      role: ServiceRole;
      instanceKey: string;
      version: string;
      hostname: string | null;
      processId: number | null;
      state: ServiceState;
      leaseSeconds: number;
      metadata: Record<string, unknown>;
    },
  ): Promise<ServiceInstance> {
    const result = await q.query<Row>(
      `INSERT INTO shrine.service_instances
         (role, instance_key, version, hostname, process_id, state, heartbeat_at,
          lease_expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, now(),
               now() + make_interval(secs => $7::double precision), $8::jsonb)
       ON CONFLICT (role, instance_key) DO UPDATE
         SET version = EXCLUDED.version,
             hostname = EXCLUDED.hostname,
             process_id = EXCLUDED.process_id,
             state = EXCLUDED.state,
             heartbeat_at = now(),
             lease_expires_at = EXCLUDED.lease_expires_at,
             metadata = EXCLUDED.metadata
       RETURNING ${COLUMNS}`,
      [
        input.role,
        input.instanceKey,
        input.version,
        input.hostname,
        input.processId,
        input.state,
        input.leaseSeconds,
        JSON.stringify(input.metadata),
      ],
    );
    return toInstance(result.rows[0]!);
  }

  async markStopped(q: Queryable, role: ServiceRole, instanceKey: string): Promise<void> {
    await q.query(
      `UPDATE shrine.service_instances
          SET state = 'stopped', lease_expires_at = now(), heartbeat_at = now()
        WHERE role = $1 AND instance_key = $2`,
      [role, instanceKey],
    );
  }

  async list(q: Queryable): Promise<ServiceInstance[]> {
    const result = await q.query<Row>(
      `SELECT ${COLUMNS} FROM shrine.service_instances ORDER BY role, instance_key`,
    );
    return result.rows.map(toInstance);
  }

  /** Liveness is derived from the lease, never from the stored `state` column. */
  async countLive(q: Queryable): Promise<Record<ServiceRole, number>> {
    const result = await q.query<{ role: string; count: string }>(
      `SELECT role, count(*)::text AS count FROM shrine.service_instances
        WHERE lease_expires_at > now() GROUP BY role`,
    );
    const counts: Record<ServiceRole, number> = { api: 0, worker: 0, scheduler: 0 };
    for (const row of result.rows) counts[row.role as ServiceRole] = Number(row.count);
    return counts;
  }

  async heartbeatAges(q: Queryable): Promise<Record<ServiceRole, number | null>> {
    const result = await q.query<{ role: string; age: string | null }>(
      `SELECT role, extract(epoch FROM now() - max(heartbeat_at))::text AS age
         FROM shrine.service_instances GROUP BY role`,
    );
    const ages: Record<ServiceRole, number | null> = { api: null, worker: null, scheduler: null };
    for (const row of result.rows) {
      ages[row.role as ServiceRole] = row.age === null ? null : Number(row.age);
    }
    return ages;
  }

  async deleteStaleBefore(q: Queryable, before: Date): Promise<number> {
    const result = await q.query(
      `DELETE FROM shrine.service_instances WHERE lease_expires_at < $1`,
      [before],
    );
    return result.rowCount ?? 0;
  }
}
