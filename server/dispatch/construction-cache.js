'use strict';

const { randomUUID } = require('crypto');

function escapeRegexLiteral(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function templateToRegex(template) {
  if (typeof template !== 'string' || template.trim() === '') {
    throw new TypeError('normalizedTemplate must be a non-empty string');
  }

  const placeholderPattern = /\{(\w+)\}/g;
  let lastIndex = 0;
  let pattern = '';
  let match;

  while ((match = placeholderPattern.exec(template)) !== null) {
    pattern += escapeRegexLiteral(template.slice(lastIndex, match.index));
    pattern += `(?<${match[1]}>[^\\s]+)`;
    lastIndex = match.index + match[0].length;
  }

  pattern += escapeRegexLiteral(template.slice(lastIndex));
  pattern = pattern.replace(/\s+/g, '\\s+');

  return new RegExp(`^${pattern}$`, 'i');
}

function fillTemplate(actionTemplate, captures) {
  if (typeof actionTemplate === 'string') {
    return actionTemplate.replace(/\{(\w+)\}/g, (match, key) => (
      captures[key] !== undefined ? captures[key] : match
    ));
  }

  if (Array.isArray(actionTemplate)) {
    return actionTemplate.map((value) => fillTemplate(value, captures));
  }

  if (actionTemplate && typeof actionTemplate === 'object') {
    const output = {};
    for (const [key, value] of Object.entries(actionTemplate)) {
      output[key] = fillTemplate(value, captures);
    }
    return output;
  }

  return actionTemplate;
}

function resolveDbHandle(db) {
  if (db && typeof db.prepare === 'function' && typeof db.exec === 'function') {
    return db;
  }
  if (db && typeof db.getDbInstance === 'function') {
    const handle = db.getDbInstance();
    if (handle && typeof handle.prepare === 'function' && typeof handle.exec === 'function') {
      return handle;
    }
  }
  throw new TypeError('createConstructionCache requires a sqlite database handle');
}

function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS construction_cache (
      pattern_id TEXT PRIMARY KEY,
      surface TEXT NOT NULL,
      normalized_template TEXT NOT NULL,
      template_regex TEXT NOT NULL,
      action_template_json TEXT NOT NULL,
      hit_count INTEGER NOT NULL DEFAULT 0,
      learned_from_utterance TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );

    CREATE INDEX IF NOT EXISTS idx_construction_surface
    ON construction_cache(surface);
  `);
}

function createConstructionCache({ db }) {
  const handle = resolveDbHandle(db);
  ensureSchema(handle);

  function learn({ utterance, normalizedTemplate, actionTemplate, surface }) {
    const id = `pat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    const regex = templateToRegex(normalizedTemplate).source;
    handle.prepare(`
      INSERT INTO construction_cache (
        pattern_id,
        surface,
        normalized_template,
        template_regex,
        action_template_json,
        learned_from_utterance
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, surface, normalizedTemplate, regex, JSON.stringify(actionTemplate), utterance || null);
    return id;
  }

  function lookup({ utterance, surface }) {
    const rows = handle.prepare(`
      SELECT *
      FROM construction_cache
      WHERE surface = ?
      ORDER BY hit_count DESC, created_at ASC
    `).all(surface);

    for (const row of rows) {
      const regex = new RegExp(row.template_regex, 'i');
      const match = utterance.match(regex);
      if (!match) {
        continue;
      }

      handle.prepare(`
        UPDATE construction_cache
        SET hit_count = hit_count + 1
        WHERE pattern_id = ?
      `).run(row.pattern_id);

      let template;
      try {
        template = JSON.parse(row.action_template_json);
      } catch {
        continue;
      }

      return fillTemplate(template, match.groups || {});
    }

    return null;
  }

  return { learn, lookup };
}

module.exports = { createConstructionCache, templateToRegex, fillTemplate };
