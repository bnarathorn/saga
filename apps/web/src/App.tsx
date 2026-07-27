import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout.jsx';
import { ErrorState, LoadingState, Panel } from './components/primitives.jsx';
import { LiveProvider } from './lib/live.jsx';
import { useMe } from './lib/queries.js';
import { DashboardPage } from './pages/Dashboard.jsx';
import { LoginPage } from './pages/Login.jsx';
import { LorePage } from './pages/Lore.jsx';
import { LoreEntryPage } from './pages/LoreEntry.jsx';
import { ProjectDetailPage, ProjectOverview } from './pages/ProjectDetail.jsx';
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
            Guild Hall loaded, but the API did not answer. Static assets are served independently
            of the API process, so this page stays available while the API is down.
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
          </Route>
          <Route path="shrine" element={<ShrinePage />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </LiveProvider>
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
