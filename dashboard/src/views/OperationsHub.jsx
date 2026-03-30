import { lazy, Suspense, useState } from 'react';
import TabBar from '../components/TabBar';

const Strategy = lazy(() => import('./Strategy'));
const RoutingTemplates = lazy(() => import('./RoutingTemplates'));
const Schedules = lazy(() => import('./Schedules'));
const Approvals = lazy(() => import('./Approvals'));
const Coordination = lazy(() => import('./Coordination'));
const Budget = lazy(() => import('./Budget'));
const Governance = lazy(() => import('./Governance'));

const TABS = [
  { id: 'routing', label: 'Routing' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'coordination', label: 'Coordination' },
  { id: 'budget', label: 'Budget' },
  { id: 'governance', label: 'Governance' },
];

const LOADING_FALLBACK = <div className="p-6 text-slate-400">Loading...</div>;

export default function OperationsHub(props) {
  const [tab, setTab] = useState('routing');

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

      {tab === 'approvals' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Approvals {...props} />
        </Suspense>
      )}

      {tab === 'coordination' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Coordination {...props} />
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
    </div>
  );
}
