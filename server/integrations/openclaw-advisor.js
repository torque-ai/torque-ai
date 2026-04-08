'use strict';

/**
 * OpenClaw Post-Task Advisor
 *
 * Watches task completions via TORQUE's webhook system and proposes
 * follow-up tasks using OpenClaw as an advisory brain.
 *
 * Design principles:
 * - Advisory only: proposals require approval before submission
 * - Opt-in per project/tag: only watches tasks that match config
 * - Rate-limited: max 3 proposals per completed task
 * - Deduplication: won't propose tasks similar to recent submissions
 * - No self-trigger: proposals from OpenClaw don't trigger more proposals
 */

const { randomUUID } = require('crypto');

const adapterRegistry = require('../providers/adapter-registry');
const { extractJson, extractJsonArray } = require('../orchestrator/response-parser');

const DEFAULT_PROVIDER = 'codex';
const DEFAULT_MAX_PROPOSALS = 3;
const DUPLICATE_WINDOW_MS = 24 * 60 * 60 * 1000;
function safeParseJson(value, fallback) {
  if (value === null || value === undefined || value === '') {
    return fallback;
  }
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeTags(rawTags) {
  if (Array.isArray(rawTags)) {
    return rawTags
      .map((tag) => String(tag || '').trim())
      .filter(Boolean);
  }
  if (typeof rawTags !== 'string') {
    return [];
  }

  const parsed = safeParseJson(rawTags, null);
  if (Array.isArray(parsed)) {
    return parsed
      .map((tag) => String(tag || '').trim())
      .filter(Boolean);
  }

  return rawTags
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function normalizeTaskRow(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }
  return {
    ...row,
    tags: normalizeTags(row.tags),
    files_modified: Array.isArray(row.files_modified)
      ? row.files_modified
      : safeParseJson(row.files_modified, []),
    metadata: safeParseJson(row.metadata, {}),
  };
}

function normalizeProjects(value) {
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value !== 'string') {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return fallback;
  return normalized === '1'
    || normalized === 'true'
    || normalized === 'yes'
    || normalized === 'on';
}

function clampMaxProposals(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MAX_PROPOSALS;
  }
  return Math.max(1, Math.min(parsed, 3));
}

function normalizeConfidence(value) {
  if (typeof value === 'number') {
    if (value >= 0.75) return 'high';
    if (value >= 0.45) return 'medium';
    return 'low';
  }

  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizeDescription(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeStatusFilter(value) {
  if (!value) return null;
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .flatMap((entry) => String(entry || '').split(','))
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => entry === 'pending' ? 'pending_approval' : entry);
  return normalized.length > 0 ? new Set(normalized) : null;
}

function getRawDb(db) {
  if (db && typeof db.prepare === 'function') {
    return db;
  }
  if (db && typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }
  return null;
}

function readConfigValue(db, rawDb, key) {
  if (db && typeof db.getConfig === 'function') {
    return db.getConfig(key);
  }
  if (!rawDb) return null;
  try {
    const row = rawDb.prepare('SELECT value FROM config WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

function writeConfigValue(db, rawDb, key, value) {
  const storedValue = String(value);
  if (db && typeof db.setConfig === 'function') {
    db.setConfig(key, storedValue);
    return storedValue;
  }
  if (rawDb) {
    rawDb.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, storedValue);
  }
  return storedValue;
}

function resolveTaskGetter(taskCore, db, rawDb) {
  if (taskCore && typeof taskCore.getTask === 'function') {
    return (taskId) => normalizeTaskRow(taskCore.getTask(taskId));
  }
  if (db && typeof db.getTask === 'function') {
    return (taskId) => normalizeTaskRow(db.getTask(taskId));
  }
  return (taskId) => {
    if (!rawDb || !taskId) return null;
    const row = rawDb.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
    return normalizeTaskRow(row);
  };
}

function computeDurationSeconds(task) {
  if (!task?.started_at || !task?.completed_at) {
    return null;
  }
  const startedAt = Date.parse(task.started_at);
  const completedAt = Date.parse(task.completed_at);
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)) {
    return null;
  }
  return Math.max(0, Math.round((completedAt - startedAt) / 1000));
}

function normalizeFilePaths(files) {
  const normalized = [];
  const seen = new Set();
  for (const entry of Array.isArray(files) ? files : []) {
    const filePath = typeof entry === 'string'
      ? entry
      : (entry && typeof entry.path === 'string' ? entry.path : (entry && typeof entry.file_path === 'string' ? entry.file_path : ''));
    const trimmed = String(filePath || '').trim();
    if (!trimmed) continue;
    const key = trimmed.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

function buildPrompt(contextPayload) {
  return [
    'You are OpenClaw, a post-task advisor for TORQUE.',
    'Given the completed task context below, propose 1-3 valuable follow-up tasks.',
    'Return JSON only with this exact shape:',
    '{"proposals":[{"task_description":"...","rationale":"...","confidence":"high|medium|low","suggested_provider":"..."}]}',
    'Rules:',
    '- Max 3 proposals.',
    '- Proposals must be concrete and actionable.',
    '- Do not restate the completed task.',
    '- Prefer follow-up validation, cleanup, hardening, or next-slice implementation work.',
    '- If no useful follow-up exists, return {"proposals":[]}.',
    '',
    `Completed task context: ${JSON.stringify(contextPayload, null, 2)}`,
  ].join('\n');
}

function extractProposalList(output) {
  const parsedObject = extractJson(output);
  if (parsedObject && Array.isArray(parsedObject.proposals)) {
    return parsedObject.proposals;
  }
  const parsedArray = extractJsonArray(output);
  if (Array.isArray(parsedArray)) {
    return parsedArray;
  }
  return [];
}

function normalizeSuggestedProvider(provider, fallbackProvider) {
  const normalized = String(provider || '').trim().toLowerCase();
  if (normalized && adapterRegistry.getProviderAdapter(normalized)) {
    return normalized;
  }
  if (fallbackProvider && adapterRegistry.getProviderAdapter(fallbackProvider)) {
    return fallbackProvider;
  }
  return null;
}

function buildActualProposal(entry, fallbackProvider) {
  if (!entry || typeof entry !== 'object') {
    return null;
  }

  const taskDescription = normalizeDescription(
    entry.task_description || entry.description || entry.task || ''
  );
  if (!taskDescription) {
    return null;
  }

  const rationale = normalizeDescription(entry.rationale || entry.why || entry.reason || '');
  return {
    task_description: taskDescription,
    rationale: rationale || 'OpenClaw follow-up recommendation.',
    confidence: normalizeConfidence(entry.confidence),
    suggested_provider: normalizeSuggestedProvider(entry.suggested_provider || entry.provider, fallbackProvider),
  };
}

function createOpenClawAdvisor({ db, taskCore, webhookHandlers: _webhookHandlers, logger: _logger } = {}) {
  const rawDb = getRawDb(db);
  const getTask = resolveTaskGetter(taskCore, db, rawDb);

  if (!rawDb || typeof rawDb.prepare !== 'function') {
    throw new Error('OpenClaw advisor requires a database handle');
  }

  function getConfig() {
    const provider = String(readConfigValue(db, rawDb, 'openclaw_advisor_provider') || DEFAULT_PROVIDER)
      .trim()
      .toLowerCase();

    return {
      enabled: parseBoolean(readConfigValue(db, rawDb, 'openclaw_advisor_enabled'), false),
      provider: adapterRegistry.getProviderAdapter(provider) ? provider : DEFAULT_PROVIDER,
      max_proposals: clampMaxProposals(readConfigValue(db, rawDb, 'openclaw_advisor_max_proposals')),
      projects: normalizeProjects(readConfigValue(db, rawDb, 'openclaw_advisor_projects')),
    };
  }

  function setConfig(nextConfig = {}) {
    if (Object.prototype.hasOwnProperty.call(nextConfig, 'enabled')) {
      writeConfigValue(db, rawDb, 'openclaw_advisor_enabled', parseBoolean(nextConfig.enabled) ? '1' : '0');
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, 'provider')) {
      const provider = String(nextConfig.provider || '').trim().toLowerCase();
      if (!provider || !adapterRegistry.getProviderAdapter(provider)) {
        throw new Error(`Unsupported OpenClaw advisor provider: ${nextConfig.provider}`);
      }
      writeConfigValue(db, rawDb, 'openclaw_advisor_provider', provider);
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, 'max_proposals')) {
      writeConfigValue(
        db,
        rawDb,
        'openclaw_advisor_max_proposals',
        String(clampMaxProposals(nextConfig.max_proposals))
      );
    }

    if (Object.prototype.hasOwnProperty.call(nextConfig, 'projects')) {
      const projects = normalizeProjects(nextConfig.projects);
      writeConfigValue(db, rawDb, 'openclaw_advisor_projects', projects.join(','));
    }

    return getConfig();
  }

  function resolveFilesModified(task) {
    const filesModified = normalizeFilePaths(task?.files_modified);
    if (filesModified.length > 0) {
      return filesModified;
    }

    try {
      const rows = rawDb.prepare(`
        SELECT file_path
        FROM task_file_changes
        WHERE task_id = ?
        ORDER BY id ASC
      `).all(task?.id);
      return normalizeFilePaths(rows);
    } catch {
      return [];
    }
  }

  function buildContextPayload(task) {
    const normalizedTask = normalizeTaskRow(task);
    if (!normalizedTask) {
      return null;
    }

    const outputSource = typeof normalizedTask.output === 'string' && normalizedTask.output.trim()
      ? normalizedTask.output
      : (typeof normalizedTask.partial_output === 'string' ? normalizedTask.partial_output : '');

    return {
      task_id: normalizedTask.id,
      description: normalizedTask.task_description || '',
      status: normalizedTask.status || 'completed',
      project: normalizedTask.project || null,
      exit_code: normalizedTask.exit_code ?? null,
      output_summary: String(outputSource || '').slice(0, 500),
      files_modified: resolveFilesModified(normalizedTask),
      duration_seconds: computeDurationSeconds(normalizedTask),
      working_directory: normalizedTask.working_directory || null,
    };
  }

  function getRequestRow(proposalRequestId) {
    const row = rawDb.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(proposalRequestId);
    return row || null;
  }

  function getRecentRequestForTask(parentTaskId) {
    return rawDb.prepare(`
      SELECT *
      FROM openclaw_proposals
      WHERE parent_task_id = ?
        AND confidence IS NULL
      ORDER BY created_at DESC
      LIMIT 1
    `).get(parentTaskId) || null;
  }

  function updateRow(id, updates = {}) {
    const entries = Object.entries(updates);
    if (entries.length === 0) return;
    const setClauses = entries.map(([key]) => `${key} = ?`);
    rawDb.prepare(`
      UPDATE openclaw_proposals
      SET ${setClauses.join(', ')}
      WHERE id = ?
    `).run(...entries.map(([, value]) => value), id);
  }

  function getProposals(filters = {}) {
    const statusFilter = normalizeStatusFilter(filters.status);
    const projectFilter = typeof filters.project === 'string' && filters.project.trim()
      ? filters.project.trim()
      : null;
    const limit = Number.isFinite(Number(filters.limit))
      ? Math.max(1, Math.min(Number.parseInt(filters.limit, 10), 100))
      : 50;

    const rows = rawDb.prepare(`
      SELECT *
      FROM openclaw_proposals
      WHERE confidence IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);

    return rows
      .filter((row) => !projectFilter || row.project === projectFilter)
      .filter((row) => !statusFilter || statusFilter.has(row.status))
      .map((row) => ({
        id: row.id,
        parent_task_id: row.parent_task_id,
        project: row.project,
        status: row.status,
        task_description: row.task_description,
        rationale: row.rationale,
        confidence: row.confidence,
        suggested_provider: row.suggested_provider,
        submitted_task_id: row.submitted_task_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
  }

  function isTaskOptedIn(task, config) {
    if (!config.enabled) {
      return false;
    }

    if (config.projects.length === 0) {
      return true;
    }

    return Boolean(task?.project) && config.projects.includes(task.project);
  }

  function handleTaskCompletion(task) {
    const normalizedTask = normalizeTaskRow(task);
    const config = getConfig();
    if (!normalizedTask || normalizedTask.status !== 'completed') {
      return null;
    }
    if (!isTaskOptedIn(normalizedTask, config)) {
      return null;
    }

    const tags = normalizeTags(normalizedTask.tags);
    if (tags.includes('openclaw-proposal')) {
      return null;
    }

    const existingRequest = getRecentRequestForTask(normalizedTask.id);
    if (existingRequest) {
      return existingRequest.status === 'pending_generation' ? existingRequest.id : null;
    }

    const contextPayload = buildContextPayload(normalizedTask);
    const now = new Date().toISOString();
    const requestId = randomUUID();

    rawDb.prepare(`
      INSERT INTO openclaw_proposals (
        id, parent_task_id, project, status, task_description,
        rationale, confidence, suggested_provider, submitted_task_id,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      requestId,
      normalizedTask.id,
      normalizedTask.project || null,
      'pending_generation',
      JSON.stringify(contextPayload),
      null,
      null,
      null,
      null,
      now,
      now
    );

    return requestId;
  }

  async function runProviderGeneration(contextPayload, providerId) {
    const adapter = adapterRegistry.getProviderAdapter(providerId);
    if (!adapter || typeof adapter.submit !== 'function') {
      throw new Error(`OpenClaw generation provider is unavailable: ${providerId}`);
    }

    const prompt = buildPrompt(contextPayload);
    const options = {
      working_directory: contextPayload.working_directory || process.cwd(),
      timeout: 5,
      maxTokens: 1400,
      tuning: { temperature: 0.2 },
    };

    if (providerId === 'codex') {
      try {
        return await adapter.submit(prompt, null, { ...options, transport: 'api' });
      } catch (err) {
        const message = String(err?.message || err);
        if (!/codex API transport is unavailable|OpenAI API error/i.test(message)) {
          throw err;
        }
        return adapter.submit(prompt, null, options);
      }
    }

    return adapter.submit(prompt, null, options);
  }

  function findRecentDuplicate(taskDescription) {
    const normalizedDescription = normalizeDescription(taskDescription).toLowerCase();
    if (!normalizedDescription) {
      return null;
    }

    const cutoff = new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString();
    const rows = rawDb.prepare(`
      SELECT id, task_description, created_at, status
      FROM tasks
      WHERE created_at >= ?
      ORDER BY created_at DESC
      LIMIT 200
    `).all(cutoff);

    return rows.find((row) => normalizeDescription(row.task_description).toLowerCase() === normalizedDescription) || null;
  }

  async function generateProposals(proposalRequestId) {
    const requestRow = getRequestRow(proposalRequestId);
    if (!requestRow) {
      throw new Error(`OpenClaw proposal request not found: ${proposalRequestId}`);
    }
    if (requestRow.status !== 'pending_generation') {
      return rawDb.prepare(`
        SELECT *
        FROM openclaw_proposals
        WHERE parent_task_id = ?
          AND confidence IS NOT NULL
        ORDER BY created_at DESC
      `).all(requestRow.parent_task_id);
    }

    const config = getConfig();
    const parentTask = getTask(requestRow.parent_task_id);
    const storedContext = safeParseJson(requestRow.task_description, null);
    const contextPayload = storedContext && typeof storedContext === 'object'
      ? storedContext
      : buildContextPayload(parentTask);

    if (!contextPayload) {
      updateRow(requestRow.id, {
        status: 'generation_failed',
        rationale: 'Parent task context is unavailable',
        updated_at: new Date().toISOString(),
      });
      return [];
    }

    const alreadyStored = rawDb.prepare(`
      SELECT COUNT(*) AS count
      FROM openclaw_proposals
      WHERE parent_task_id = ?
        AND confidence IS NOT NULL
    `).get(requestRow.parent_task_id);

    const remainingSlots = Math.max(0, config.max_proposals - Number(alreadyStored?.count || 0));
    if (remainingSlots === 0) {
      updateRow(requestRow.id, {
        status: 'generation_complete',
        updated_at: new Date().toISOString(),
      });
      return getProposals({ project: requestRow.project });
    }

    let providerResult;
    try {
      providerResult = await runProviderGeneration(contextPayload, config.provider);
    } catch (err) {
      updateRow(requestRow.id, {
        status: 'generation_failed',
        rationale: String(err?.message || err),
        updated_at: new Date().toISOString(),
      });
      throw err;
    }

    const proposals = extractProposalList(providerResult?.output || '')
      .map((entry) => buildActualProposal(entry, config.provider))
      .filter(Boolean);

    const seenDescriptions = new Set();
    const uniqueProposals = [];
    for (const proposal of proposals) {
      const key = normalizeDescription(proposal.task_description).toLowerCase();
      if (!key || seenDescriptions.has(key)) continue;
      seenDescriptions.add(key);
      uniqueProposals.push(proposal);
      if (uniqueProposals.length >= remainingSlots) {
        break;
      }
    }

    const now = new Date().toISOString();
    const insertedIds = [];
    for (const proposal of uniqueProposals) {
      const duplicateTask = findRecentDuplicate(proposal.task_description);
      const rejectedAsDuplicate = Boolean(duplicateTask);
      const rowId = randomUUID();
      rawDb.prepare(`
        INSERT INTO openclaw_proposals (
          id, parent_task_id, project, status, task_description,
          rationale, confidence, suggested_provider, submitted_task_id,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        rowId,
        requestRow.parent_task_id,
        requestRow.project || contextPayload.project || null,
        rejectedAsDuplicate ? 'rejected' : 'pending_approval',
        proposal.task_description,
        rejectedAsDuplicate
          ? `Auto-rejected as duplicate of recent task ${duplicateTask.id}: ${proposal.rationale}`
          : proposal.rationale,
        proposal.confidence,
        proposal.suggested_provider,
        null,
        now,
        now
      );
      insertedIds.push(rowId);
    }

    updateRow(requestRow.id, {
      status: insertedIds.length > 0 ? 'generation_complete' : 'no_suggestions',
      updated_at: now,
      rationale: insertedIds.length > 0 ? null : 'No usable follow-up proposals generated',
    });

    return insertedIds.map((proposalId) => rawDb.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(proposalId));
  }

  function getProposalRow(proposalId) {
    const row = rawDb.prepare('SELECT * FROM openclaw_proposals WHERE id = ?').get(proposalId);
    if (!row || row.confidence === null) {
      return null;
    }
    return row;
  }

  async function approveProposal(proposalId) {
    const proposal = getProposalRow(proposalId);
    if (!proposal) {
      throw new Error(`OpenClaw proposal not found: ${proposalId}`);
    }

    if (proposal.status === 'approved' && proposal.submitted_task_id) {
      return proposal.submitted_task_id;
    }
    if (proposal.status === 'rejected') {
      throw new Error(`OpenClaw proposal is already rejected: ${proposalId}`);
    }

    const parentTask = getTask(proposal.parent_task_id);
    const { handleToolCall } = require('../tools');
    const submitArgs = {
      task: proposal.task_description,
      project: proposal.project || parentTask?.project || 'unassigned',
      working_directory: parentTask?.working_directory || undefined,
      tags: ['openclaw-proposal'],
    };
    if (proposal.suggested_provider) {
      submitArgs.override_provider = proposal.suggested_provider;
    }

    const result = await handleToolCall('smart_submit_task', submitArgs);
    if (!result || result.isError || !result.task_id) {
      throw new Error('OpenClaw approval failed to create a follow-up task');
    }

    updateRow(proposalId, {
      status: 'approved',
      submitted_task_id: result.task_id,
      updated_at: new Date().toISOString(),
    });

    return result.task_id;
  }

  function rejectProposal(proposalId) {
    const proposal = getProposalRow(proposalId);
    if (!proposal) {
      throw new Error(`OpenClaw proposal not found: ${proposalId}`);
    }

    updateRow(proposalId, {
      status: 'rejected',
      updated_at: new Date().toISOString(),
    });

    return true;
  }

  return {
    handleTaskCompletion,
    generateProposals,
    getProposals,
    approveProposal,
    rejectProposal,
    getConfig,
    setConfig,
  };
}

module.exports = {
  createOpenClawAdvisor,
};
