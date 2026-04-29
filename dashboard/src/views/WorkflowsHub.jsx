import { lazy, Suspense, useState } from 'react';
import { useLocation } from 'react-router-dom';
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

function resolveInitialTab(hash) {
  const hashId = String(hash || '').replace(/^#/, '');
  return TABS.some((tab) => tab.id === hashId) ? hashId : 'workflows';
}

export default function WorkflowsHub(props) {
  const location = useLocation();
  const initialTab = resolveInitialTab(location.hash);
  const [tab, setTab] = useState(initialTab);
  const [showHelp, setShowHelp] = useState(() => {
    try {
      return localStorage.getItem('torque-workflows-help-dismissed') !== 'true';
    } catch {
      return true;
    }
  });

  const dismissHelp = () => {
    localStorage.setItem('torque-workflows-help-dismissed', 'true');
    setShowHelp(false);
  };

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="heading-lg text-white mb-4">Workflows</h1>
        <TabBar tabs={TABS} defaultTab={initialTab} onTabChange={setTab} />
      </div>

      {showHelp && (
        <div className="rounded-lg border border-blue-500/20 bg-blue-500/5 px-4 py-3 mx-6 mt-4 flex items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <svg
              className="w-5 h-5 text-blue-400 mt-0.5 shrink-0"
              viewBox="0 0 20 20"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Z"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M10 8v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="10" cy="5.75" r="1" fill="currentColor" />
            </svg>
            <p className="text-sm text-slate-400">
              Workflows orchestrate multi-step task pipelines. Each workflow is a DAG where tasks can
              depend on others and receive their outputs. Use the Batches tab for one-shot feature
              builds, or Projects to manage registered codebases.
            </p>
          </div>
          <button
            type="button"
            className="text-slate-500 hover:text-white"
            onClick={dismissHelp}
            aria-label="Dismiss workflow help"
          >
            x
          </button>
        </div>
      )}

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
