'use strict';

function handleListModels(args, deps) {
  const db = deps?.db || require('../database').getDbInstance();
  const provider = args?.provider;

  let query = `
    SELECT r.model_name, r.provider, r.family, r.parameter_size_b, r.status,
           r.last_seen_at, r.probe_status,
           c.cap_hashline, c.cap_agentic, c.cap_file_creation, c.cap_multi_file,
           mr.role
    FROM model_registry r
    LEFT JOIN model_capabilities c ON r.model_name = c.model_name
    LEFT JOIN model_roles mr ON r.provider = mr.provider AND r.model_name = mr.model_name
  `;
  const params = [];
  if (provider) {
    query += ' WHERE r.provider = ?';
    params.push(provider);
  }
  query += ' ORDER BY r.provider, r.parameter_size_b DESC';

  const rows = db.prepare(query).all(...params);

  if (rows.length === 0) {
    return '## Models\n\nNo models registered. Run `discover_models` to scan providers.';
  }

  // Group by provider
  const byProvider = {};
  for (const row of rows) {
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  let out = '## Registered Models\n\n';
  for (const [prov, models] of Object.entries(byProvider)) {
    out += `### ${prov}\n\n`;
    out += '| Model | Family | Size | Role | Hashline | Agentic | Status |\n';
    out += '|-------|--------|------|------|----------|---------|--------|\n';
    for (const m of models) {
      const size = m.parameter_size_b ? `${m.parameter_size_b}B` : '-';
      const role = m.role || '-';
      const hl = m.cap_hashline ? 'Y' : '-';
      const ag = m.cap_agentic ? 'Y' : '-';
      out += `| ${m.model_name} | ${m.family || '?'} | ${size} | ${role} | ${hl} | ${ag} | ${m.status} |\n`;
    }
    out += '\n';
  }
  return out;
}

function handleAssignModelRole(args, deps) {
  const db = deps?.db || require('../database').getDbInstance();
  const { provider, role, model_name } = args || {};

  if (!provider || !role || !model_name) {
    return 'Required: provider, role, model_name. Valid roles: fast, balanced, quality, default, fallback.';
  }

  const validRoles = ['fast', 'balanced', 'quality', 'default', 'fallback'];
  if (!validRoles.includes(role)) {
    return `Invalid role "${role}". Valid roles: ${validRoles.join(', ')}`;
  }

  db.prepare(`
    INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(provider, role, model_name);

  return `Assigned ${provider}/${role} = ${model_name}`;
}

function createModelRegistryHandlers(deps) {
  return {
    handleListModels: (args) => handleListModels(args, deps),
    handleAssignModelRole: (args) => handleAssignModelRole(args, deps),
  };
}

module.exports = { createModelRegistryHandlers };
