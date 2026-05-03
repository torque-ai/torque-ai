/** Template CRUD, preset loading, active resolution */

'use strict';

const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { CATEGORIES } = require('./category-classifier');
const logger = require('../logger').child({ component: 'template-store' });

const PRESETS_DIR = path.join(__dirname, 'templates');
const MAX_NAME_LENGTH = 100;

let db = null;

function setDb(dbInstance) { db = dbInstance; }

function ensureTable() {
  // Table is created in schema-tables.js — this is kept as a no-op for callers.
}

function seedPresets() {
  if (!db) return;
  let files = [];
  try { files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json')); } catch (err) { logger.warn('[template-store] Cannot read presets directory: ' + err.message); return; }
  // INSERT OR REPLACE so updated JSON presets take effect on restart.
  // Only affects preset templates (preset=1) — user-created templates are untouched.
  // capability_constraints_json was added in migration 55. Pre-migration
  // databases throw `no such column` on the INSERT below; the catch
  // falls back to the legacy INSERT shape so seedPresets still works
  // on a freshly-loaded test schema that hasn't run migrations yet.
  const upsertWithConstraints = db.prepare(`
    INSERT OR REPLACE INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, capability_constraints_json, preset, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, COALESCE((SELECT created_at FROM routing_templates WHERE id = ?), datetime('now')), datetime('now'))
  `);
  let upsertLegacy = null;
  for (const file of files) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
    } catch (error) {
      logger.warn(`[template-store] Failed to parse preset ${file}: ${error.message}`);
      continue;
    }
    const id = `preset-${path.basename(file, '.json')}`;
    const constraintsJson = data.capability_constraints
      ? JSON.stringify(data.capability_constraints)
      : null;
    try {
      upsertWithConstraints.run(
        id,
        data.name,
        data.description || '',
        JSON.stringify(data.rules),
        JSON.stringify(data.complexity_overrides || {}),
        constraintsJson,
        id,
      );
    } catch (err) {
      if (!/no such column/i.test(err.message)) throw err;
      if (!upsertLegacy) {
        upsertLegacy = db.prepare(`
          INSERT OR REPLACE INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, preset, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, 1, COALESCE((SELECT created_at FROM routing_templates WHERE id = ?), datetime('now')), datetime('now'))
        `);
      }
      upsertLegacy.run(id, data.name, data.description || '', JSON.stringify(data.rules), JSON.stringify(data.complexity_overrides || {}), id);
    }
  }
}

function parseRow(row) {
  if (!row) return null;
  try {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      rules: JSON.parse(row.rules_json),
      complexity_overrides: row.complexity_overrides_json ? JSON.parse(row.complexity_overrides_json) : {},
      // capability_constraints_json may be undefined on rows from
      // databases that haven't run migration 55 yet — treat as empty.
      capability_constraints: row.capability_constraints_json
        ? JSON.parse(row.capability_constraints_json)
        : null,
      preset: Boolean(row.preset),
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  } catch (err) {
    logger.warn(`Corrupted template JSON for id=${row.id}: ${err.message}`);
    return null;
  }
}

function listTemplates() {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM routing_templates ORDER BY preset DESC, name ASC').all();
  return rows.map(parseRow).filter(Boolean);
}

function getTemplate(id) {
  if (!db || !id) return null;
  return parseRow(db.prepare('SELECT * FROM routing_templates WHERE id = ?').get(id));
}

function getTemplateByName(name) {
  if (!db || !name) return null;
  return parseRow(db.prepare('SELECT * FROM routing_templates WHERE name = ?').get(name));
}

function validateTemplate(data) {
  const errors = [];
  if (!data.name || typeof data.name !== 'string' || data.name.trim().length === 0) {
    errors.push('name is required and must be non-empty');
  } else if (data.name.length > MAX_NAME_LENGTH) {
    errors.push(`name must be ${MAX_NAME_LENGTH} characters or fewer`);
  }
  if (!data.rules || typeof data.rules !== 'object') {
    errors.push('rules must be an object');
  } else {
    for (const cat of CATEGORIES) {
      if (!(cat in data.rules)) {
        errors.push(`rules.${cat} is required`);
      }
    }
    for (const [key, value] of Object.entries(data.rules)) {
      if (typeof value === 'string') {
        if (value.trim().length === 0) {
          errors.push(`rules.${key} must be non-empty`);
        }
      } else if (Array.isArray(value)) {
        if (value.length === 0) {
          errors.push(`rules.${key} chain must have at least one entry`);
        } else if (value.length > 7) {
          errors.push(`rules.${key} chain exceeds maximum length of 7`);
        }
        for (const entry of value) {
          if (!entry || typeof entry !== 'object' || !entry.provider || typeof entry.provider !== 'string') {
            errors.push(`rules.${key} chain entry must have a provider string`);
          }
        }
      } else {
        errors.push(`rules.${key} must be a string or array of {provider, model?} objects`);
      }
    }
  }
  if (data.complexity_overrides && typeof data.complexity_overrides === 'object') {
    const validComplexity = new Set(['simple', 'normal', 'complex']);
    for (const [cat, overrides] of Object.entries(data.complexity_overrides)) {
      if (typeof overrides !== 'object') continue;
      for (const [level, value] of Object.entries(overrides)) {
        if (!validComplexity.has(level)) {
          errors.push(`complexity_overrides.${cat}.${level} is not a valid complexity level`);
          continue;
        }
        if (typeof value === 'string') {
          if (value.trim().length === 0) {
            errors.push(`complexity_overrides.${cat}.${level} must be non-empty`);
          }
        } else if (Array.isArray(value)) {
          if (value.length === 0) {
            errors.push(`complexity_overrides.${cat}.${level} chain must have at least one entry`);
          } else if (value.length > 7) {
            errors.push(`complexity_overrides.${cat}.${level} chain exceeds maximum length of 7`);
          }
          for (const entry of value) {
            if (!entry || typeof entry !== 'object' || !entry.provider || typeof entry.provider !== 'string') {
              errors.push(`complexity_overrides.${cat}.${level} chain entry must have a provider string`);
            }
          }
        } else {
          errors.push(`complexity_overrides.${cat}.${level} must be a string or array of {provider, model?} objects`);
        }
      }
    }
  }
  // Capability constraints — optional, gate provider selection on
  // file count / file size / greenfield-vs-modification etc. without
  // hardcoding the rules in smart-routing. Phase B of the routing-
  // templates fold-in arc.
  //
  //   capability_constraints: {
  //     // Skip a provider in the chain if the task references more
  //     // than N files. Captures groq's tool-calling ceiling and
  //     // similar provider-specific limits.
  //     max_files: { groq: 1, cerebras: 1 }
  //
  //     // Provider to use for greenfield (no existing-file context)
  //     // tasks when the smart-routing path would otherwise pick
  //     // ollama. Captures the EXP1 rule.
  //     greenfield_provider: "codex"
  //
  //     // Provider to use when the modification target exceeds the
  //     // selected provider's max_safe_edit_lines. Captures P83.
  //     modification_oversize_provider: "codex"
  //   }
  if (data.capability_constraints !== undefined && data.capability_constraints !== null) {
    const cc = data.capability_constraints;
    if (typeof cc !== 'object' || Array.isArray(cc)) {
      errors.push('capability_constraints must be an object');
    } else {
      if (cc.max_files !== undefined && cc.max_files !== null) {
        if (typeof cc.max_files !== 'object' || Array.isArray(cc.max_files)) {
          errors.push('capability_constraints.max_files must be an object of { provider: integer }');
        } else {
          for (const [provider, limit] of Object.entries(cc.max_files)) {
            if (!provider || typeof provider !== 'string') {
              errors.push('capability_constraints.max_files keys must be non-empty provider name strings');
              continue;
            }
            if (!Number.isInteger(limit) || limit < 0) {
              errors.push(`capability_constraints.max_files.${provider} must be a non-negative integer`);
            }
          }
        }
      }
      for (const stringField of ['greenfield_provider', 'modification_oversize_provider']) {
        if (cc[stringField] !== undefined && cc[stringField] !== null) {
          if (typeof cc[stringField] !== 'string' || cc[stringField].trim().length === 0) {
            errors.push(`capability_constraints.${stringField} must be a non-empty provider name string`);
          }
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function createTemplate(data) {
  if (!db) return null;
  const validation = validateTemplate(data);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }
  const id = randomUUID();
  const constraintsJson = data.capability_constraints
    ? JSON.stringify(data.capability_constraints)
    : null;
  try {
    db.prepare(`
      INSERT INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, capability_constraints_json, preset, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(id, data.name.trim(), data.description || '', JSON.stringify(data.rules), JSON.stringify(data.complexity_overrides || {}), constraintsJson);
  } catch (err) {
    if (!/no such column/i.test(err.message)) throw err;
    db.prepare(`
      INSERT INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, preset, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
    `).run(id, data.name.trim(), data.description || '', JSON.stringify(data.rules), JSON.stringify(data.complexity_overrides || {}));
  }
  return getTemplate(id);
}

function updateTemplate(id, data) {
  if (!db || !id) return null;
  const existing = getTemplate(id);
  if (!existing) throw new Error(`Template not found: ${id}`);
  if (existing.preset) throw new Error('Cannot modify preset template. Duplicate it first.');

  const merged = {
    name: data.name !== undefined ? data.name : existing.name,
    description: data.description !== undefined ? data.description : existing.description,
    rules: data.rules !== undefined ? data.rules : existing.rules,
    complexity_overrides: data.complexity_overrides !== undefined ? data.complexity_overrides : existing.complexity_overrides,
    capability_constraints: data.capability_constraints !== undefined ? data.capability_constraints : existing.capability_constraints,
  };
  const validation = validateTemplate(merged);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }
  const constraintsJson = merged.capability_constraints
    ? JSON.stringify(merged.capability_constraints)
    : null;
  try {
    db.prepare(`
      UPDATE routing_templates SET name = ?, description = ?, rules_json = ?, complexity_overrides_json = ?, capability_constraints_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(merged.name, merged.description || '', JSON.stringify(merged.rules), JSON.stringify(merged.complexity_overrides || {}), constraintsJson, id);
  } catch (err) {
    if (!/no such column/i.test(err.message)) throw err;
    db.prepare(`
      UPDATE routing_templates SET name = ?, description = ?, rules_json = ?, complexity_overrides_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(merged.name, merged.description || '', JSON.stringify(merged.rules), JSON.stringify(merged.complexity_overrides || {}), id);
  }
  return getTemplate(id);
}

function deleteTemplate(id) {
  if (!db || !id) return { deleted: false };
  const existing = getTemplate(id);
  if (!existing) return { deleted: false };
  if (existing.preset) throw new Error('Cannot delete preset template.');

  const activeId = db.prepare("SELECT value FROM config WHERE key = 'active_routing_template'").get();
  if (activeId && activeId.value === id) {
    db.prepare("DELETE FROM config WHERE key = 'active_routing_template'").run();
  }

  db.prepare('DELETE FROM routing_templates WHERE id = ?').run(id);
  return { deleted: true };
}

function getExplicitActiveTemplateId() {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM config WHERE key = 'active_routing_template'").get();
    return row?.value || null;
  } catch {
    return null;
  }
}

function getActiveTemplate() {
  if (!db) return null;
  try {
    const row = db.prepare("SELECT value FROM config WHERE key = 'active_routing_template'").get();
    if (row && row.value) {
      const tmpl = getTemplate(row.value);
      if (tmpl) return tmpl;
    }
    return getTemplateByName('System Default');
  } catch {
    // Table may not exist yet (tests without full schema setup)
    return null;
  }
}

function setActiveTemplate(templateId) {
  if (!db) return;
  if (templateId === null || templateId === undefined) {
    db.prepare("DELETE FROM config WHERE key = 'active_routing_template'").run();
    return;
  }
  const tmpl = getTemplate(templateId);
  if (!tmpl) throw new Error(`Template not found: ${templateId}`);
  db.prepare("INSERT OR REPLACE INTO config (key, value) VALUES ('active_routing_template', ?)").run(templateId);
}

function resolveTemplateByNameOrId(value) {
  if (!value || !db) return null;
  const byId = getTemplate(value);
  if (byId) return byId;
  const byName = getTemplateByName(value);
  if (byName) return byName;
  return null;
}

function resolveChain(template, category, complexity) {
  if (!template || !template.rules) return null;

  let value;
  if (template.complexity_overrides && template.complexity_overrides[category]) {
    const override = template.complexity_overrides[category][complexity];
    if (override !== undefined && override !== null) value = override;
  }
  if (value === undefined) value = template.rules[category];
  if (value === undefined) value = template.rules.default;
  if (value === undefined || value === null) return null;

  if (typeof value === 'string') return [{ provider: value }];
  if (Array.isArray(value)) return value;
  return null;
}

function resolveProvider(template, category, complexity) {
  if (!template || !template.rules) return null;
  const chain = resolveChain(template, category, complexity);
  if (!chain || chain.length === 0) return null;

  const selected = chain[0]; // First entry (no health filtering here — caller's job)
  return {
    provider: selected.provider,
    model: selected.model || null,
    chain,
    toString() { return selected.provider; },
    valueOf() { return selected.provider; },
  };
}

module.exports = {
  setDb, ensureTable, seedPresets,
  listTemplates, getTemplate, getTemplateByName, resolveTemplateByNameOrId,
  createTemplate, updateTemplate, deleteTemplate,
  getActiveTemplate, getExplicitActiveTemplateId, setActiveTemplate,
  resolveChain, resolveProvider, validateTemplate,
};
