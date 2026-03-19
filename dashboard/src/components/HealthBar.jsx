import { useEffect, useMemo, useState } from 'react';
import { request } from '../api';

function normalizeQuotaEntries(raw) {
  if (!raw || typeof raw !== 'object') return [];

  return Object.entries(raw)
    .map(([provider, quota]) => ({
      provider,
      ...(quota && typeof quota === 'object' ? quota : {}),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

function isQuotaExhausted(quota) {
  return Object.values(quota?.limits || {}).some((limit) => Number(limit?.remaining) <= 0);
}

function isQuotaOnCooldown(quota) {
  if (!quota?.cooldownUntil) return false;

  const cooldownUntil = new Date(quota.cooldownUntil).getTime();
  return Number.isFinite(cooldownUntil) && cooldownUntil > Date.now();
}

function getQuotaTone(quota) {
  const status = String(quota?.status || '').toLowerCase();

  if (status === 'red' || isQuotaExhausted(quota) || isQuotaOnCooldown(quota)) return 'red';
  if (status === 'yellow') return 'yellow';
  return 'green';
}

function getRunningTaskCount(raw) {
  if (Array.isArray(raw?.tasks)) return raw.tasks.length;

  const total = Number(raw?.pagination?.total);
  return Number.isFinite(total) ? total : 0;
}

function Section({ label, value, title }) {
  return (
    <div className="flex items-center gap-2" title={title}>
      <span>{label}:</span>
      <span className="font-medium tabular-nums text-slate-200">{value}</span>
    </div>
  );
}

export default function HealthBar() {
  const [quotas, setQuotas] = useState([]);
  const [runningCount, setRunningCount] = useState(0);

  useEffect(() => {
    let active = true;

    async function refresh() {
      const [quotaData, runningTasks] = await Promise.all([
        request('/provider-quotas').catch(() => null),
        request('/tasks?status=running').catch(() => null),
      ]);

      if (!active) return;
      setQuotas(normalizeQuotaEntries(quotaData));
      setRunningCount(getRunningTaskCount(runningTasks));
    }

    refresh();
    const intervalId = window.setInterval(refresh, 30000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const providerSummary = useMemo(() => {
    const greenCount = quotas.filter((quota) => getQuotaTone(quota) === 'green').length;
    return `${greenCount}/${quotas.length}`;
  }, [quotas]);

  return (
    <div className="glass-card mb-4 flex flex-wrap items-center gap-6 p-3 text-xs text-slate-400">
      <Section
        label="Providers"
        value={providerSummary}
        title={`Providers: ${providerSummary} green`}
      />
      <Section
        label="Hosts"
        value="—"
        title="Hosts: placeholder"
      />
      <Section
        label="Queue"
        value={String(runningCount)}
        title={`Queue: ${runningCount} running`}
      />
      <Section
        label="Budget"
        value="—"
        title="Budget: placeholder"
      />
    </div>
  );
}
