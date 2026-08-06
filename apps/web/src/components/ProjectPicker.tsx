import { useMatch, useNavigate } from 'react-router-dom';
import { rememberProject } from '../lib/last-project.js';
import { useCan } from '../lib/permissions.jsx';
import { useProjects } from '../lib/queries.js';

/**
 * The project the console is acting on, in the primary navigation.
 *
 * Everything except the Dashboard is per-project, so the picker — not a nav entry per section
 * — is what switches context. Switching from inside a project section stays in that section,
 * so comparing two projects' Quest Boards is one control away rather than four clicks.
 */
export function ProjectPicker() {
  const can = useCan();
  const navigate = useNavigate();
  const match = useMatch('/projects/:projectRef/*');
  // Archived projects stay pickable: their Lore and history are still readable. This list is
  // mounted on every page, so it does not poll — the live stream invalidates `projects`.
  const projects = useProjects('?limit=200', can('project:read'), false);

  if (!can('project:read')) return null;

  // `useMatch` decodes the pathname before matching, so the parameter is already the project's
  // real name. Decoding it again throws URIError on any name containing a percent sign, which
  // in a component this high in the tree would take the whole console down with it.
  const currentRef = match?.params.projectRef ?? '';
  // Only the section survives the switch, never the rest of the path: a Lore key or a Quest id
  // belongs to the project being left, and carrying it over lands on another project's 404.
  const section = (match?.params['*'] ?? '').split('/')[0] ?? '';

  const items = projects.data?.items ?? [];
  // The URL may carry an alias, a rename or a UUID; the picker shows the current name for all
  // three rather than falling back to "no project" on a link that resolves perfectly well.
  const current = items.find(
    (project) =>
      project.name === currentRef ||
      project.id === currentRef ||
      project.aliases.includes(currentRef),
  );
  const active = items.filter((project) => project.status === 'active');
  const archived = items.filter((project) => project.status !== 'active');

  const go = (name: string): void => {
    if (name.length === 0) return;
    rememberProject(name);
    const suffix = section.length === 0 ? '' : `/${section}`;
    navigate(`/projects/${encodeURIComponent(name)}${suffix}`);
  };

  return (
    <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor="project-picker">
        Project
      </label>
      <select
        id="project-picker"
        className="field-input w-52 py-1.5 text-sm"
        value={current?.name ?? ''}
        disabled={projects.isPending}
        onChange={(event) => go(event.target.value)}
      >
        <option value="">
          {projects.isPending
            ? 'Loading projects…'
            : projects.isError
              ? 'Projects unavailable'
              : items.length === 0
                ? 'No projects yet'
                : 'Choose a project…'}
        </option>
        {active.map((project) => (
          <option key={project.id} value={project.name}>
            {project.name}
          </option>
        ))}
        {archived.length > 0 && (
          <optgroup label="Archived">
            {archived.map((project) => (
              <option key={project.id} value={project.name}>
                {project.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
