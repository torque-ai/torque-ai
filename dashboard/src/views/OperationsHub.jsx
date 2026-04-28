import { lazy, Suspense, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import TabBar from '../components/TabBar';
import RemoteCoordPanel from '../components/RemoteCoordPanel';

const Strategy = lazy(() => import('./Strategy'));
const Schedules = lazy(() => import('./Schedules'));
const Budget = lazy(() => import('./Budget'));
const Governance = lazy(() => import('./Governance'));
const VersionControl = lazy(() => import('./VersionControl'));
const OperationsPerf = lazy(() => import('./OperationsPerf'));
const CodexBreaker = lazy(() => import('./CodexBreaker'));

const TABS = [
  { id: 'routing', label: 'Routing' },
  { id: 'coordination', label: 'Coordination' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'budget', label: 'Budget' },
  { id: 'governance', label: 'Governance' },
  { id: 'codex', label: 'Codex Breaker' },
  { id: 'version-control', label: 'Version Control' },
  { id: 'perf', label: 'Perf' },
];

const LOADING_FALLBACK = <div className="p-6 text-slate-400">Loading...</div>;

export default function OperationsHub(props) {
  const location = useLocation();
  // Initial tab respects the URL hash so /operations#coordination opens the
  // Coordination tab directly. Mirrors the redirect at App.jsx's
  // `<Route path="coordination" element={<Navigate to="/operations#coordination" />}>`
  const initialTab = (() => {
    const hashId = (location.hash || '').replace(/^#/, '');
    return TABS.some((t) => t.id === hashId) ? hashId : 'routing';
  })();
  const [tab, setTab] = useState(initialTab);

  if (location.hash === '#approvals') {
    return <Navigate to={`/approvals${location.search || ''}`} replace />;
  }

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="heading-lg text-white mb-4">Operations</h1>
        <TabBar tabs={TABS} defaultTab={initialTab} onTabChange={setTab} />
      </div>

      {tab === 'routing' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Strategy {...props} />
        </Suspense>
      )}

      {tab === 'coordination' && (
        <div className="px-6 py-4">
          <RemoteCoordPanel />
        </div>
      )}

      {tab === 'schedules' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Schedules {...props} />
        </Suspense>
      )}

      {tab === 'budget' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Budget {...props} />
        </Suspense>
      )}

      {tab === 'governance' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Governance {...props} />
        </Suspense>
      )}

      {tab === 'codex' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <CodexBreaker {...props} />
        </Suspense>
      )}

      {tab === 'version-control' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <VersionControl {...props} />
        </Suspense>
      )}

      {tab === 'perf' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <OperationsPerf />
        </Suspense>
      )}
    </div>
  );
}
