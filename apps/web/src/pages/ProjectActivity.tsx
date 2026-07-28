import type { SystemEventDto } from '@saga/contracts';
import { useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Badge,
  EmptyState,
  ErrorState,
  LoadingState,
  Panel,
  RelativeTime,
  Table,
  type BadgeTone,
} from '../components/primitives.jsx';
import { useEvents, useProject } from '../lib/queries.js';

const SEVERITY_TONE: Record<string, BadgeTone> = {
  critical: 'bad',
  error: 'bad',
  warning: 'warn',
  info: 'neutral',
};

/** Categories the domains actually emit. `all` keeps the filter honest when a new one appears. */
const CATEGORIES = ['all', 'lore', 'quest', 'party', 'shrine'] as const;
type Category = (typeof CATEGORIES)[number];

/**
 * The Activity tab: this project's slice of `shrine.system_events`.
 *
 * Shrine shows the same log server-wide; here it is filtered to one project so a reader can
 * follow what agents did without operating the server.
 */
export function ProjectActivity() {
  const { projectRef = '' } = useParams();
  const project = useProject(projectRef);
  const [category, setCategory] = useState<Category>('all');

  const projectId = project.data?.project.id;
  const params =
    projectId === undefined
      ? ''
      : `?limit=100&project_id=${projectId}${category === 'all' ? '' : `&category=${category}`}`;
  // Held back until the UUID is known: an ungated query would ask for every project's events.
  const events = useEvents(params, projectId !== undefined);

  // Errors first, pending second. The events query is *disabled* until the project resolves,
  // and a disabled query reports `isPending` forever — so a pending-first guard would swallow
  // a failed project lookup behind a spinner that never clears.
  if (project.isError)
    return <ErrorState error={project.error} onRetry={() => void project.refetch()} />;
  if (events.isError)
    return <ErrorState error={events.error} onRetry={() => void events.refetch()} />;
  if (project.isPending || events.isPending) return <LoadingState label="Loading activity…" />;

  const items = events.data.items;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-semibold text-ink-800 dark:text-parchment-100">
            Activity
          </h2>
          <p className="mt-1 text-sm text-ink-500 dark:text-parchment-300/70">
            Lore publications, Quest checkpoints, Party leases and job outcomes for this project,
            newest first.
          </p>
        </div>

        <div>
          <label className="field-label" htmlFor="activity-category">
            Domain
          </label>
          <select
            id="activity-category"
            className="field-input"
            value={category}
            onChange={(event) => setCategory(event.target.value as Category)}
          >
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Panel title="Project events">
        {items.length === 0 ? (
          <EmptyState
            title="Nothing has happened yet"
            description="Events appear as soon as an agent starts a session, publishes Lore or records a checkpoint."
          />
        ) : (
          <Table headers={['When', 'Severity', 'Event', 'Message']}>
            {items.map((event) => (
              <ActivityRow key={event.id} event={event} />
            ))}
          </Table>
        )}
      </Panel>
    </div>
  );
}

function ActivityRow({ event }: { event: SystemEventDto }) {
  return (
    <tr>
      <td className="table-cell whitespace-nowrap text-ink-500 dark:text-parchment-300/70">
        <RelativeTime value={event.created_at} />
      </td>
      <td className="table-cell">
        <Badge tone={SEVERITY_TONE[event.severity] ?? 'neutral'}>{event.severity}</Badge>
      </td>
      <td className="table-cell font-mono text-xs">{event.event_type}</td>
      <td className="table-cell">{event.message}</td>
    </tr>
  );
}
