'use strict';

const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs');
const { CATEGORIES } = require('./category-classifier');

const PRESETS_DIR = path.join(__dirname, 'templates');
const MAX_NAME_LENGTH = 100;

let db = null;

function setDb(dbInstance) { db = dbInstance; }

function ensureTable() {
  if (!db) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS routing_templates (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      rules_json TEXT NOT NULL,
      complexity_overrides_json TEXT,
      preset INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

function seedPresets() {
  if (!db) return;
  const files = fs.readdirSync(PRESETS_DIR).filter(f => f.endsWith('.json'));
  const upsert = db.prepare(`
    INSERT OR IGNORE INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, preset, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
  `);
  for (const file of files) {
    const data = JSON.parse(fs.readFileSync(path.join(PRESETS_DIR, file), 'utf8'));
    const id = `preset-${path.basename(file, '.json')}`;
    upsert.run(id, data.name, data.description || '', JSON.stringify(data.rules), JSON.stringify(data.complexity_overrides || {}));
  }
}

function parseRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    rules: JSON.parse(row.rules_json),
    complexity_overrides: row.complexity_overrides_json ? JSON.parse(row.complexity_overrides_json) : {},
    preset: Boolean(row.preset),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function listTemplates() {
  if (!db) return [];
  const rows = db.prepare('SELECT * FROM routing_templates ORDER BY preset DESC, name ASC').all();
  return rows.map(parseRow);
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
    if (!data.rules.default) {
      errors.push('rules.default is required');
    }
    for (const cat of CATEGORIES) {
      if (!(cat in data.rules)) {
        errors.push(`rules.${cat} is required`);
      }
    }
    for (const [key, value] of Object.entries(data.rules)) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        errors.push(`rules.${key} must be a non-empty string`);
      }
    }
  }
  if (data.complexity_overrides && typeof data.complexity_overrides === 'object') {
    const validComplexity = new Set(['simple', 'normal', 'complex']);
    for (const [cat, overrides] of Object.entries(data.complexity_overrides)) {
      if (typeof overrides !== 'object') continue;
      for (const level of Object.keys(overrides)) {
        if (!validComplexity.has(level)) {
          errors.push(`complexity_overrides.${cat}.${level} is not a valid complexity level`);
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
  db.prepare(`
    INSERT INTO routing_templates (id, name, description, rules_json, complexity_overrides_json, preset, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(id, data.name.trim(), data.description || '', JSON.stringify(data.rules), JSON.stringify(data.complexity_overrides || {}));
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
  };
  const validation = validateTemplate(merged);
  if (!validation.valid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }
  db.prepare(`
    UPDATE routing_templates SET name = ?, description = ?, rules_json = ?, complexity_overrides_json = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(merged.name, merged.description || '', JSON.stringify(merged.rules), JSON.stringify(merged.complexity_overrides || {}), id);
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

function getActiveTemplate() {
  if (!db) return null;
  const row = db.prepare("SELECT value FROM config WHERE key = 'active_routing_template'").get();
  if (row && row.value) {
    const tmpl = getTemplate(row.value);
    if (tmpl) return tmpl;
  }
  return getTemplateByName('System Default');
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

function resolveProvider(template, category, complexity) {
  if (!template || !template.rules) return null;
  if (template.complexity_overrides && template.complexity_overrides[category]) {
    const override = template.complexity_overrides[category][complexity];
    if (override) return override;
  }
  if (template.rules[category]) return template.rules[category];
  return template.rules.default || null;
}

module.exports = {
  setDb, ensureTable, seedPresets,
  listTemplates, getTemplate, getTemplateByName,
  createTemplate, updateTemplate, deleteTemplate,
  getActiveTemplate, setActiveTemplate,
  resolveProvider, validateTemplate,
};
