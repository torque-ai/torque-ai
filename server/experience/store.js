'use strict';

const { embedText, cosineSimilarity } = require('./embed');
const { safeJsonParse } = require('../utils/json');

let db = null;

function setDb(dbInstance) {
  db = dbInstance;
}

function getDb(dbOverride) {
  const candidate = dbOverride || db;
  if (!candidate || typeof candidate.prepare !== 'function') {
    throw new Error('experience store database is not initialized');
  }
  return candidate;
}

function recordExperience(experience, dbOverride) {
  const conn = getDb(dbOverride);
  const description = String(experience.task_description || '').trim();
  if (!description) return null;

  const now = new Date().toISOString();
  const embedding = embedText(description);
  const result = conn.prepare(`
    INSERT INTO task_experiences (
      project, task_description, task_description_embedding, output_summary,
      files_modified, provider, success_score, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    experience.project || null,
    description,
    JSON.stringify(embedding),
    String(experience.output_summary || '').slice(0, 4000),
    JSON.stringify(Array.isArray(experience.files_modified) ? experience.files_modified : []),
    experience.provider || null,
    Number.isFinite(experience.success_score) ? experience.success_score : 1,
    now,
  );

  return { id: result.lastInsertRowid, recorded_at: now };
}

function findRelatedExperiences({ project = null, task_description, limit = 3, min_similarity = 0.2 } = {}, dbOverride) {
  const conn = getDb(dbOverride);
  const query = embedText(task_description || '');
  const params = [];
  let sql = 'SELECT * FROM task_experiences WHERE 1=1';
  if (project) {
    sql += ' AND (project = ? OR project IS NULL)';
    params.push(project);
  }
  sql += ' ORDER BY success_score DESC, recorded_at DESC LIMIT 200';

  const rows = conn.prepare(sql).all(...params);
  const scored = rows
    .map((row) => {
      const embedding = safeJsonParse(row.task_description_embedding, {});
      return { ...row, similarity: cosineSimilarity(query, embedding) };
    })
    .filter((row) => row.similarity >= min_similarity)
    .sort((a, b) => (b.similarity - a.similarity) || (b.success_score - a.success_score))
    .slice(0, Math.max(1, Math.min(10, Number(limit) || 3)));

  return scored;
}

module.exports = {
  setDb,
  recordExperience,
  findRelatedExperiences,
};
