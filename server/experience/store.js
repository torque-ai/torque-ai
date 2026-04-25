'use strict';

const database = require('../database');
const { embedText, cosineSim } = require('./embed');

const TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS task_experiences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    task_description TEXT NOT NULL,
    task_description_embedding TEXT,
    output_summary TEXT,
    files_modified TEXT,
    provider TEXT,
    success_score REAL,
    recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_task_experiences_project
  ON task_experiences(project, success_score DESC);
`;

let currentDb = null;
let initializedDb = null;

function setDb(dbInstance) {
  currentDb = dbInstance || null;
  initializedDb = null;
}

function resolveDb() {
  const dbHandle = currentDb || (typeof database.getDbInstance === 'function'
    ? database.getDbInstance()
    : null);

  if (!dbHandle || typeof dbHandle.prepare !== 'function' || typeof dbHandle.exec !== 'function') {
    throw new Error('experience store requires a better-sqlite3 database instance');
  }

  return dbHandle;
}

function ensureExperienceTable() {
  const dbHandle = resolveDb();
  if (initializedDb !== dbHandle) {
    dbHandle.exec(TABLE_SQL);
    initializedDb = dbHandle;
  }
  return dbHandle;
}

function normalizeProject(project) {
  const value = typeof project === 'string' ? project.trim() : '';
  return value || null;
}

function normalizeSuccessScore(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 1;
}

function serializeFiles(filesModified) {
  return JSON.stringify(Array.isArray(filesModified) ? filesModified : []);
}

function parseJsonArray(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseEmbedding(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function recordExperience({
  project,
  task_description,
  output_summary,
  files_modified,
  provider,
  success_score = 1.0,
}) {
  if (!task_description || !String(task_description).trim()) {
    throw new Error('task_description is required');
  }

  const dbHandle = ensureExperienceTable();
  const embedding = await embedText(task_description);

  dbHandle.prepare(`
    INSERT INTO task_experiences (
      project,
      task_description,
      task_description_embedding,
      output_summary,
      files_modified,
      provider,
      success_score
    )
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizeProject(project),
    String(task_description),
    JSON.stringify(embedding),
    String(output_summary || '').slice(0, 4000),
    serializeFiles(files_modified),
    normalizeProject(provider),
    normalizeSuccessScore(success_score),
  );
}

async function findRelatedExperiences({
  project,
  task_description,
  top_k = 3,
  min_similarity = 0.4,
}) {
  if (!task_description || !String(task_description).trim()) {
    return [];
  }

  const dbHandle = ensureExperienceTable();
  const queryEmbedding = await embedText(task_description);
  const safeTopK = Number.isInteger(top_k) && top_k > 0 ? top_k : 3;
  const minimumSimilarity = Number.isFinite(Number(min_similarity)) ? Number(min_similarity) : 0.4;
  const normalizedProject = normalizeProject(project);

  const rows = normalizedProject
    ? dbHandle.prepare(`
      SELECT *
      FROM task_experiences
      WHERE project = ? OR project IS NULL
      ORDER BY recorded_at DESC
      LIMIT 500
    `).all(normalizedProject)
    : dbHandle.prepare(`
      SELECT *
      FROM task_experiences
      ORDER BY recorded_at DESC
      LIMIT 500
    `).all();

  const scored = rows
    .map((row) => {
      const embedding = parseEmbedding(row.task_description_embedding);
      if (!embedding || embedding.length !== queryEmbedding.length) {
        return null;
      }

      return {
        row,
        similarity: cosineSim(queryEmbedding, embedding),
      };
    })
    .filter(Boolean)
    .filter((item) => item.similarity >= minimumSimilarity)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, safeTopK);

  return scored.map(({ row, similarity }) => ({
    task_description: row.task_description,
    output_summary: row.output_summary,
    files_modified: parseJsonArray(row.files_modified),
    provider: row.provider,
    similarity: Number(similarity.toFixed(3)),
  }));
}

module.exports = {
  setDb,
  ensureExperienceTable,
  recordExperience,
  findRelatedExperiences,
};
