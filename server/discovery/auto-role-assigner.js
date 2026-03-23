'use strict';

const { suggestRole } = require('./family-classifier');

/**
 * Assigns execution roles (fast/balanced/quality/default) to discovered models
 * for a given provider based on their parameter size.
 *
 * Rules:
 *  - Only considers models with status='approved' and non-null parameter_size_b.
 *  - For each role, if an existing assignment exists and the model is still alive
 *    (status='approved' in model_registry), the role is left untouched.
 *  - If the previously assigned model is gone (status!='approved' or not in registry),
 *    the role is reassigned to a fresh candidate.
 *  - 'default' always goes to the largest available model.
 *  - Returns an array of { role, model, size } for every assignment made this call.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} provider
 * @returns {{ role: string, model: string, size: number }[]}
 */
function assignRolesForProvider(db, provider) {
  const assignments = [];

  const models = db.prepare(`
    SELECT DISTINCT model_name, parameter_size_b
    FROM model_registry
    WHERE provider = ? AND status = 'approved' AND parameter_size_b IS NOT NULL
    ORDER BY parameter_size_b DESC
  `).all(provider);

  if (models.length === 0) return assignments;

  const roles = ['fast', 'balanced', 'quality', 'default'];

  for (const role of roles) {
    const existing = db.prepare(
      'SELECT model_name FROM model_roles WHERE provider = ? AND role = ?'
    ).get(provider, role);

    if (existing) {
      const stillAlive = db.prepare(
        "SELECT 1 FROM model_registry WHERE provider = ? AND model_name = ? AND status = 'approved'"
      ).get(provider, existing.model_name);
      if (stillAlive) continue;
    }

    let candidate;
    if (role === 'default') {
      candidate = models[0]; // largest
    } else {
      candidate = models.find(m => suggestRole(m.parameter_size_b) === role);
    }

    if (candidate) {
      db.prepare(`
        INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
        VALUES (?, ?, ?, datetime('now'))
      `).run(provider, role, candidate.model_name);
      assignments.push({ role, model: candidate.model_name, size: candidate.parameter_size_b });
    }
  }

  return assignments;
}

module.exports = { assignRolesForProvider };
