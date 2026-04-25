import { lazy, Suspense, useState } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import TabBar from '../components/TabBar';

const Strategy = lazy(() => import('./Strategy'));
const Schedules = lazy(() => import('./Schedules'));
// Coordination tab mothballed — repurpose for workstation layer coordination later
// const Coordination = lazy(() => import('./Coordination'));
const Budget = lazy(() => import('./Budget'));
const Governance = lazy(() => import('./Governance'));
const VersionControl = lazy(() => import('./VersionControl'));
const Concurrency = lazy(() => import('./Concurrency'));

const TABS = [
  { id: 'routing', label: 'Routing' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'budget', label: 'Budget' },
  { id: 'concurrency', label: 'Concurrency' },
  { id: 'governance', label: 'Governance' },
  { id: 'version-control', label: 'Version Control' },
];

const LOADING_FALLBACK = <div className="p-6 text-slate-400">Loading...</div>;

export default function OperationsHub(props) {
  const location = useLocation();
  const [tab, setTab] = useState('routing');

  if (location.hash === '#approvals') {
    return <Navigate to={`/approvals${location.search || ''}`} replace />;
  }

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="heading-lg text-white mb-4">Operations</h1>
        <TabBar tabs={TABS} defaultTab="routing" onTabChange={setTab} />
      </div>

      {tab === 'routing' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Strategy {...props} />
        </Suspense>
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

      {tab === 'concurrency' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Concurrency {...props} />
        </Suspense>
      )}

      {tab === 'governance' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Governance {...props} />
        </Suspense>
      )}

      {tab === 'version-control' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <VersionControl {...props} />
        </Suspense>
      )}
    </div>
  );
}
