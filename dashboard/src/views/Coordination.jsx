import { useState, useEffect, useCallback, useMemo } from 'react';
import { coordination as coordinationApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';
import LoadingSkeleton from '../components/LoadingSkeleton';
import { RemoteCoordPanel } from '../components/RemoteCoordPanel';

const PAGE_LIMIT = 25;

function AgentStatusBadge({ status }) {
  const colors = {
    active: 'bg-green-500/20 text-green-400',
    idle: 'bg-slate-500/20 text-slate-400',
    offline: 'bg-red-500/20 text-red-400',
  };
  const cls = colors[status] || colors.idle;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${cls}`}>
      {status || 'unknown'}
    </span>
  );
}

function SortHeader({ column, label, sortCol, sortDir, onSort }) {
  const active = sortCol === column;
  return (
    <th
      scope="col"
      className="text-left p-4 heading-sm cursor-pointer select-none hover:text-white transition-colors group"
      onClick={() => onSort(column)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(column);
        }
      }}
      tabIndex={0}
      role="columnheader"
      aria-sort={active ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className={`text-[10px] ${active ? 'text-blue-400' : 'text-slate-600 opacity-0 group-hover:opacity-100'} transition-opacity`}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '▲'}
        </span>
      </span>
    </th>
  );
}

function Pagination({ page, totalPages, total, onPage }) {
  return (
    <div className="flex items-center justify-between mt-4">
      <p className="text-slate-500 text-sm">
        Page {page} of {totalPages} ({total} total)
      </p>
      <div className="flex gap-2">
        <button
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
        >
          Previous
        </button>
        <button
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
          className="px-4 py-2 bg-slate-800 text-white text-sm rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-slate-700 transition-colors"
        >
          Next
        </button>
      </div>
    </div>
  );
}

function sortItems(items, col, dir) {
  if (!col) return items;
  return [...items].sort((a, b) => {
    const av = String(a[col] ?? '');
    const bv = String(b[col] ?? '');
    const cmp = av.localeCompare(bv, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

function paginate(items, page) {
  const start = (page - 1) * PAGE_LIMIT;
  return items.slice(start, start + PAGE_LIMIT);
}

export default function Coordination() {
  const [dashboard, setDashboard] = useState(null);
  const [agents, setAgents] = useState([]);
  const [rules, setRules] = useState([]);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('agents');

  // Per-tab sort state
  const [agentSort, setAgentSort] = useState({ col: 'name', dir: 'asc' });
  const [rulesSort, setRulesSort] = useState({ col: 'priority', dir: 'asc' });
  const [claimsSort, setClaimsSort] = useState({ col: 'task_id', dir: 'asc' });

  // Per-tab page state
  const [agentPage, setAgentPage] = useState(1);
  const [rulesPage, setRulesPage] = useState(1);
  const [claimsPage, setClaimsPage] = useState(1);

  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      const [dashData, agentsData, rulesData, claimsData] = await Promise.all([
        coordinationApi.getDashboard(24),
        coordinationApi.listAgents(),
        coordinationApi.listRules(),
        coordinationApi.listClaims(),
      ]);
      setDashboard(dashData);
      const agentsList = Array.isArray(agentsData) ? agentsData : (agentsData?.agents || agentsData?.data || []);
      const rulesList = Array.isArray(rulesData) ? rulesData : (rulesData?.rules || rulesData?.data || []);
      const claimsList = Array.isArray(claimsData) ? claimsData : (claimsData?.claims || claimsData?.data || []);
      setAgents(agentsList);
      setRules(rulesList);
      setClaims(claimsList);
    } catch (err) {
      console.error('Failed to load coordination data:', err);
      toast.error('Failed to load coordination data');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    const interval = setInterval(() => {
      if (document.hidden) return;
      loadData();
    }, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  function makeSort(setter) {
    return (col) => setter(prev => ({
      col,
      dir: prev.col === col ? (prev.dir === 'asc' ? 'desc' : 'asc') : 'asc',
    }));
  }

  const sortedAgents = useMemo(() => sortItems(agents, agentSort.col, agentSort.dir), [agents, agentSort]);
  const sortedRules = useMemo(() => sortItems(rules, rulesSort.col, rulesSort.dir), [rules, rulesSort]);
  const sortedClaims = useMemo(() => sortItems(claims, claimsSort.col, claimsSort.dir), [claims, claimsSort]);

  const pagedAgents = useMemo(() => paginate(sortedAgents, agentPage), [sortedAgents, agentPage]);
  const pagedRules = useMemo(() => paginate(sortedRules, rulesPage), [sortedRules, rulesPage]);
  const pagedClaims = useMemo(() => paginate(sortedClaims, claimsPage), [sortedClaims, claimsPage]);

  const agentTotalPages = Math.max(1, Math.ceil(agents.length / PAGE_LIMIT));
  const rulesTotalPages = Math.max(1, Math.ceil(rules.length / PAGE_LIMIT));
  const claimsTotalPages = Math.max(1, Math.ceil(claims.length / PAGE_LIMIT));

  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const tasksClaimed = dashboard?.tasks_claimed_24h ?? null;
  const failovers = dashboard?.failovers_24h ?? 0;

  if (loading) {
    return (
      <div className="p-6">
        <LoadingSkeleton lines={5} />
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="mb-4">
        <RemoteCoordPanel />
      </div>
      <div className="mb-6">
        <h2 className="heading-lg text-white">Coordination</h2>
        <p className="text-slate-400 text-sm mt-1">Multi-agent coordination, routing rules, and active claims</p>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        <StatCard label="Active Agents" value={activeAgents} gradient="green" />
        <StatCard label="Tasks Claimed (24h)" value={tasksClaimed ?? 'N/A'} gradient="blue" />
        <StatCard label="Failovers (24h)" value={failovers} gradient="orange" />
        <StatCard label="Routing Rules" value={rules.length} gradient="purple" />
      </div>

      {/* Tabs */}
      <div className="flex gap-2 mb-4 border-b border-slate-700/50">
        {['agents', 'rules', 'claims'].map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px capitalize ${
              activeTab === tab
                ? 'border-blue-500 text-blue-400'
                : 'border-transparent text-slate-400 hover:text-white'
            }`}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Agents table */}
      {activeTab === 'agents' && (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <SortHeader column="name" label="Name" sortCol={agentSort.col} sortDir={agentSort.dir} onSort={makeSort(setAgentSort)} />
                  <SortHeader column="status" label="Status" sortCol={agentSort.col} sortDir={agentSort.dir} onSort={makeSort(setAgentSort)} />
                  <th scope="col" className="text-left p-4 heading-sm">Last Heartbeat</th>
                  <SortHeader column="capabilities" label="Capabilities" sortCol={agentSort.col} sortDir={agentSort.dir} onSort={makeSort(setAgentSort)} />
                </tr>
              </thead>
              <tbody>
                {pagedAgents.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-slate-500">
                      No agents registered
                    </td>
                  </tr>
                ) : (
                  pagedAgents.map((agent) => (
                    <tr
                      key={agent.id || agent.name}
                      className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="p-4">
                        <p className="text-white text-sm font-medium">{agent.name || agent.id || '-'}</p>
                        {agent.id && agent.name && (
                          <p className="text-slate-500 text-xs mt-0.5 font-mono">{String(agent.id).substring(0, 8)}</p>
                        )}
                      </td>
                      <td className="p-4">
                        <AgentStatusBadge status={agent.status} />
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {formatDate(agent.last_heartbeat || agent.last_seen)}
                      </td>
                      <td className="p-4">
                        {agent.capabilities ? (
                          <div className="flex flex-wrap gap-1">
                            {(Array.isArray(agent.capabilities)
                              ? agent.capabilities
                              : String(agent.capabilities).split(',')
                            ).map((cap, i) => (
                              <span
                                key={i}
                                className="px-2 py-0.5 bg-blue-600/10 text-blue-300 text-xs rounded border border-blue-600/20"
                              >
                                {String(cap).trim()}
                              </span>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-500 text-sm">-</span>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {agents.length > PAGE_LIMIT && (
            <Pagination page={agentPage} totalPages={agentTotalPages} total={agents.length} onPage={setAgentPage} />
          )}
        </>
      )}

      {/* Routing rules table */}
      {activeTab === 'rules' && (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <SortHeader column="pattern" label="Pattern" sortCol={rulesSort.col} sortDir={rulesSort.dir} onSort={makeSort(setRulesSort)} />
                  <SortHeader column="target_provider" label="Target Provider" sortCol={rulesSort.col} sortDir={rulesSort.dir} onSort={makeSort(setRulesSort)} />
                  <SortHeader column="priority" label="Priority" sortCol={rulesSort.col} sortDir={rulesSort.dir} onSort={makeSort(setRulesSort)} />
                  <SortHeader column="enabled" label="Enabled" sortCol={rulesSort.col} sortDir={rulesSort.dir} onSort={makeSort(setRulesSort)} />
                </tr>
              </thead>
              <tbody>
                {pagedRules.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-slate-500">
                      No routing rules configured
                    </td>
                  </tr>
                ) : (
                  pagedRules.map((rule, i) => (
                    <tr
                      key={rule.id || i}
                      className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="p-4">
                        <code className="text-sm text-blue-300 bg-blue-600/10 px-2 py-0.5 rounded">
                          {rule.pattern || rule.task_pattern || '-'}
                        </code>
                      </td>
                      <td className="p-4">
                        <span className="text-slate-300 text-sm">{rule.target_provider || rule.provider || '-'}</span>
                        {rule.model && (
                          <span className="ml-2 text-slate-500 text-xs">({rule.model})</span>
                        )}
                      </td>
                      <td className="p-4">
                        <span className="text-slate-300 text-sm">{rule.priority ?? '-'}</span>
                      </td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            rule.enabled !== false && rule.enabled !== 0
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-slate-500/20 text-slate-400'
                          }`}
                        >
                          {rule.enabled !== false && rule.enabled !== 0 ? 'Enabled' : 'Disabled'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {rules.length > PAGE_LIMIT && (
            <Pagination page={rulesPage} totalPages={rulesTotalPages} total={rules.length} onPage={setRulesPage} />
          )}
        </>
      )}

      {/* Claims table */}
      {activeTab === 'claims' && (
        <>
          <div className="glass-card overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-700/50">
                  <SortHeader column="task_id" label="Task ID" sortCol={claimsSort.col} sortDir={claimsSort.dir} onSort={makeSort(setClaimsSort)} />
                  <SortHeader column="agent_id" label="Agent" sortCol={claimsSort.col} sortDir={claimsSort.dir} onSort={makeSort(setClaimsSort)} />
                  <th scope="col" className="text-left p-4 heading-sm">Claimed At</th>
                  <th scope="col" className="text-left p-4 heading-sm">Expires At</th>
                  <SortHeader column="status" label="Status" sortCol={claimsSort.col} sortDir={claimsSort.dir} onSort={makeSort(setClaimsSort)} />
                </tr>
              </thead>
              <tbody>
                {pagedClaims.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-slate-500">
                      No active claims
                    </td>
                  </tr>
                ) : (
                  pagedClaims.map((claim, i) => (
                    <tr
                      key={claim.id || i}
                      className="border-b border-slate-700/30 hover:bg-slate-700/30 transition-colors"
                    >
                      <td className="p-4">
                        <code className="text-xs text-slate-400 font-mono bg-slate-800 px-2 py-0.5 rounded">
                          {String(claim.task_id || claim.id || '-').substring(0, 8)}
                        </code>
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {claim.agent_id || claim.agent_name || '-'}
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {formatDate(claim.claimed_at || claim.created_at)}
                      </td>
                      <td className="p-4 text-slate-300 text-sm">
                        {formatDate(claim.expires_at)}
                      </td>
                      <td className="p-4">
                        <span
                          className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            claim.status === 'active'
                              ? 'bg-green-500/20 text-green-400'
                              : 'bg-slate-500/20 text-slate-400'
                          }`}
                        >
                          {claim.status || 'active'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {claims.length > PAGE_LIMIT && (
            <Pagination page={claimsPage} totalPages={claimsTotalPages} total={claims.length} onPage={setClaimsPage} />
          )}
        </>
      )}
    </div>
  );
}
