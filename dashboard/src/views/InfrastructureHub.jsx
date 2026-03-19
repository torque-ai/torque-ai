import { lazy, Suspense, useState } from 'react';
import TabBar from '../components/TabBar';

const Hosts = lazy(() => import('./Hosts'));
const Models = lazy(() => import('./Models'));

const TABS = [
  { id: 'hosts', label: 'Hosts' },
  { id: 'models', label: 'Models' },
];

const LOADING_FALLBACK = <div className="p-6 text-slate-400">Loading...</div>;

export default function InfrastructureHub(props) {
  const [tab, setTab] = useState('hosts');

  return (
    <div>
      <div className="px-6 pt-6">
        <h1 className="heading-lg text-white mb-4">Infrastructure</h1>
        <TabBar tabs={TABS} defaultTab="hosts" onTabChange={setTab} />
      </div>

      {tab === 'hosts' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Hosts {...props} />
        </Suspense>
      )}

      {tab === 'models' && (
        <Suspense fallback={LOADING_FALLBACK}>
          <Models {...props} />
        </Suspense>
      )}
    </div>
  );
}
