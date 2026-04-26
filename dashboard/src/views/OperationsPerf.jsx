import { useState, useEffect } from 'react';

const COUNTER_LABELS = {
  listTasksParsed: 'listTasks (parsed)',
  listTasksRaw: 'listTasks (raw)',
  capabilitySetBuilt: 'Capability Set built',
  pragmaCostBudgets: 'PRAGMA cost_budgets',
  pragmaPackRegistry: 'PRAGMA pack_registry',
};

async function fetchCounters() {
  const res = await fetch('/api/v2/operations/perf');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export default function OperationsPerf() {
  const [state, setState] = useState({ loading: true, error: null, counters: null });

  useEffect(() => {
    let cancelled = false;
    function load() {
      fetchCounters()
        .then(data => {
          if (!cancelled) setState({ loading: false, error: null, counters: data.counters });
        })
        .catch(err => {
          if (!cancelled) setState({ loading: false, error: err.message, counters: null });
        });
    }
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  if (state.loading) return <div>Loading perf counters...</div>;
  if (state.error) return <div>Error: {state.error}</div>;

  return (
    <div style={{ padding: '1rem' }}>
      <h3>Performance Counters</h3>
      <table style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ textAlign: 'left', padding: '4px 8px' }}>Counter</th>
            <th style={{ textAlign: 'right', padding: '4px 8px' }}>Count</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(COUNTER_LABELS).map(([key, label]) => (
            <tr key={key}>
              <td style={{ padding: '4px 8px' }}>{label}</td>
              <td style={{ textAlign: 'right', padding: '4px 8px' }}>
                {state.counters[key] ?? 0}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
