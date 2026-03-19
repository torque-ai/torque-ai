import { lazy, Suspense, useState } from 'react';
import TabBar from '../components/TabBar';

const Workflows = lazy(() => import('./Workflows'));
const BatchHistory = lazy(() => import('./BatchHistory'));
const PlanProjects = lazy(() => import('./PlanProjects'));

const TABS = [
  { id: 'workflows', label: 'Workflows' },
  { id: 'batches', label: 'Batches' },
  { id: 'projects', label: 'Projects' },
];

const LOADING_FALLBACK = <div className="p-6 text-slate-400">Loading...</div>;

export default function WorkflowsHub(props) {
  const [tab, setTab] = useState('workflows');

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="heading-lg text-white mb-4">Workflows</h1>
        <TabBar tabs={TABS} defaultTab="workflows" onTabChange={setTab} />
      </div>

      {tab === 'workflows' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Workflows {...props} />
        </Suspense>
      )}

      {tab === 'batches' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <BatchHistory {...props} />
        </Suspense>
      )}

      {tab === 'projects' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <PlanProjects {...props} />
        </Suspense>
      )}
    </div>
  );
}
