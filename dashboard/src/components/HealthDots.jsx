import { useEffect, useMemo, useState } from 'react';
import { request } from '../api';

const TONE_CLASSES = {
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  red: 'bg-red-500',
};

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

function getProvidersTone(quotas) {
  if (quotas.some((quota) => getQuotaTone(quota) === 'red')) return 'red';
  if (quotas.some((quota) => getQuotaTone(quota) === 'yellow')) return 'yellow';
  return 'green';
}

export default function HealthDots() {
  const [quotas, setQuotas] = useState([]);

  useEffect(() => {
    let active = true;

    async function refresh() {
      const quotaData = await request('/provider-quotas').catch(() => null);
      if (!active) return;
      setQuotas(normalizeQuotaEntries(quotaData));
    }

    refresh();
    const intervalId = window.setInterval(refresh, 30000);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, []);

  const providersTone = useMemo(() => getProvidersTone(quotas), [quotas]);
  const healthyProviders = useMemo(
    () => quotas.filter((quota) => getQuotaTone(quota) === 'green').length,
    [quotas]
  );

  return (
    <div className="flex items-center gap-2 px-4 py-3">
      <span
        title={`Providers: ${healthyProviders}/${quotas.length} healthy`}
        className={`h-2.5 w-2.5 rounded-full ${TONE_CLASSES[providersTone]}`}
      />
      <span
        title="Hosts: placeholder"
        className="h-2.5 w-2.5 rounded-full bg-green-500"
      />
      <span
        title="Budget: placeholder"
        className="h-2.5 w-2.5 rounded-full bg-green-500"
      />
    </div>
  );
}
