import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { assets as assetsApi } from '../api';

function decodeRouteKey(rawKey) {
  if (!rawKey) return '';
  try {
    return decodeURIComponent(rawKey);
  } catch {
    return rawKey;
  }
}

function formatValue(value) {
  if (value === undefined || value === null || value === '') return '-';
  return String(value);
}

function StatusPill({ healthy }) {
  if (healthy === undefined || healthy === null) return null;

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${
        healthy
          ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
          : 'border-red-500/30 bg-red-500/10 text-red-300'
      }`}
    >
      {healthy ? 'Healthy' : 'Unhealthy'}
    </span>
  );
}

function LineageList({ title, items }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">{title}</h2>
      {items.length > 0 ? (
        <div className="space-y-2">
          {items.map((assetKey) => (
            <Link
              key={assetKey}
              to={`/assets/${encodeURIComponent(assetKey)}`}
              className="block truncate rounded border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-blue-300 hover:border-blue-500/40 hover:text-blue-200"
              title={assetKey}
            >
              {assetKey}
            </Link>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">None</p>
      )}
    </section>
  );
}

function ChecksTable({ checks }) {
  const rows = Object.entries(checks || {});

  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">Checks</h2>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-2 py-2 text-left">Name</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2 text-left">Severity</th>
                <th className="px-2 py-2 text-left">Checked</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([name, check]) => (
                <tr key={name} className="border-t border-slate-800">
                  <td className="px-2 py-2 font-mono text-xs text-slate-200">{name}</td>
                  <td className={check.passed ? 'px-2 py-2 text-emerald-300' : 'px-2 py-2 text-red-300'}>
                    {check.passed ? 'Passed' : 'Failed'}
                  </td>
                  <td className="px-2 py-2 text-slate-300">{formatValue(check.severity)}</td>
                  <td className="px-2 py-2 text-xs text-slate-500">{formatValue(check.checked_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">None</p>
      )}
    </section>
  );
}

function MaterializationsTable({ materializations }) {
  return (
    <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h2 className="mb-3 text-sm font-semibold text-slate-200">Materializations</h2>
      {materializations.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500">
              <tr>
                <th className="px-2 py-2 text-left">Produced</th>
                <th className="px-2 py-2 text-left">Task</th>
                <th className="px-2 py-2 text-left">Workflow</th>
                <th className="px-2 py-2 text-left">Hash</th>
              </tr>
            </thead>
            <tbody>
              {materializations.map((mat) => (
                <tr key={mat.materialization_id} className="border-t border-slate-800">
                  <td className="px-2 py-2 text-xs text-slate-500">{formatValue(mat.produced_at)}</td>
                  <td className="px-2 py-2 font-mono text-xs text-slate-300">{formatValue(mat.task_id)}</td>
                  <td className="px-2 py-2 font-mono text-xs text-slate-300">{formatValue(mat.workflow_id)}</td>
                  <td className="px-2 py-2 font-mono text-xs text-slate-400">{formatValue(mat.content_hash)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-sm text-slate-500">None</p>
      )}
    </section>
  );
}

function AssetDetail({ assetKey }) {
  const [detail, setDetail] = useState(null);
  const [materializations, setMaterializations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    Promise.all([
      assetsApi.get(assetKey, { signal: controller.signal }),
      assetsApi.materializations(assetKey, { signal: controller.signal }),
    ])
      .then(([assetDetail, mats]) => {
        if (!controller.signal.aborted) {
          setDetail(assetDetail);
          setMaterializations(mats);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err?.message || 'Failed to load asset');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [assetKey]);

  if (loading) {
    return <div className="p-6 text-slate-400">Loading...</div>;
  }

  if (error) {
    return (
      <div className="p-6">
        <Link to="/assets" className="text-sm text-blue-300 hover:text-blue-200">Back to Assets</Link>
        <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      </div>
    );
  }

  const asset = detail?.asset || {};
  const latest = detail?.latest_materialization || {};

  return (
    <div className="p-6">
      <div className="mb-6 flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="min-w-0">
          <Link to="/assets" className="text-sm text-blue-300 hover:text-blue-200">Assets</Link>
          <h1 className="mt-2 break-all font-mono text-2xl font-semibold text-white">{assetKey}</h1>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <StatusPill healthy={detail?.healthy} />
            <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
              {formatValue(asset.kind)}
            </span>
            {asset.partition_key && (
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">
                {asset.partition_key}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Registered</h2>
          <p className="text-sm text-slate-400">{formatValue(asset.registered_at)}</p>
        </section>
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Latest Task</h2>
          <p className="font-mono text-sm text-slate-400">{formatValue(latest.task_id)}</p>
        </section>
        <section className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
          <h2 className="mb-2 text-sm font-semibold text-slate-200">Latest Produced</h2>
          <p className="text-sm text-slate-400">{formatValue(latest.produced_at)}</p>
        </section>
      </div>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <LineageList title="Upstream" items={detail?.upstream || []} />
        <LineageList title="Downstream" items={detail?.downstream || []} />
      </div>

      <div className="space-y-6">
        <ChecksTable checks={detail?.checks || {}} />
        <MaterializationsTable materializations={materializations} />
      </div>
    </div>
  );
}

export default function AssetGraph() {
  const params = useParams();
  const selectedKey = decodeRouteKey(params.key);
  const [assetRows, setAssetRows] = useState([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    assetsApi.list({ signal: controller.signal })
      .then((rows) => {
        if (!controller.signal.aborted) {
          setAssetRows(rows);
          setError(null);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err?.message || 'Failed to load assets');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, []);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return assetRows;
    return assetRows.filter((asset) => String(asset.asset_key || '').toLowerCase().includes(query));
  }, [assetRows, filter]);

  if (selectedKey) {
    return <AssetDetail assetKey={selectedKey} />;
  }

  return (
    <div className="p-6">
      <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="heading-lg text-white">Assets</h1>
          <p className="mt-1 text-sm text-slate-500">{assetRows.length} registered</p>
        </div>
        <input
          type="search"
          placeholder="Filter by asset_key"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
          {error}
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-900/60">
        <table className="w-full text-sm">
          <thead className="border-b border-slate-800 bg-slate-950 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-3 py-3 text-left">Key</th>
              <th className="px-3 py-3 text-left">Kind</th>
              <th className="px-3 py-3 text-left">Partition</th>
              <th className="px-3 py-3 text-left">Registered</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500">Loading...</td>
              </tr>
            ) : filtered.length > 0 ? (
              filtered.map((asset) => (
                <tr key={asset.asset_key} className="border-t border-slate-800 first:border-t-0">
                  <td className="max-w-[28rem] px-3 py-2">
                    <Link
                      to={`/assets/${encodeURIComponent(asset.asset_key)}`}
                      className="block truncate font-mono text-xs text-blue-300 hover:text-blue-200"
                      title={asset.asset_key}
                    >
                      {asset.asset_key}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-slate-300">{formatValue(asset.kind)}</td>
                  <td className="px-3 py-2 text-slate-300">{formatValue(asset.partition_key)}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{formatValue(asset.registered_at)}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-slate-500">No assets found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
