import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { ErrorState, LoadingState, Panel } from './components/primitives.jsx';
import { lastProject } from './lib/last-project.js';
import { LiveProvider } from './lib/live.jsx';
import { PermissionProvider } from './lib/permissions.jsx';
import { useMe } from './lib/queries.js';
import { DashboardPage } from './pages/Dashboard.jsx';
import { DevicePage } from './pages/Device.jsx';
import { LoginPage } from './pages/Login.jsx';
import { LorePage } from './pages/Lore.jsx';
import { LoreEntryPage } from './pages/LoreEntry.jsx';
import { ProjectActivity } from './pages/ProjectActivity.jsx';
import { ProjectDetailPage, ProjectOverview } from './pages/ProjectDetail.jsx';
import { ProjectRelations } from './pages/ProjectRelations.jsx';
import { ProjectTokensPage } from './pages/ProjectTokens.jsx';
import { PartyPage } from './pages/Party.jsx';
import { ProjectsPage } from './pages/Projects.jsx';
import { QuestBoardPage } from './pages/QuestBoard.jsx';
import { QuestDetailPage } from './pages/QuestDetail.jsx';
import { ShrinePage } from './pages/Shrine.jsx';

export function App() {
  const me = useMe();
  const location = useLocation();

  if (me.isPending) {
    return (
      <div className="mx-auto max-w-md px-4 py-24">
        <LoadingState label="Contacting the Saga API…" />
      </div>
    );
  }

  if (me.isError) {
    return (
      <div className="mx-auto max-w-xl px-4 py-24">
        <Panel title="Saga is unreachable">
          <ErrorState error={me.error} onRetry={() => void me.refetch()} />
          <p className="px-4 pb-4 text-sm text-ink-600 dark:text-parchment-300/80">
            Guild Hall loaded, but the API did not answer. Static assets are served independently of
            the API process, so this page stays available while the API is down.
          </p>
        </Panel>
      </div>
    );
  }

  const authenticated = me.data?.authenticated === true;

  if (!authenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
      </Routes>
    );
  }

  return (
    <PermissionProvider permissions={me.data?.permissions ?? []}>
      <LiveProvider>
        <Routes>
          <Route path="/login" element={<Navigate to="/" replace />} />
          <Route element={<Layout me={me.data!} />}>
            <Route index element={<DashboardPage />} />
            <Route path="projects" element={<ProjectsPage />} />
            <Route path="projects/:projectRef" element={<ProjectDetailPage />}>
              <Route index element={<ProjectOverview />} />
              <Route path="lore" element={<LorePage />} />
              <Route path="lore/:memoryKey" element={<LoreEntryPage />} />
              <Route path="quests" element={<QuestBoardPage />} />
              <Route path="quests/:questId" element={<QuestDetailPage />} />
              <Route path="party" element={<PartyPage />} />
              <Route path="relations" element={<ProjectRelations />} />
              <Route path="activity" element={<ProjectActivity />} />
              <Route path="tokens" element={<ProjectTokensPage />} />
              {/* Keeps an unknown project sub-path inside the project shell rather than
                  falling through to the top-level catch-all. */}
              <Route path="*" element={<UnknownProjectSection />} />
            </Route>
            {/* Spec 1 puts these at the top level of the console, but each is a per-project
                view. They resolve to the project last opened, or to the picker. */}
            <Route path="lore" element={<ProjectSection section="lore" />} />
            <Route path="quests" element={<ProjectSection section="quests" />} />
            <Route path="party" element={<ProjectSection section="party" />} />
            <Route path="shrine" element={<ShrinePage />} />
            {/* Reached by following the URL `saga connect` prints or opens
                (`verification_uri_complete`), never by browsing, so it has no nav entry. */}
            <Route path="device" element={<DevicePage />} />
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </LiveProvider>
    </PermissionProvider>
  );
}

function NotFound() {
  return (
    <Panel title="Not found">
      <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
        That page does not exist in Guild Hall.
      </div>
    </Panel>
  );
}

/** Sends a top-level section to the last project opened, or to the picker if there is none. */
function ProjectSection({ section }: { section: 'lore' | 'quests' | 'party' }) {
  const ref = lastProject();
  if (ref === null) {
    return (
      <Panel title="Choose a project first">
        <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
          Lore, the Quest Board and Party all belong to a project.{' '}
          <Link className="link" to="/projects">
            Open a project
          </Link>{' '}
          and this entry will take you straight there next time.
        </div>
      </Panel>
    );
  }
  return <Navigate to={`/projects/${encodeURIComponent(ref)}/${section}`} replace />;
}

function UnknownProjectSection() {
  return (
    <Panel title="Not found">
      <div className="px-4 py-8 text-sm text-ink-600 dark:text-parchment-300/80">
        This project has no such section. Pick one of the tabs above.
      </div>
    </Panel>
  );
}
