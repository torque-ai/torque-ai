import { useState, useEffect, useCallback } from 'react';
import { coordination as coordinationApi } from '../api';
import { useToast } from '../components/Toast';
import StatCard from '../components/StatCard';
import { formatDate } from '../utils/formatters';

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

export default function Coordination() {
  const [dashboard, setDashboard] = useState(null);
  const [agents, setAgents] = useState([]);
  const [rules, setRules] = useState([]);
  const [claims, setClaims] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('agents');
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
      const agents = Array.isArray(agentsData) ? agentsData : (agentsData?.agents || agentsData?.data || []);
      const rules = Array.isArray(rulesData) ? rulesData : (rulesData?.rules || rulesData?.data || []);
      const claims = Array.isArray(claimsData) ? claimsData : (claimsData?.claims || claimsData?.data || []);
      setAgents(agents);
      setRules(rules);
      setClaims(claims);
    } catch (err) {
      console.error('Failed to load coordination data:', err);
      toast.error('Failed to load coordination data');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 15000);
    return () => clearInterval(interval);
  }, [loadData]);

  const activeAgents = agents.filter((a) => a.status === 'active').length;
  const tasksClaimed = dashboard?.tasks_claimed_24h ?? null;
  const failovers = dashboard?.failovers_24h ?? 0;

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
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
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">Name</th>
                <th className="text-left p-4 heading-sm">Status</th>
                <th className="text-left p-4 heading-sm">Last Heartbeat</th>
                <th className="text-left p-4 heading-sm">Capabilities</th>
              </tr>
            </thead>
            <tbody>
              {agents.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">
                    No agents registered
                  </td>
                </tr>
              ) : (
                agents.map((agent) => (
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
      )}

      {/* Routing rules table */}
      {activeTab === 'rules' && (
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">Pattern</th>
                <th className="text-left p-4 heading-sm">Target Provider</th>
                <th className="text-left p-4 heading-sm">Priority</th>
                <th className="text-left p-4 heading-sm">Enabled</th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 ? (
                <tr>
                  <td colSpan={4} className="p-8 text-center text-slate-500">
                    No routing rules configured
                  </td>
                </tr>
              ) : (
                rules.map((rule, i) => (
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
      )}

      {/* Claims table */}
      {activeTab === 'claims' && (
        <div className="glass-card overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-700/50">
                <th className="text-left p-4 heading-sm">Task ID</th>
                <th className="text-left p-4 heading-sm">Agent</th>
                <th className="text-left p-4 heading-sm">Claimed At</th>
                <th className="text-left p-4 heading-sm">Expires At</th>
                <th className="text-left p-4 heading-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {claims.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-500">
                    No active claims
                  </td>
                </tr>
              ) : (
                claims.map((claim, i) => (
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
      )}
    </div>
  );
}
