'use strict';

const { defaultContainer } = require('../container');

let fineTuneHandlerDeps = {};

function textResult(data, extra = {}) {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...extra,
  };
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function normalizeString(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function normalizeStringArray(name, value, { required = false } = {}) {
  const list = Array.isArray(value) ? value : [];
  const normalized = list
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
  if (required && normalized.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return normalized;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function getContainer() {
  return hasOwn(fineTuneHandlerDeps, 'container')
    ? fineTuneHandlerDeps.container
    : defaultContainer;
}

function getRuntime() {
  if (fineTuneHandlerDeps.runtime) return fineTuneHandlerDeps.runtime;
  const container = getContainer();
  if (!container || typeof container.get !== 'function') {
    throw new Error('Fine-tune runtime is not initialized');
  }
  if (typeof container.has === 'function' && !container.has('fineTuneRuntime')) {
    throw new Error('Fine-tune runtime is not registered');
  }
  return container.get('fineTuneRuntime');
}

function getDb() {
  if (fineTuneHandlerDeps.db) {
    return typeof fineTuneHandlerDeps.db.getDbInstance === 'function'
      ? fineTuneHandlerDeps.db.getDbInstance()
      : fineTuneHandlerDeps.db;
  }
  const container = getContainer();
  if (!container || typeof container.get !== 'function') return null;
  try {
    if (typeof container.has === 'function' && !container.has('db')) return null;
    const db = container.get('db');
    return db && typeof db.getDbInstance === 'function' ? db.getDbInstance() : db;
  } catch {
    return null;
  }
}

function hasColumn(db, tableName, columnName) {
  if (!db || typeof db.prepare !== 'function') return false;
  try {
    return db.prepare(`PRAGMA table_info(${tableName})`).all()
      .some((column) => column.name === columnName);
  } catch {
    return false;
  }
}

function updateAliasMetadata(alias, spec) {
  const db = getDb();
  if (!db || typeof db.prepare !== 'function') return;

  const assignments = [];
  const values = [];
  if (hasColumn(db, 'model_registry', 'source')) {
    assignments.push('source = ?');
    values.push('fine_tune');
  }
  if (hasColumn(db, 'model_registry', 'tuning_json')) {
    assignments.push('tuning_json = ?');
    values.push(JSON.stringify({
      kind: 'lora_adapter',
      base_model: spec.baseModel,
      adapter_path: spec.adapterPath,
    }));
  }
  if (assignments.length === 0) return;

  values.push('ollama', alias);
  db.prepare(`
    UPDATE model_registry
    SET ${assignments.join(', ')}
    WHERE provider = ? AND model_name = ? AND host_id IS NULL
  `).run(...values);
}

function registerFineTuneAlias(alias, spec) {
  const modelRegistry = fineTuneHandlerDeps.modelRegistry || require('../models/registry');
  const registration = modelRegistry.registerModel({
    provider: 'ollama',
    modelName: alias,
    hostId: null,
  });
  modelRegistry.approveModel('ollama', alias, null);
  updateAliasMetadata(alias, spec || {});
  return {
    provider: 'ollama',
    model_name: alias,
    registered: true,
    model: registration && registration.model ? registration.model : null,
  };
}

function resolveProjectId(workingDir) {
  if (!workingDir) return null;
  try {
    const projectConfig = fineTuneHandlerDeps.projectConfig || require('../db/project-config-core');
    if (projectConfig && typeof projectConfig.getProjectFromPath === 'function') {
      return projectConfig.getProjectFromPath(workingDir);
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeJob(row) {
  if (!row) return null;
  return {
    job_id: row.job_id,
    domain_id: row.domain_id || null,
    name: row.name,
    base_model: row.base_model,
    backend: row.backend,
    source_globs: parseJsonArray(row.source_globs_json),
    ignore: parseJsonArray(row.ignore_globs_json),
    working_dir: row.working_dir || null,
    dataset_path: row.dataset_path || null,
    adapter_path: row.adapter_path || null,
    model_alias: row.model_alias || null,
    status: row.status,
    progress: Number(row.progress || 0),
    error: row.error || null,
    created_at: row.created_at || null,
    started_at: row.started_at || null,
    completed_at: row.completed_at || null,
  };
}

async function handleStartFineTune(args = {}) {
  let jobId = null;
  try {
    const runtime = getRuntime();
    const workingDir = typeof args.working_dir === 'string' && args.working_dir.trim()
      ? args.working_dir.trim()
      : (typeof args.working_directory === 'string' && args.working_directory.trim()
        ? args.working_directory.trim()
        : process.cwd());

    const submitInput = {
      name: normalizeString('name', args.name),
      baseModel: normalizeString('base_model', args.base_model),
      backend: typeof args.backend === 'string' && args.backend.trim() ? args.backend.trim() : 'llama-cpp',
      sourceGlobs: normalizeStringArray('source_globs', args.source_globs, { required: true }),
      ignore: normalizeStringArray('ignore', args.ignore),
      workingDir,
      domainId: resolveProjectId(workingDir),
    };

    jobId = await runtime.submit(submitInput);
    const result = await runtime.execute(jobId, { registerAlias: registerFineTuneAlias });
    const job = normalizeJob(runtime.get(jobId));
    const data = { ...result, job };
    return textResult(data, { structuredData: data });
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    let job = null;
    try {
      job = jobId ? normalizeJob(getRuntime().get(jobId)) : null;
    } catch {
      job = null;
    }
    const data = {
      error: message,
      job_id: jobId,
      job,
    };
    return textResult(`Fine-tune job failed: ${message}`, {
      isError: true,
      structuredData: data,
    });
  }
}

async function handleListFineTuneJobs(args = {}) {
  try {
    const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim() : null;
    const jobs = getRuntime().list({ status }).map(normalizeJob);
    const data = { count: jobs.length, jobs };
    return textResult(data, { structuredData: data });
  } catch (err) {
    return textResult(`Fine-tune list failed: ${err.message}`, { isError: true });
  }
}

async function handleGetFineTuneJob(args = {}) {
  try {
    const jobId = normalizeString('job_id', args.job_id);
    const job = normalizeJob(getRuntime().get(jobId));
    if (!job) {
      return textResult(`Fine-tune job not found: ${jobId}`, { isError: true });
    }
    return textResult(job, { structuredData: job });
  } catch (err) {
    return textResult(`Fine-tune get failed: ${err.message}`, { isError: true });
  }
}

function createFineTuneHandlers(deps = {}) {
  const previousDeps = fineTuneHandlerDeps;
  const scopedDeps = { ...deps };
  return {
    handleStartFineTune: (args) => {
      fineTuneHandlerDeps = scopedDeps;
      return Promise.resolve(handleStartFineTune(args)).finally(() => {
        fineTuneHandlerDeps = previousDeps;
      });
    },
    handleListFineTuneJobs: (args) => {
      fineTuneHandlerDeps = scopedDeps;
      return Promise.resolve(handleListFineTuneJobs(args)).finally(() => {
        fineTuneHandlerDeps = previousDeps;
      });
    },
    handleGetFineTuneJob: (args) => {
      fineTuneHandlerDeps = scopedDeps;
      return Promise.resolve(handleGetFineTuneJob(args)).finally(() => {
        fineTuneHandlerDeps = previousDeps;
      });
    },
  };
}

module.exports = {
  handleStartFineTune,
  handleListFineTuneJobs,
  handleGetFineTuneJob,
  createFineTuneHandlers,
};
