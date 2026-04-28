'use strict';

const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');

function resolveDb(db) {
  const resolved = db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
  if (!resolved || typeof resolved.prepare !== 'function') {
    throw new Error('fine-tune runtime requires a better-sqlite3 database handle');
  }
  return resolved;
}

function hasColumn(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all()
    .some((column) => column.name === columnName);
}

function parseSourceGlobs(value) {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function validateSubmit(input, backends) {
  if (!input || typeof input !== 'object') throw new Error('Fine-tune job input is required');
  if (!input.name) throw new Error('Fine-tune job name is required');
  if (!input.baseModel) throw new Error('Fine-tune baseModel is required');
  if (!input.backend) throw new Error('Fine-tune backend is required');
  if (!Array.isArray(input.sourceGlobs) || input.sourceGlobs.length === 0) {
    throw new Error('Fine-tune sourceGlobs must be a non-empty array');
  }
  if (!backends[input.backend]) throw new Error(`Unknown backend: ${input.backend}`);
}

function createFineTuneRuntime({ db, backends, buildDataset, logger: _logger = console }) {
  const rawDb = resolveDb(db);
  if (!backends || typeof backends !== 'object') throw new Error('Fine-tune backends are required');
  if (typeof buildDataset !== 'function') throw new Error('Fine-tune buildDataset function is required');

  const supportsWorkingDir = hasColumn(rawDb, 'fine_tune_jobs', 'working_dir');
  const workingDirsByJobId = new Map();

  async function submit(input) {
    validateSubmit(input, backends);
    const {
      name,
      baseModel,
      backend,
      sourceGlobs,
      workingDir = null,
      domainId = null,
    } = input;
    const jobId = `ft_${randomUUID().slice(0, 12)}`;

    if (supportsWorkingDir) {
      rawDb.prepare(`
        INSERT INTO fine_tune_jobs (job_id, domain_id, name, base_model, backend, source_globs_json, working_dir)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(jobId, domainId, name, baseModel, backend, JSON.stringify(sourceGlobs), workingDir);
    } else {
      rawDb.prepare(`
        INSERT INTO fine_tune_jobs (job_id, domain_id, name, base_model, backend, source_globs_json)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(jobId, domainId, name, baseModel, backend, JSON.stringify(sourceGlobs));
      if (workingDir) workingDirsByJobId.set(jobId, workingDir);
    }

    return jobId;
  }

  async function execute(jobId, { registerAlias } = {}) {
    if (typeof registerAlias !== 'function') throw new Error('registerAlias function is required');

    const job = rawDb.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
    if (!job) throw new Error(`Unknown job ${jobId}`);

    rawDb.prepare(`
      UPDATE fine_tune_jobs
      SET status = 'running', started_at = datetime('now'), error = NULL
      WHERE job_id = ?
    `).run(jobId);

    try {
      const globs = parseSourceGlobs(job.source_globs_json);
      const datasetOut = path.join(os.tmpdir(), `${jobId}.jsonl`);
      const dataset = await buildDataset({
        workingDir: job.working_dir || workingDirsByJobId.get(jobId) || process.cwd(),
        globs,
        outputPath: datasetOut,
      });

      rawDb.prepare('UPDATE fine_tune_jobs SET dataset_path = ? WHERE job_id = ?')
        .run(dataset.outputPath, jobId);

      const backend = backends[job.backend];
      if (!backend || typeof backend.train !== 'function') {
        throw new Error(`Unknown backend: ${job.backend}`);
      }

      const { adapterPath } = await backend.train({
        datasetPath: dataset.outputPath,
        baseModel: job.base_model,
        jobId,
        onProgress: (progress) => {
          rawDb.prepare('UPDATE fine_tune_jobs SET progress = ? WHERE job_id = ?').run(progress, jobId);
        },
      });

      rawDb.prepare('UPDATE fine_tune_jobs SET adapter_path = ? WHERE job_id = ?')
        .run(adapterPath, jobId);

      const alias = `${job.base_model}-project-${job.name}`;
      registerAlias(alias, { baseModel: job.base_model, adapterPath });

      rawDb.prepare(`
        UPDATE fine_tune_jobs
        SET model_alias = ?, status = 'completed', progress = 1.0, completed_at = datetime('now')
        WHERE job_id = ?
      `).run(alias, jobId);

      return {
        job_id: jobId,
        model_alias: alias,
        adapter_path: adapterPath,
        record_count: dataset.record_count,
      };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      rawDb.prepare(`
        UPDATE fine_tune_jobs
        SET status = 'failed', error = ?, completed_at = datetime('now')
        WHERE job_id = ?
      `).run(message, jobId);
      throw err;
    }
  }

  function list({ status = null } = {}) {
    if (status) {
      return rawDb.prepare('SELECT * FROM fine_tune_jobs WHERE status = ? ORDER BY created_at DESC')
        .all(status);
    }
    return rawDb.prepare('SELECT * FROM fine_tune_jobs ORDER BY created_at DESC').all();
  }

  function get(jobId) {
    return rawDb.prepare('SELECT * FROM fine_tune_jobs WHERE job_id = ?').get(jobId);
  }

  return { submit, execute, list, get };
}

module.exports = { createFineTuneRuntime };
