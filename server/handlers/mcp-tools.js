'use strict';

const { randomUUID } = require('crypto');
const vm = require('vm');
const { defaultContainer } = require('../container');
const { createAction } = require('../actions/action');
const { createApplication } = require('../actions/application');
const { createStatePersister } = require('../actions/state-persister');
const { translateToAction } = require('../dispatch/translator');
const { createApprovalPolicy } = require('../evals/approval-policy');
const { runSamples } = require('../evals/run-sample');
const { createScorer } = require('../evals/scorer');
const { createSolver } = require('../evals/solver');
const { createTaskSpec } = require('../evals/task-spec');
const { validateMemory, resolveNamespace, MEMORY_KINDS } = require('../memory/memory-kind');
const { createPromptOptimizer } = require('../memory/prompt-optimizer');
const { createReflectionExecutor } = require('../memory/reflection-executor');
const { createTaskTranscriptLog } = require('../transcripts/transcript-log');
const { validateTranscript } = require('../transcripts/transcript-validator');
const {
  ErrorCodes,
  makeError,
  optionalString,
  requireTask,
  requireString,
} = require('./shared');

const SURFACE_TOOL_ALIASES = Object.freeze({
  workflow: Object.freeze({
    start: 'run_workflow',
  }),
});
const MEMORY_REFLECTION_DEBOUNCE_MS = 500;
const EVAL_SCRIPT_TIMEOUT_MS = 1000;

function buildToolResult(payload) {
  return {
    ...payload,
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonObject(value, fallback = {}) {
  if (!value || typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return isPlainObject(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

const SPECIALIST_HISTORY_PROMPT_LIMIT = 20;
let fallbackRegisteredSpecialists = null;
let fallbackRegisteredEvalTasks = null;

function ensureFallbackRegisteredSpecialists() {
  if (!fallbackRegisteredSpecialists) {
    fallbackRegisteredSpecialists = Object.create(null);
  }
  return fallbackRegisteredSpecialists;
}

function ensureFallbackRegisteredEvalTasks() {
  if (!fallbackRegisteredEvalTasks) {
    fallbackRegisteredEvalTasks = new Map();
  }
  return fallbackRegisteredEvalTasks;
}

function unwrapDbService(dbService) {
  if (dbService && typeof dbService.getDbInstance === 'function') {
    return dbService.getDbInstance();
  }
  return dbService;
}

function resolveSpecialistRegistry() {
  try {
    if (defaultContainer?.has?.('registeredSpecialists')) {
      return defaultContainer.get('registeredSpecialists');
    }
  } catch (error) {
    void error;
  }

  return ensureFallbackRegisteredSpecialists();
}

function resolveSpecialistStorage() {
  try {
    if (defaultContainer?.has?.('specialistStorage')) {
      return defaultContainer.get('specialistStorage');
    }
  } catch (error) {
    void error;
  }

  const database = require('../database');
  const { createSpecialistStorage } = require('../routing/specialist-storage');
  return createSpecialistStorage({ db: unwrapDbService(database) });
}

function resolveEvalTaskRegistry() {
  try {
    if (defaultContainer?.has?.('evalTaskRegistry')) {
      return defaultContainer.get('evalTaskRegistry');
    }
  } catch (error) {
    void error;
  }

  return ensureFallbackRegisteredEvalTasks();
}

function resolveHeuristicTurnClassifier() {
  try {
    if (defaultContainer?.has?.('turnClassifier')) {
      return defaultContainer.get('turnClassifier');
    }
  } catch (error) {
    void error;
  }

  const { createTurnClassifier } = require('../routing/turn-classifier');
  return createTurnClassifier({ adapter: 'heuristic' });
}

function resolveRoutedOrchestrator({ classifier = null, defaultAgent = 'general' } = {}) {
  if (!classifier && defaultAgent === 'general') {
    try {
      if (defaultContainer?.has?.('routedOrchestrator')) {
        return defaultContainer.get('routedOrchestrator');
      }
    } catch (error) {
      void error;
    }
  }

  const { createRoutedOrchestrator } = require('../routing/routed-orchestrator');
  return createRoutedOrchestrator({
    classifier: classifier || resolveHeuristicTurnClassifier(),
    storage: resolveSpecialistStorage(),
    agents: resolveSpecialistRegistry(),
    defaultAgent,
  });
}

function resolveProviderRegistry() {
  try {
    if (defaultContainer?.has?.('providerRegistry')) {
      return defaultContainer.get('providerRegistry');
    }
  } catch (error) {
    void error;
  }

  return require('../providers/registry');
}

function ensureRoutingProviderRegistration(providerRegistry, providerName) {
  if (!providerRegistry || typeof providerRegistry.getProviderInstance !== 'function') {
    return;
  }

  try {
    const db = require('../database');
    if (db?.isReady?.()) {
      require('../config').init({ db });
      if (typeof providerRegistry.init === 'function') {
        providerRegistry.init({ db });
      }
    }
  } catch (error) {
    void error;
  }

  try {
    const cliProviders = require('../providers/v2-cli-providers');
    if (providerName === 'codex' && typeof cliProviders.CodexCliProvider === 'function') {
      providerRegistry.registerProviderClass('codex', cliProviders.CodexCliProvider);
    }
    if (providerName === 'claude-cli' && typeof cliProviders.ClaudeCliProvider === 'function') {
      providerRegistry.registerProviderClass('claude-cli', cliProviders.ClaudeCliProvider);
    }
  } catch (error) {
    void error;
  }

  if (providerName === 'claude-code-sdk') {
    try {
      providerRegistry.registerProviderClass('claude-code-sdk', require('../providers/claude-code-sdk'));
    } catch (error) {
      void error;
    }
  }
}

async function callProviderPrompt(provider, prompt, options = {}) {
  if (!provider) {
    throw createHandlerError('Provider instance is unavailable', ErrorCodes.NO_HOSTS_AVAILABLE);
  }

  if (typeof provider.runPrompt === 'function') {
    const result = await provider.runPrompt({
      prompt,
      format: options.format,
      max_tokens: options.maxTokens,
      transport: options.transport,
      working_directory: options.workingDirectory,
    });
    return normalizeModelOutput(result);
  }

  if (typeof provider.submit === 'function') {
    const result = await provider.submit(prompt, options.model || null, {
      transport: options.transport || 'api',
      maxTokens: options.maxTokens,
      working_directory: options.workingDirectory,
      raw_prompt: true,
    });
    return normalizeModelOutput(result);
  }

  throw createHandlerError(
    `Provider "${provider.name || 'unknown'}" does not support prompt execution`,
    ErrorCodes.INVALID_PARAM,
  );
}

function renderTranscriptForPrompt(history = [], { limit = SPECIALIST_HISTORY_PROMPT_LIMIT } = {}) {
  const transcript = Array.isArray(history) ? history.slice(-limit) : [];
  if (transcript.length === 0) {
    return '(empty)';
  }

  return transcript
    .map((entry, index) => {
      const role = typeof entry?.role === 'string' && entry.role.trim()
        ? entry.role.trim()
        : 'message';
      const agentId = typeof entry?.agent_id === 'string' && entry.agent_id.trim()
        ? ` [agent:${entry.agent_id.trim()}]`
        : '';
      const content = typeof entry?.content === 'string'
        ? entry.content
        : JSON.stringify(entry?.content ?? '');
      return `${index + 1}. ${role}${agentId}: ${content}`;
    })
    .join('\n');
}

function tryParseJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return null;
  }

  const candidates = [text.trim()];
  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fencedMatch?.[1]) {
    candidates.push(fencedMatch[1].trim());
  }

  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(text.slice(firstBrace, lastBrace + 1).trim());
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) {
        return parsed;
      }
    } catch (error) {
      void error;
    }
  }

  return null;
}

function normalizeConfidence(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(0, Math.min(1, numeric));
}

function normalizeSpecialistHandler(handler = {}) {
  if (!isPlainObject(handler)) {
    throw createHandlerError('handler must be an object', ErrorCodes.INVALID_PARAM);
  }

  const inferredKind = typeof handler.kind === 'string' && handler.kind.trim()
    ? handler.kind.trim().toLowerCase()
    : (typeof handler.provider === 'string' && handler.provider.trim()
      ? 'provider'
      : (typeof handler.workflow_id === 'string' && handler.workflow_id.trim()
        ? 'workflow'
        : ((typeof handler.crew_id === 'string' && handler.crew_id.trim()) || isPlainObject(handler.crew)
          ? 'crew'
          : '')));

  if (!['provider', 'workflow', 'crew'].includes(inferredKind)) {
    throw createHandlerError('handler.kind must be one of: provider, workflow, crew', ErrorCodes.INVALID_PARAM);
  }

  const normalized = { ...handler, kind: inferredKind };

  if (inferredKind === 'provider') {
    if (typeof normalized.provider !== 'string' || normalized.provider.trim().length === 0) {
      throw createHandlerError('provider handler requires handler.provider', ErrorCodes.INVALID_PARAM);
    }
    normalized.provider = normalized.provider.trim();
    if (normalized.model !== undefined && typeof normalized.model !== 'string') {
      throw createHandlerError('handler.model must be a string when provided', ErrorCodes.INVALID_PARAM);
    }
    if (normalized.transport !== undefined && typeof normalized.transport !== 'string') {
      throw createHandlerError('handler.transport must be a string when provided', ErrorCodes.INVALID_PARAM);
    }
    if (normalized.system_prompt !== undefined && typeof normalized.system_prompt !== 'string') {
      throw createHandlerError('handler.system_prompt must be a string when provided', ErrorCodes.INVALID_PARAM);
    }
    if (normalized.working_directory !== undefined && typeof normalized.working_directory !== 'string') {
      throw createHandlerError('handler.working_directory must be a string when provided', ErrorCodes.INVALID_PARAM);
    }
    if (normalized.max_tokens !== undefined && (!Number.isInteger(normalized.max_tokens) || normalized.max_tokens < 1)) {
      throw createHandlerError('handler.max_tokens must be a positive integer when provided', ErrorCodes.INVALID_PARAM);
    }
    return normalized;
  }

  if (typeof normalized.workflow_id === 'string' && normalized.workflow_id.trim()) {
    normalized.workflow_id = normalized.workflow_id.trim();
  }

  if (inferredKind === 'workflow') {
    if (!normalized.workflow_id) {
      throw createHandlerError('workflow handler requires handler.workflow_id', ErrorCodes.INVALID_PARAM);
    }
    return normalized;
  }

  if (!normalized.workflow_id) {
    throw createHandlerError(
      'crew handlers require handler.workflow_id in this runtime because no standalone crew registry is available',
      ErrorCodes.INVALID_PARAM,
    );
  }

  return normalized;
}

function createSpecialistResponder(agentId, description, handler) {
  const handlerRef = normalizeSpecialistHandler(handler);

  if (handlerRef.kind === 'provider') {
    return async ({ userInput, specialistHistory = [], globalHistory = [] }) => {
      const providerRegistry = resolveProviderRegistry();
      ensureRoutingProviderRegistration(providerRegistry, handlerRef.provider);
      const provider = providerRegistry?.getProviderInstance?.(handlerRef.provider);
      if (!provider) {
        throw createHandlerError(`Provider not available: ${handlerRef.provider}`, ErrorCodes.NO_HOSTS_AVAILABLE);
      }

      const promptSections = [];
      if (typeof handlerRef.system_prompt === 'string' && handlerRef.system_prompt.trim()) {
        promptSections.push(handlerRef.system_prompt.trim());
      }
      promptSections.push(`You are specialist "${agentId}". ${description}`.trim());
      promptSections.push('Respond to the latest user turn as the selected specialist. Return only the assistant reply text.');
      promptSections.push(`Specialist transcript:\n${renderTranscriptForPrompt(specialistHistory)}`);
      promptSections.push(`Global transcript:\n${renderTranscriptForPrompt(globalHistory)}`);
      promptSections.push(`Latest user turn:\n${userInput}`);

      const response = await callProviderPrompt(provider, promptSections.join('\n\n'), {
        model: handlerRef.model || null,
        transport: handlerRef.transport,
        workingDirectory: handlerRef.working_directory,
        maxTokens: handlerRef.max_tokens || 1200,
      });

      const normalizedResponse = typeof response === 'string'
        ? response.trim()
        : JSON.stringify(response);
      if (!normalizedResponse) {
        throw createHandlerError(`Provider "${handlerRef.provider}" returned an empty response`, ErrorCodes.PROVIDER_ERROR);
      }
      return normalizedResponse;
    };
  }

  return async () => {
    const tools = require('../tools');
    const result = await tools.handleToolCall('run_workflow', {
      workflow_id: handlerRef.workflow_id,
    });
    if (result?.isError) {
      throw createHandlerError(
        extractToolText(result) || `workflow ${handlerRef.workflow_id} failed`,
        result?.error_code || ErrorCodes.OPERATION_FAILED,
      );
    }

    const text = extractToolText(result);
    return text || `Workflow ${handlerRef.workflow_id} started`;
  };
}

async function classifyTurnViaLlm(args = {}) {
  const heuristicClassifier = resolveHeuristicTurnClassifier();
  const fallback = await heuristicClassifier.classify(args);

  const providerName = typeof process.env.TORQUE_TURN_CLASSIFIER_PROVIDER === 'string'
    && process.env.TORQUE_TURN_CLASSIFIER_PROVIDER.trim()
    ? process.env.TORQUE_TURN_CLASSIFIER_PROVIDER.trim()
    : 'codex';

  try {
    const providerRegistry = resolveProviderRegistry();
    ensureRoutingProviderRegistration(providerRegistry, providerName);
    const provider = providerRegistry?.getProviderInstance?.(providerName);
    if (!provider) {
      return fallback;
    }

    const agents = Array.isArray(args.agents) ? args.agents : [];
    const prompt = [
      'Route the latest user turn to the best specialist id from the list below.',
      'Return JSON only: {"agent_id":"<id or null>","confidence":0.0}',
      '',
      'Available specialists:',
      ...agents.map((agent) => `- ${agent.id}: ${agent.description || ''}`),
      '',
      `Recent transcript:\n${renderTranscriptForPrompt(args.history)}`,
      '',
      `Latest user turn:\n${args.userInput || ''}`,
    ].join('\n');

    const raw = await callProviderPrompt(provider, prompt, {
      format: 'json',
      transport: 'api',
      maxTokens: 300,
    });
    const parsed = tryParseJsonObject(raw);
    const knownAgentIds = new Set(agents.map((agent) => agent.id));
    const agentId = typeof parsed?.agent_id === 'string' && knownAgentIds.has(parsed.agent_id)
      ? parsed.agent_id
      : null;

    if (!agentId) {
      return fallback;
    }

    return {
      agent_id: agentId,
      confidence: normalizeConfidence(parsed.confidence, 0.7),
    };
  } catch (error) {
    void error;
    return fallback;
  }
}

function validateStringArray(value, field) {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return makeError(ErrorCodes.INVALID_PARAM, `${field} must be an array of non-empty strings`);
  }
  return null;
}

function resolveMemoryDb() {
  try {
    if (defaultContainer?.has?.('db')) {
      const db = defaultContainer.get('db');
      if (db && typeof db.prepare === 'function') return db;
    }
  } catch (error) {
    void error;
  }

  const database = require('../database');
  const db = typeof database.getDbInstance === 'function'
    ? database.getDbInstance()
    : database;
  if (!db || typeof db.prepare !== 'function') {
    throw createHandlerError('memory database is unavailable', ErrorCodes.DATABASE_ERROR);
  }
  return db;
}

function ensureMemorySchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'semantic',
      namespace TEXT NOT NULL DEFAULT '',
      role TEXT,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT
    )
  `);

  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((row) => row.name));
  const additions = [
    ['kind', "ALTER TABLE memories ADD COLUMN kind TEXT NOT NULL DEFAULT 'semantic'"],
    ['namespace', "ALTER TABLE memories ADD COLUMN namespace TEXT NOT NULL DEFAULT ''"],
    ['role', 'ALTER TABLE memories ADD COLUMN role TEXT'],
    ['metadata_json', 'ALTER TABLE memories ADD COLUMN metadata_json TEXT'],
    ['created_at', 'ALTER TABLE memories ADD COLUMN created_at TEXT'],
    ['updated_at', 'ALTER TABLE memories ADD COLUMN updated_at TEXT'],
  ];
  for (const [column, statement] of additions) {
    if (columns.has(column)) continue;
    try {
      // eslint-disable-next-line torque/no-prepare-in-loop -- one-shot ALTER TABLE migration; each iteration is unique DDL run exactly once at schema-init time, no cache benefit
      db.prepare(statement).run();
    } catch (error) {
      if (!String(error && error.message || '').includes('duplicate column')) {
        throw error;
      }
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_kind_namespace ON memories(kind, namespace)');
}

function getMemoryDb() {
  const db = resolveMemoryDb();
  ensureMemorySchema(db);
  return db;
}

function resolveMemoryNamespace(args = {}) {
  const namespaceError = optionalString(args, 'namespace', 'namespace');
  if (namespaceError) return { error: namespaceError };
  if (args.vars !== undefined && !isPlainObject(args.vars)) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, 'vars must be an object') };
  }
  const template = typeof args.namespace === 'string' ? args.namespace : '';
  return { namespace: resolveNamespace(template, args.vars || {}) };
}

function normalizeMemoryArgs(args = {}) {
  const kind = typeof args.kind === 'string' ? args.kind.trim() : args.kind;
  if (!MEMORY_KINDS.includes(kind)) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, `kind must be one of: ${MEMORY_KINDS.join(', ')}`) };
  }

  if (typeof args.content !== 'string' || args.content.length === 0) {
    return { error: makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'content is required') };
  }

  const roleError = optionalString(args, 'role', 'role');
  if (roleError) return { error: roleError };

  const resolved = resolveMemoryNamespace(args);
  if (resolved.error) return { error: resolved.error };

  if (
    args.embedding !== undefined
    && (!Array.isArray(args.embedding) || args.embedding.some((value) => typeof value !== 'number' || !Number.isFinite(value)))
  ) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, 'embedding must be an array of finite numbers') };
  }

  const memory = {
    kind,
    content: args.content,
    role: typeof args.role === 'string' && args.role.trim() ? args.role.trim() : null,
    namespace: resolved.namespace,
  };

  try {
    validateMemory(memory);
  } catch (error) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, error.message || String(error)) };
  }

  return { memory };
}

function memoryRowToRecord(row, score = null) {
  const record = {
    id: row.id,
    kind: row.kind,
    namespace: row.namespace || '',
    role: row.role || null,
    content: row.content,
    metadata: parseJsonObject(row.metadata_json, {}),
    created_at: row.created_at || null,
    updated_at: row.updated_at || null,
  };
  if (score !== null) record.score = score;
  return record;
}

function latestProceduralMemory(db, role, namespace) {
  return db.prepare(`
    SELECT * FROM memories
    WHERE kind = 'procedural' AND role = ? AND namespace = ?
    ORDER BY COALESCE(updated_at, created_at) DESC
    LIMIT 1
  `).get(role, namespace);
}

function saveMemoryRecord(memory, metadata = {}, options = {}) {
  const db = getMemoryDb();
  const now = new Date().toISOString();
  const metadataJson = JSON.stringify(metadata || {});
  const upsertProcedural = options.upsertProcedural !== false;
  const existing = upsertProcedural && memory.kind === 'procedural' && memory.role
    ? latestProceduralMemory(db, memory.role, memory.namespace || '')
    : null;

  if (existing) {
    db.prepare(`
      UPDATE memories
      SET content = ?, metadata_json = ?, updated_at = ?
      WHERE id = ?
    `).run(memory.content, metadataJson, now, existing.id);
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(existing.id);
    return { ...memoryRowToRecord(row), created: false };
  }

  const id = randomUUID();
  db.prepare(`
    INSERT INTO memories (id, kind, namespace, role, content, metadata_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    memory.kind,
    memory.namespace || '',
    memory.role || null,
    memory.content,
    metadataJson,
    now,
    now,
  );
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  return { ...memoryRowToRecord(row), created: true };
}

function tokenize(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((token) => token.length > 1);
}

function scoreMemoryRecord(record, query) {
  const queryText = String(query || '').trim().toLowerCase();
  if (!queryText) return null;
  const haystack = [
    record.content,
    record.role,
    record.namespace,
    JSON.stringify(record.metadata || {}),
  ].join('\n').toLowerCase();
  let score = haystack.includes(queryText) ? 1 : 0;
  const queryTokens = new Set(tokenize(queryText));
  if (queryTokens.size > 0) {
    const targetTokens = new Set(tokenize(haystack));
    let hits = 0;
    for (const token of queryTokens) {
      if (targetTokens.has(token)) hits += 1;
    }
    score += hits / queryTokens.size;
  }
  return Number(score.toFixed(4));
}

function getLatestProceduralPrompt(role, namespace) {
  const db = getMemoryDb();
  const row = latestProceduralMemory(db, role, namespace || '');
  return row ? memoryRowToRecord(row) : null;
}

function getCodexProvider() {
  let providerRegistry = null;
  try {
    if (defaultContainer?.has?.('providerRegistry')) {
      providerRegistry = defaultContainer.get('providerRegistry');
    }
  } catch (error) {
    void error;
  }

  if (!providerRegistry) {
    providerRegistry = require('../providers/registry');
  }

  try {
    const database = require('../database');
    if (database?.isReady?.()) {
      require('../config').init({ db: database });
      if (typeof providerRegistry.init === 'function') {
        providerRegistry.init({ db: database });
      }
    }
  } catch (error) {
    void error;
  }

  try {
    providerRegistry.registerProviderClass('codex', require('../providers/v2-cli-providers').CodexCliProvider);
  } catch (error) {
    void error;
  }

  return providerRegistry?.getProviderInstance?.('codex') || null;
}

function buildPromptOptimizationRequest({ role, strategy, current, trajectory, feedback }) {
  return [
    `Optimize the procedural prompt for role "${role}" using the "${strategy}" strategy.`,
    'Return only the revised prompt text. Do not wrap it in markdown or JSON.',
    '',
    'Current prompt:',
    current || '(empty)',
    '',
    'Trajectory JSON:',
    JSON.stringify(trajectory || [], null, 2),
    '',
    'Feedback JSON:',
    JSON.stringify(feedback || [], null, 2),
  ].join('\n');
}

async function callPromptOptimizerModel(provider, prompt) {
  if (!provider) {
    throw createHandlerError('codex provider is unavailable', ErrorCodes.NO_HOSTS_AVAILABLE);
  }

  if (typeof provider.runPrompt === 'function') {
    const result = await provider.runPrompt({ prompt, max_tokens: 1500 });
    return normalizeModelOutput(result);
  }

  if (typeof provider.submit === 'function') {
    const result = await provider.submit(prompt, null, { transport: 'api', maxTokens: 1500, raw_prompt: true });
    return normalizeModelOutput(result);
  }

  throw createHandlerError('codex provider does not support prompt execution', ErrorCodes.INVALID_PARAM);
}

function createOptimizerLlm({ role, strategy }) {
  return {
    propose: async ({ current, feedback, trajectory }) => {
      const provider = getCodexProvider();
      const prompt = buildPromptOptimizationRequest({ role, strategy, current, trajectory, feedback });
      const proposed = String(await callPromptOptimizerModel(provider, prompt) || '').trim();
      if (!proposed) {
        throw createHandlerError('optimizer provider returned an empty prompt', ErrorCodes.PROVIDER_ERROR);
      }
      return proposed;
    },
  };
}

function messageContentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      return '';
    }).filter(Boolean).join('\n');
  }
  if (content && typeof content === 'object') {
    return JSON.stringify(content);
  }
  return '';
}

function getLastMessageText(messages, role) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role !== role) continue;
    const text = messageContentToText(messages[i].content).trim();
    if (text) return text;
  }
  return '';
}

function getTaskForRun(runId) {
  try {
    return require('../db/task-core').getTask(runId) || null;
  } catch {
    return null;
  }
}

function deriveProceduralProposals(task, episode) {
  const proposals = [];
  const errorText = String(task?.error_output || '').trim();
  if (task?.status === 'failed' && errorText) {
    proposals.push({
      role: 'executor',
      prompt_delta: `When a run fails with "${errorText.split(/\r?\n/)[0].slice(0, 160)}", preserve the error evidence and plan a targeted retry.`,
    });
  }
  if (episode.input && episode.output && episode.output.length > 1000) {
    proposals.push({
      role: 'reviewer',
      prompt_delta: 'When reviewing long outputs, summarize the decisive evidence before recommending follow-up work.',
    });
  }
  return proposals;
}

async function reflectRunToMemory(runId) {
  const task = getTaskForRun(runId);
  let messages = [];
  let transcriptPath = null;
  try {
    const transcriptLog = getTranscriptLogForTask(runId);
    transcriptPath = transcriptLog.filePath;
    messages = transcriptLog.read();
  } catch (error) {
    void error;
  }

  const input = getLastMessageText(messages, 'user') || String(task?.task_description || '').trim();
  const output = getLastMessageText(messages, 'assistant') || String(task?.output || task?.error_output || '').trim();
  if (!input && !output) {
    return null;
  }

  const episode = {
    input,
    output,
    rationale: `Reflected from run ${runId}`,
  };
  const proposals = deriveProceduralProposals(task, episode);
  return saveMemoryRecord({
    kind: 'episodic',
    namespace: `runs/${runId}`,
    role: null,
    content: JSON.stringify(episode),
  }, {
    source: 'reflect_on_run',
    run_id: runId,
    task_id: task?.id || null,
    task_status: task?.status || null,
    transcript_path: transcriptPath,
    message_count: messages.length,
    proposed_procedural_updates: proposals,
  }, { upsertProcedural: false });
}

const reflectionExecutor = createReflectionExecutor({
  reflect: reflectRunToMemory,
  debounceMs: MEMORY_REFLECTION_DEBOUNCE_MS,
});

function getStatePersister() {
  try {
    if (
      defaultContainer
      && typeof defaultContainer.has === 'function'
      && defaultContainer.has('statePersister')
    ) {
      return defaultContainer.get('statePersister');
    }
  } catch (error) {
    void error;
  }

  const database = require('../database');
  const db = typeof database.getDbInstance === 'function'
    ? database.getDbInstance()
    : database;
  return createStatePersister({ db });
}

function looksLikeFunctionExpression(source) {
  const trimmed = source.trim();
  return trimmed.startsWith('function')
    || trimmed.startsWith('async function')
    || trimmed.startsWith('(')
    || trimmed.includes('=>');
}

function getEvalScriptExpression(source, params, { async = true } = {}) {
  const trimmed = source.trim();
  if (looksLikeFunctionExpression(trimmed)) {
    return `(${trimmed})`;
  }

  const asyncKeyword = async ? 'async ' : '';
  const bareExpression = trimmed.replace(/;+\s*$/, '');
  const canUseExpression = !bareExpression.includes('return') && !bareExpression.includes(';');
  if (canUseExpression) {
    return `(${asyncKeyword}(${params.join(', ')}) => (${bareExpression}))`;
  }

  return `(${asyncKeyword}(${params.join(', ')}) => { ${trimmed} })`;
}

function createEvalConsole() {
  return Object.freeze({
    log() {},
    warn() {},
    error() {},
  });
}

function compileEvalFunction(source, { filename, params, async = true, label }) {
  if (typeof source !== 'string' || !source.trim()) {
    throw createHandlerError(`${label} must be a non-empty string`, ErrorCodes.INVALID_PARAM);
  }

  const fnExpression = getEvalScriptExpression(source, params, { async });
  return async (...values) => {
    const bindings = {};
    params.forEach((param, index) => {
      bindings[`__${param}`] = values[index];
    });

    const invocationArgs = params.map((param) => `__${param}`).join(', ');
    const script = new vm.Script(
      `(async () => {
        const fn = ${fnExpression};
        if (typeof fn !== 'function') return Promise.reject(new TypeError('${label} did not evaluate to a function'));
        return await fn(${invocationArgs});
      })()`,
      { filename },
    );

    return script.runInNewContext({
      ...bindings,
      console: createEvalConsole(),
    }, { timeout: EVAL_SCRIPT_TIMEOUT_MS });
  };
}

function normalizeEvalTags(tags) {
  if (tags === undefined) {
    return [];
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string' || !tag.trim())) {
    throw createHandlerError('tags must be an array of non-empty strings', ErrorCodes.INVALID_PARAM);
  }
  return tags.map((tag) => tag.trim());
}

function buildEvalSolver(taskName, solverConfig) {
  if (!isPlainObject(solverConfig)) {
    throw createHandlerError('solver must be an object', ErrorCodes.INVALID_PARAM);
  }
  if (typeof solverConfig.run_js !== 'string' || !solverConfig.run_js.trim()) {
    throw createHandlerError('solver.run_js must be a non-empty string', ErrorCodes.INVALID_PARAM);
  }

  const run = compileEvalFunction(solverConfig.run_js, {
    filename: `eval-solver-${taskName}.vm.js`,
    params: ['sample', 'ctx'],
    label: 'solver.run_js',
  });

  return createSolver({
    name: `${taskName}:solver`,
    run: async (sample, ctx = {}) => {
      const result = await run(sample, ctx);
      return isPlainObject(result) ? result : { output: result };
    },
  });
}

function buildEvalScorer(taskName, scorerConfig) {
  if (!isPlainObject(scorerConfig)) {
    throw createHandlerError('scorer must be an object', ErrorCodes.INVALID_PARAM);
  }

  const kind = typeof scorerConfig.kind === 'string' ? scorerConfig.kind.trim() : '';
  if (!kind) {
    throw createHandlerError('scorer.kind must be a non-empty string', ErrorCodes.INVALID_PARAM);
  }

  if (kind === 'model_graded') {
    if (typeof scorerConfig.grade_js !== 'string' || !scorerConfig.grade_js.trim()) {
      throw createHandlerError('scorer.grade_js is required for model_graded scorers', ErrorCodes.INVALID_PARAM);
    }

    const grade = compileEvalFunction(scorerConfig.grade_js, {
      filename: `eval-grade-${taskName}.vm.js`,
      params: ['sample', 'result', 'ctx'],
      label: 'scorer.grade_js',
    });

    return createScorer({ kind, grade });
  }

  if (kind === 'match' || kind === 'choice') {
    if (typeof scorerConfig.target_js !== 'string' || !scorerConfig.target_js.trim()) {
      throw createHandlerError(`scorer.target_js is required for ${kind} scorers`, ErrorCodes.INVALID_PARAM);
    }

    const target = compileEvalFunction(scorerConfig.target_js, {
      filename: `eval-target-${taskName}.vm.js`,
      params: ['sample', 'ctx'],
      label: 'scorer.target_js',
    });

    return createScorer({ kind, target });
  }

  throw createHandlerError(`unsupported scorer kind: ${kind}`, ErrorCodes.INVALID_PARAM);
}

function registerEvalTask(taskSpec) {
  const registry = resolveEvalTaskRegistry();
  if (typeof registry.set !== 'function') {
    throw createHandlerError('eval task registry is unavailable', ErrorCodes.INTERNAL_ERROR);
  }
  registry.set(taskSpec.name, taskSpec);
  return taskSpec;
}

function getRegisteredEvalTask(name) {
  const registry = resolveEvalTaskRegistry();
  if (typeof registry.get !== 'function') {
    return null;
  }
  return registry.get(name) || null;
}

function createEvalTaskSpecFromArgs(args = {}) {
  if (!Array.isArray(args.dataset) || args.dataset.length === 0) {
    throw createHandlerError('dataset must be a non-empty array', ErrorCodes.INVALID_PARAM);
  }

  const taskName = args.name.trim();
  const approvalPolicy = args.approval_policy
    ? createApprovalPolicy({ rules: Array.isArray(args.approval_policy.rules) ? args.approval_policy.rules : [] })
    : null;

  return createTaskSpec({
    name: taskName,
    dataset: args.dataset,
    solver: buildEvalSolver(taskName, args.solver),
    scorer: buildEvalScorer(taskName, args.scorer),
    sandbox: isPlainObject(args.sandbox) ? { ...args.sandbox } : args.sandbox,
    approvalPolicy,
    tags: normalizeEvalTags(args.tags),
    metadata: {
      registered_via: 'mcp',
      created_at: new Date().toISOString(),
      solver: { run_js: args.solver.run_js },
      scorer: {
        kind: args.scorer.kind,
        target_js: args.scorer.target_js || null,
        grade_js: args.scorer.grade_js || null,
      },
    },
  });
}

async function queueEvalApprovalReview({ task, sample, tool, args: toolArgs, action }) {
  try {
    const tools = require('../tools');
    const description = [
      `Review eval sample escalation for task "${task?.name || 'unknown'}".`,
      `Approval policy returned "${action}" before tool "${tool}" was allowed to run.`,
      '',
      'Sample:',
      JSON.stringify(sample, null, 2),
      '',
      'Tool args:',
      JSON.stringify(toolArgs || {}, null, 2),
    ].join('\n');
    const result = await tools.handleToolCall('submit_task', {
      task: description,
      project: `eval:${task?.name || 'unassigned'}`,
      tags: ['eval-approval', 'human-review'],
      auto_approve: false,
      priority: 1,
    });

    if (result?.isError) {
      return {
        queued: false,
        error: extractToolText(result) || 'failed to queue review task',
      };
    }

    return {
      queued: true,
      task_id: result?.structuredData?.task_id || null,
      message: extractToolText(result) || null,
    };
  } catch (error) {
    return {
      queued: false,
      error: error?.message || String(error),
    };
  }
}

function compileActionRun(runJs, actionName) {
  if (typeof runJs !== 'string' || !runJs.trim()) {
    throw createHandlerError(`action ${actionName}: run_js must be a non-empty string`, ErrorCodes.INVALID_PARAM);
  }

  const source = runJs.trim();
  const runnerExpression = looksLikeFunctionExpression(source)
    ? `(${source})`
    : `(async (state, inputs) => { ${source} })`;

  return async (state, inputs = {}) => {
    const script = new vm.Script(
      `(async () => {
        const run = ${runnerExpression};
        if (typeof run !== 'function') return Promise.reject(new TypeError('run_js did not evaluate to a function'));
        return await run(__state, __inputs);
      })()`,
      { filename: `action-app-${actionName}.vm.js` },
    );
    return script.runInNewContext({
      __state: state,
      __inputs: inputs,
      console: Object.freeze({
        log() {},
        warn() {},
        error() {},
      }),
    }, { timeout: 1000 });
  };
}

function buildActionAppActions(actionDefs) {
  if (!Array.isArray(actionDefs) || actionDefs.length === 0) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, 'actions must be a non-empty array') };
  }

  const actions = [];
  for (const [index, actionDef] of actionDefs.entries()) {
    if (!isPlainObject(actionDef)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `actions[${index}] must be an object`) };
    }
    if (!actionDef.name || typeof actionDef.name !== 'string') {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `actions[${index}].name must be a non-empty string`) };
    }
    const readError = validateStringArray(actionDef.reads, `actions[${index}].reads`);
    if (readError) return { error: readError };
    const writeError = validateStringArray(actionDef.writes, `actions[${index}].writes`);
    if (writeError) return { error: writeError };

    try {
      actions.push(createAction({
        name: actionDef.name.trim(),
        reads: actionDef.reads.map((entry) => entry.trim()),
        writes: actionDef.writes.map((entry) => entry.trim()),
        run: compileActionRun(actionDef.run_js, actionDef.name.trim()),
      }));
    } catch (error) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, error.message || String(error)) };
    }
  }

  return { actions };
}

function validateStringArrayArg(args, field) {
  const value = args[field];
  if (value === undefined) {
    return null;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    return makeError(ErrorCodes.INVALID_PARAM, `${field} must be an array of non-empty strings`);
  }
  return null;
}

function getClaudeCodeSdkProvider() {
  try {
    const providerRegistry = defaultContainer.get('providerRegistry');
    const provider = providerRegistry?.getProviderInstance?.('claude-code-sdk');
    if (provider) {
      return provider;
    }
  } catch (error) {
    void error;
    // Fall through to direct registry access when the DI container is not booted.
  }

  const providerRegistry = require('../providers/registry');
  providerRegistry.registerProviderClass('claude-code-sdk', require('../providers/claude-code-sdk'));
  return providerRegistry.getProviderInstance('claude-code-sdk');
}

function getRunDirManager() {
  try {
    if (defaultContainer && typeof defaultContainer.has === 'function' && defaultContainer.has('runDirManager')) {
      return defaultContainer.get('runDirManager');
    }
  } catch (error) {
    void error;
  }
  return null;
}

function parseTaskMetadata(task) {
  if (!task || task.metadata == null) {
    return {};
  }

  if (typeof task.metadata === 'object' && !Array.isArray(task.metadata)) {
    return { ...task.metadata };
  }

  if (typeof task.metadata !== 'string') {
    return {};
  }

  try {
    const parsed = JSON.parse(task.metadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function getTranscriptLogForTask(taskId) {
  return createTaskTranscriptLog({
    taskId,
    runDirManager: getRunDirManager(),
  });
}

function normalizeTagList(task) {
  if (Array.isArray(task?.tags)) {
    return task.tags.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim());
  }

  if (typeof task?.tags === 'string' && task.tags.trim()) {
    try {
      const parsed = JSON.parse(task.tags);
      if (Array.isArray(parsed)) {
        return parsed.filter((tag) => typeof tag === 'string' && tag.trim()).map((tag) => tag.trim());
      }
    } catch {
      return [];
    }
  }

  return [];
}

function normalizeReplayDescription(taskDescription, metadata) {
  if (typeof taskDescription !== 'string' || !taskDescription) {
    return '';
  }

  const previousRunDir = typeof metadata?.run_dir === 'string' ? metadata.run_dir.trim() : '';
  if (!previousRunDir) {
    return taskDescription;
  }

  return taskDescription.split(previousRunDir).join('$run_dir');
}

function resolveReplayProvider(task, metadata) {
  const candidates = [
    task?.provider,
    metadata?.requested_provider,
    metadata?.original_provider,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim();
    }
  }

  return '';
}

function toToolFragment(value) {
  return String(value || '')
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toLowerCase();
}

function collectActionNames(schema, actionNames) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    return;
  }

  const actionName = schema.properties?.actionName?.const;
  if (typeof actionName === 'string' && actionName.trim()) {
    actionNames.add(actionName.trim());
  }

  for (const branchName of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(schema[branchName])) {
      continue;
    }
    for (const nestedSchema of schema[branchName]) {
      collectActionNames(nestedSchema, actionNames);
    }
  }
}

function extractActionNames(schema) {
  const actionNames = new Set();
  collectActionNames(schema, actionNames);
  return Array.from(actionNames).sort();
}

function getKnownToolNames() {
  const tools = require('../tools');
  return new Set([
    ...tools.TOOLS.map((tool) => tool && tool.name).filter(Boolean),
    ...(typeof tools.getRuntimeRegisteredToolDefs === 'function'
      ? tools.getRuntimeRegisteredToolDefs().map((tool) => tool && tool.name).filter(Boolean)
      : []),
    ...tools.routeMap.keys(),
  ]);
}

function inferToolForAction(surface, actionName) {
  const normalizedSurface = toToolFragment(surface);
  const normalizedAction = toToolFragment(actionName);
  const aliases = SURFACE_TOOL_ALIASES[normalizedSurface] || {};
  const toolNames = getKnownToolNames();
  const candidates = [];

  if (aliases[normalizedAction]) {
    candidates.push(aliases[normalizedAction]);
  }

  candidates.push(`${normalizedAction}_${normalizedSurface}`);

  if (normalizedSurface.endsWith('s')) {
    candidates.push(`${normalizedAction}_${normalizedSurface.slice(0, -1)}`);
  }

  return candidates.find((candidate) => toolNames.has(candidate)) || null;
}

function extractToolText(result) {
  if (!result || typeof result !== 'object') {
    return '';
  }

  const textBlock = Array.isArray(result.content)
    ? result.content.find((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
    : null;
  if (textBlock?.text) {
    return textBlock.text;
  }

  return typeof result.error === 'string' ? result.error : '';
}

function normalizeModelOutput(raw) {
  if (typeof raw === 'string') {
    return raw;
  }

  if (raw && typeof raw === 'object') {
    if (typeof raw.output === 'string') {
      return raw.output;
    }
    if (typeof raw.content === 'string') {
      return raw.content;
    }
  }

  return JSON.stringify(raw ?? '');
}

function createHandlerError(message, code = ErrorCodes.INTERNAL_ERROR) {
  const error = new Error(message);
  error.code = code;
  return error;
}

async function callTranslatorModel(provider, prompt) {
  if (!provider) {
    throw createHandlerError('codex provider is unavailable', ErrorCodes.NO_HOSTS_AVAILABLE);
  }

  if (typeof provider.runPrompt === 'function') {
    const result = await provider.runPrompt({ prompt, format: 'json', max_tokens: 500 });
    return normalizeModelOutput(result);
  }

  if (typeof provider.submit === 'function') {
    const result = await provider.submit(prompt, null, { transport: 'api', maxTokens: 500 });
    return normalizeModelOutput(result);
  }

  throw createHandlerError('codex provider does not support prompt execution', ErrorCodes.INVALID_PARAM);
}

function normalizeHandlerSpec({ surface, actionName, handlerSpec }) {
  const knownToolNames = getKnownToolNames();

  if (typeof handlerSpec === 'string' && handlerSpec.trim()) {
    const toolName = handlerSpec.trim();
    if (!knownToolNames.has(toolName)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" references unknown tool "${toolName}"`) };
    }

    return {
      tool: toolName,
      arg_map: null,
      fixed_args: null,
      include_action: false,
      include_context: false,
    };
  }

  if (handlerSpec && typeof handlerSpec === 'object' && !Array.isArray(handlerSpec)) {
    const toolName = typeof handlerSpec.tool === 'string' ? handlerSpec.tool.trim() : '';
    if (!toolName) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" must include a non-empty tool name`) };
    }
    if (!knownToolNames.has(toolName)) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" references unknown tool "${toolName}"`) };
    }

    if (handlerSpec.arg_map !== undefined && (!handlerSpec.arg_map || typeof handlerSpec.arg_map !== 'object' || Array.isArray(handlerSpec.arg_map))) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" arg_map must be an object`) };
    }
    if (handlerSpec.arg_map && Object.values(handlerSpec.arg_map).some((value) => typeof value !== 'string' || !value.trim())) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" arg_map values must be non-empty strings`) };
    }

    if (handlerSpec.fixed_args !== undefined && (!handlerSpec.fixed_args || typeof handlerSpec.fixed_args !== 'object' || Array.isArray(handlerSpec.fixed_args))) {
      return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" fixed_args must be an object`) };
    }

    return {
      tool: toolName,
      arg_map: handlerSpec.arg_map || null,
      fixed_args: handlerSpec.fixed_args || null,
      include_action: handlerSpec.include_action === true,
      include_context: handlerSpec.include_context === true,
    };
  }

  if (handlerSpec !== undefined) {
    return { error: makeError(ErrorCodes.INVALID_PARAM, `handler "${actionName}" must be a tool name string or object`) };
  }

  const inferredTool = inferToolForAction(surface, actionName);
  if (!inferredTool) {
    return {
      error: makeError(
        ErrorCodes.INVALID_PARAM,
        `No handler registered for action "${actionName}" on surface "${surface}" and no matching TORQUE tool could be inferred`,
      ),
    };
  }

  return {
    tool: inferredTool,
    arg_map: null,
    fixed_args: null,
    include_action: false,
    include_context: false,
  };
}

function buildToolArgs(action, handlerConfig, context) {
  const actionFields = { ...action };
  delete actionFields.actionName;

  let toolArgs = {};
  if (handlerConfig.arg_map && typeof handlerConfig.arg_map === 'object') {
    for (const [targetArg, sourceField] of Object.entries(handlerConfig.arg_map)) {
      if (typeof sourceField !== 'string') {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(actionFields, sourceField)) {
        toolArgs[targetArg] = actionFields[sourceField];
      }
    }
  } else {
    toolArgs = { ...actionFields };
  }

  if (handlerConfig.fixed_args) {
    Object.assign(toolArgs, handlerConfig.fixed_args);
  }

  if (handlerConfig.include_action) {
    toolArgs.action = { ...action };
  }

  if (handlerConfig.include_context && context && typeof context === 'object') {
    toolArgs.context = { ...context };
  }

  return toolArgs;
}

function createActionHandler(handlerConfig) {
  return async (action, context = {}) => {
    const tools = require('../tools');
    const toolArgs = buildToolArgs(action, handlerConfig, context);
    const result = await tools.handleToolCall(handlerConfig.tool, toolArgs);
    if (result?.isError) {
      throw createHandlerError(extractToolText(result) || `tool ${handlerConfig.tool} failed`);
    }
    return result;
  };
}

function normalizeHandlers({ surface, schema, handlers }) {
  const actionNames = extractActionNames(schema);
  if (actionNames.length === 0) {
    return {
      error: makeError(
        ErrorCodes.INVALID_PARAM,
        'schema must include at least one actionName const in a properties block',
      ),
    };
  }

  const normalizedHandlers = {};
  const handlerTools = {};
  for (const actionName of actionNames) {
    const normalized = normalizeHandlerSpec({
      surface,
      actionName,
      handlerSpec: handlers && Object.prototype.hasOwnProperty.call(handlers, actionName)
        ? handlers[actionName]
        : undefined,
    });
    if (normalized.error) {
      return { error: normalized.error };
    }

    normalizedHandlers[actionName] = createActionHandler(normalized);
    handlerTools[actionName] = normalized.tool;
  }

  return {
    actionNames,
    normalizedHandlers,
    handlerTools,
  };
}

function getDispatchServices() {
  return {
    actionRegistry: defaultContainer.get('actionRegistry'),
    constructionCache: defaultContainer.get('constructionCache'),
    executor: defaultContainer.get('executor'),
    providerRegistry: defaultContainer.get('providerRegistry'),
  };
}

async function handleRegisterActionSchema(args) {
  try {
    const surfaceError = requireString(args, 'surface', 'surface');
    if (surfaceError) return surfaceError;

    const descriptionError = optionalString(args, 'description', 'description');
    if (descriptionError) return descriptionError;

    if (!args.schema || typeof args.schema !== 'object' || Array.isArray(args.schema)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'schema must be a JSON schema object');
    }

    if (args.handlers !== undefined && (!args.handlers || typeof args.handlers !== 'object' || Array.isArray(args.handlers))) {
      return makeError(ErrorCodes.INVALID_PARAM, 'handlers must be an object when provided');
    }

    const { actionRegistry } = getDispatchServices();
    const normalized = normalizeHandlers({
      surface: args.surface.trim(),
      schema: args.schema,
      handlers: args.handlers || null,
    });
    if (normalized.error) {
      return normalized.error;
    }

    actionRegistry.register({
      surface: args.surface.trim(),
      schema: args.schema,
      handlers: normalized.normalizedHandlers,
      description: args.description || null,
    });

    return buildToolResult({
      ok: true,
      surface: args.surface.trim(),
      description: args.description || null,
      action_names: normalized.actionNames,
      handler_tools: normalized.handlerTools,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleListActions(args = {}) {
  try {
    const descriptionError = optionalString(args, 'surface', 'surface');
    if (descriptionError) return descriptionError;

    const { actionRegistry } = getDispatchServices();
    const surfaces = [];

    if (typeof args.surface === 'string' && args.surface.trim()) {
      const surfaceName = args.surface.trim();
      const surface = actionRegistry.getSurface(surfaceName);
      if (surface) {
        surfaces.push({
          surface: surfaceName,
          description: surface.description || null,
          action_names: actionRegistry.listActionNames(surfaceName).sort(),
        });
      }
    } else {
      for (const surfaceName of actionRegistry.listSurfaces()) {
        const surface = actionRegistry.getSurface(surfaceName);
        surfaces.push({
          surface: surfaceName,
          description: surface?.description || null,
          action_names: actionRegistry.listActionNames(surfaceName).sort(),
        });
      }
    }

    return buildToolResult({
      count: surfaces.length,
      surfaces,
    });
  } catch (error) {
    return makeError(ErrorCodes.INTERNAL_ERROR, error.message || String(error));
  }
}

async function handleDispatchNl(args) {
  try {
    const surfaceError = requireString(args, 'surface', 'surface');
    if (surfaceError) return surfaceError;

    const utteranceError = requireString(args, 'utterance', 'utterance');
    if (utteranceError) return utteranceError;

    const surfaceName = args.surface.trim();
    const utterance = args.utterance.trim();
    const {
      actionRegistry,
      constructionCache,
      executor,
      providerRegistry,
    } = getDispatchServices();

    const surface = actionRegistry.getSurface(surfaceName);
    if (!surface) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'unknown surface',
      });
    }

    const cached = constructionCache.lookup({ utterance, surface: surfaceName });
    if (cached) {
      const result = await executor.execute({ surface: surfaceName, action: cached });
      return buildToolResult({
        ...result,
        surface: surfaceName,
        utterance,
        action: cached,
        source: 'cache',
      });
    }

    const provider = providerRegistry.getProviderInstance('codex');
    if (!provider) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'translation provider unavailable',
        provider: 'codex',
      });
    }

    const translation = await translateToAction({
      utterance,
      schema: surface.schema,
      callModel: async ({ prompt }) => callTranslatorModel(provider, prompt),
    });

    if (!translation.ok) {
      return buildToolResult({
        ok: false,
        surface: surfaceName,
        utterance,
        error: 'translation failed',
        details: translation.errors || [],
        attempts: translation.attempts || 0,
      });
    }

    const result = await executor.execute({ surface: surfaceName, action: translation.action });
    if (args.learn_on_success !== false && result.ok) {
      // Future enhancement: derive normalized templates from accepted translations.
    }

    return buildToolResult({
      ...result,
      surface: surfaceName,
      utterance,
      action: translation.action,
      source: 'llm',
      attempts: translation.attempts || 0,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      surface: typeof args.surface === 'string' ? args.surface.trim() : null,
      utterance: typeof args.utterance === 'string' ? args.utterance.trim() : null,
      error: error.message || String(error),
    });
  }
}

async function handleActionAppRun(args = {}) {
  try {
    const built = buildActionAppActions(args.actions);
    if (built.error) return built.error;

    if (!isPlainObject(args.initial_state)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'initial_state must be an object');
    }
    if (args.transitions !== undefined && !isPlainObject(args.transitions)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'transitions must be an object');
    }

    const appIdError = optionalString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;

    const persister = getStatePersister();
    const app = createApplication({
      actions: built.actions,
      transitions: args.transitions || {},
      initialState: args.initial_state,
      persister,
      app_id: args.app_id || undefined,
      partition_key: args.partition_key || '',
    });

    const results = [];
    for (const action of built.actions) {
      const stepResult = await app.step(action.name);
      results.push({
        action_name: action.name,
        result: stepResult.result,
        state: stepResult.nextState,
      });
    }

    return buildToolResult({
      ok: true,
      app_id: app.app_id,
      partition_key: app.partition_key,
      sequence_id: app.getSequence() - 1,
      final_state: app.getState(),
      results,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleActionAppFork(args = {}) {
  try {
    const appIdError = requireString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;
    const newAppIdError = optionalString(args, 'new_app_id', 'new_app_id');
    if (newAppIdError) return newAppIdError;
    const newPartitionKeyError = optionalString(args, 'new_partition_key', 'new_partition_key');
    if (newPartitionKeyError) return newPartitionKeyError;
    if (!Number.isInteger(args.sequence_id)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'sequence_id must be an integer');
    }

    const persister = getStatePersister();
    const sourceAppId = args.app_id.trim();
    const sourcePartitionKey = args.partition_key || '';
    const snapshot = persister.loadAt({
      app_id: sourceAppId,
      partition_key: sourcePartitionKey,
      sequence_id: args.sequence_id,
    });
    if (!snapshot) {
      return makeError(
        ErrorCodes.RESOURCE_NOT_FOUND,
        `no snapshot at ${sourceAppId}:${sourcePartitionKey}:${args.sequence_id}`,
      );
    }

    const newAppId = args.new_app_id || `app_${randomUUID().slice(0, 10)}`;
    const newPartitionKey = args.new_partition_key || '';
    persister.save({
      app_id: newAppId,
      partition_key: newPartitionKey,
      sequence_id: 0,
      action_name: `fork:${snapshot.action_name}`,
      state: snapshot.state,
      result: {
        forked_from: {
          app_id: sourceAppId,
          partition_key: sourcePartitionKey,
          sequence_id: args.sequence_id,
        },
      },
    });

    return buildToolResult({
      ok: true,
      app_id: newAppId,
      partition_key: newPartitionKey,
      sequence_id: 0,
      forked_from: {
        app_id: sourceAppId,
        partition_key: sourcePartitionKey,
        sequence_id: args.sequence_id,
      },
      state: snapshot.state,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleActionAppHistory(args = {}) {
  try {
    const appIdError = requireString(args, 'app_id', 'app_id');
    if (appIdError) return appIdError;
    const partitionKeyError = optionalString(args, 'partition_key', 'partition_key');
    if (partitionKeyError) return partitionKeyError;

    const appId = args.app_id.trim();
    const partitionKey = args.partition_key || '';
    const history = getStatePersister().history({
      app_id: appId,
      partition_key: partitionKey,
    });

    return buildToolResult({
      ok: true,
      app_id: appId,
      partition_key: partitionKey,
      count: history.length,
      history,
    });
  } catch (error) {
    return makeError(ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleDispatchSubagent(args = {}) {
  try {
    const promptError = requireString(args, 'prompt', 'prompt');
    if (promptError) return promptError;

    const modelError = optionalString(args, 'model', 'model');
    if (modelError) return modelError;

    const skillError = optionalString(args, 'skill', 'skill');
    if (skillError) return skillError;

    const allowedToolsError = validateStringArrayArg(args, 'allowed_tools');
    if (allowedToolsError) return allowedToolsError;

    const disallowedToolsError = validateStringArrayArg(args, 'disallowed_tools');
    if (disallowedToolsError) return disallowedToolsError;

    if (
      args.timeout_ms !== undefined
      && (!Number.isInteger(args.timeout_ms) || args.timeout_ms < 1)
    ) {
      return makeError(ErrorCodes.INVALID_PARAM, 'timeout_ms must be a positive integer');
    }

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.dispatchSubagent !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    const result = await provider.dispatchSubagent({
      prompt: args.prompt.trim(),
      model: args.model || null,
      allowed_tools: Array.isArray(args.allowed_tools) ? args.allowed_tools : [],
      disallowed_tools: Array.isArray(args.disallowed_tools) ? args.disallowed_tools : [],
      mode: args.mode,
      skill: args.skill || null,
      timeout_ms: args.timeout_ms,
      working_directory: process.cwd(),
    });

    return buildToolResult({
      ok: true,
      ...result,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleResumeSession(args = {}) {
  try {
    const sessionError = requireString(args, 'session_id', 'session_id');
    if (sessionError) return sessionError;

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.resumeSession !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    return buildToolResult({
      ok: true,
      session: provider.resumeSession(args.session_id.trim()),
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleForkSession(args = {}) {
  try {
    const sessionError = requireString(args, 'source_session_id', 'source_session_id');
    if (sessionError) return sessionError;

    const nameError = optionalString(args, 'name', 'name');
    if (nameError) return nameError;

    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.forkSession !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    return buildToolResult({
      ok: true,
      session: provider.forkSession(args.source_session_id.trim(), {
        name: args.name || null,
      }),
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleListSessions() {
  try {
    const provider = getClaudeCodeSdkProvider();
    if (!provider || typeof provider.listSessions !== 'function') {
      return makeError(ErrorCodes.NO_HOSTS_AVAILABLE, 'claude-code-sdk provider is unavailable');
    }

    const sessions = provider.listSessions();
    return buildToolResult({
      ok: true,
      count: sessions.length,
      sessions,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleSaveMemory(args = {}) {
  try {
    const normalized = normalizeMemoryArgs(args);
    if (normalized.error) return normalized.error;

    const metadata = {
      vars: args.vars || {},
    };
    if (args.embedding !== undefined) {
      metadata.embedding = args.embedding;
    }

    const memory = saveMemoryRecord(normalized.memory, metadata);
    return buildToolResult({
      ok: true,
      memory,
    });
  } catch (error) {
    return makeError(ErrorCodes.DATABASE_ERROR, error.message || String(error));
  }
}

async function handleSearchMemory(args = {}) {
  try {
    const kindError = optionalString(args, 'kind', 'kind');
    if (kindError) return kindError;
    const queryError = optionalString(args, 'query', 'query');
    if (queryError) return queryError;
    const resolved = resolveMemoryNamespace(args);
    if (resolved.error) return resolved.error;

    const kind = typeof args.kind === 'string' && args.kind.trim() ? args.kind.trim() : null;
    if (kind && !MEMORY_KINDS.includes(kind)) {
      return makeError(ErrorCodes.INVALID_PARAM, `kind must be one of: ${MEMORY_KINDS.join(', ')}`);
    }

    let limit = args.limit === undefined ? 10 : Math.floor(Number(args.limit));
    if (!Number.isFinite(limit) || limit < 1) {
      return makeError(ErrorCodes.INVALID_PARAM, 'limit must be a positive number');
    }
    limit = Math.min(limit, 50);

    const query = typeof args.query === 'string' ? args.query.trim() : '';
    const db = getMemoryDb();
    const where = [];
    const params = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (typeof args.namespace === 'string') {
      where.push('namespace = ?');
      params.push(resolved.namespace);
    }
    const sql = [
      'SELECT * FROM memories',
      where.length ? `WHERE ${where.join(' AND ')}` : '',
      'ORDER BY COALESCE(updated_at, created_at) DESC',
      'LIMIT ?',
    ].filter(Boolean).join(' ');
    params.push(query ? Math.min(limit * 5, 250) : limit);

    let memories = db.prepare(sql).all(...params).map((row) => memoryRowToRecord(row));
    if (query) {
      memories = memories
        .map((record) => ({ record, score: scoreMemoryRecord(record, query) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map((entry) => ({ ...entry.record, score: entry.score }));
    }

    return buildToolResult({
      ok: true,
      count: memories.length,
      memories,
    });
  } catch (error) {
    return makeError(ErrorCodes.DATABASE_ERROR, error.message || String(error));
  }
}

async function handleOptimizePrompt(args = {}) {
  try {
    const roleError = requireString(args, 'role', 'role');
    if (roleError) return roleError;
    const strategyError = requireString(args, 'strategy', 'strategy');
    if (strategyError) return strategyError;
    const resolved = resolveMemoryNamespace(args);
    if (resolved.error) return resolved.error;

    const role = args.role.trim();
    const strategy = args.strategy.trim();
    if (!['metaprompt', 'gradient', 'prompt_memory'].includes(strategy)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'strategy must be metaprompt, gradient, or prompt_memory');
    }
    if (args.trajectory !== undefined && !Array.isArray(args.trajectory)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'trajectory must be an array');
    }
    if (
      args.feedback !== undefined
      && (!Array.isArray(args.feedback) || args.feedback.some((item) => typeof item !== 'string'))
    ) {
      return makeError(ErrorCodes.INVALID_PARAM, 'feedback must be an array of strings');
    }

    const currentMemory = getLatestProceduralPrompt(role, resolved.namespace);
    const optimizer = createPromptOptimizer({
      strategy,
      llm: strategy === 'prompt_memory' ? null : createOptimizerLlm({ role, strategy }),
    });
    const result = await optimizer.optimize({
      current: currentMemory?.content || '',
      trajectory: args.trajectory || [],
      feedback: args.feedback || [],
    });

    let appliedMemory = null;
    if (args.apply === true) {
      if (typeof result.prompt !== 'string' || result.prompt.trim().length === 0) {
        return makeError(ErrorCodes.INVALID_PARAM, 'optimizer produced an empty prompt; nothing was applied');
      }
      appliedMemory = saveMemoryRecord({
        kind: 'procedural',
        namespace: resolved.namespace,
        role,
        content: result.prompt,
      }, {
        source: 'optimize_prompt',
        strategy,
        previous_memory_id: currentMemory?.id || null,
        trajectory_count: Array.isArray(args.trajectory) ? args.trajectory.length : 0,
        feedback_count: Array.isArray(args.feedback) ? args.feedback.length : 0,
      });
    }

    return buildToolResult({
      ok: true,
      role,
      namespace: resolved.namespace,
      strategy,
      changed: Boolean(result.changed),
      applied: args.apply === true,
      memory_id: appliedMemory?.id || currentMemory?.id || null,
      prompt: result.prompt,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

async function handleReflectOnRun(args = {}) {
  try {
    const runIdError = requireString(args, 'run_id', 'run_id');
    if (runIdError) return runIdError;

    const runId = args.run_id.trim();
    reflectionExecutor.submit(runId);
    return buildToolResult({
      ok: true,
      run_id: runId,
      scheduled: true,
      debounce_ms: MEMORY_REFLECTION_DEBOUNCE_MS,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

async function handleReadTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    const transcriptLog = getTranscriptLogForTask(taskId);
    const messages = transcriptLog.read();
    const validation = validateTranscript(messages);

    return buildToolResult({
      ok: validation.ok,
      task_id: taskId,
      file_path: transcriptLog.filePath,
      count: messages.length,
      messages,
      errors: validation.errors,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleEditTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    if (!Array.isArray(args.messages)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'messages must be an array');
    }

    const validation = validateTranscript(args.messages);
    if (!validation.ok) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        errors: validation.errors,
      });
    }

    const transcriptLog = getTranscriptLogForTask(taskId);
    transcriptLog.replace(args.messages);

    return buildToolResult({
      ok: true,
      task_id: taskId,
      file_path: transcriptLog.filePath,
      count: args.messages.length,
      messages: args.messages,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

async function handleReplayFromTranscript(args = {}) {
  try {
    const taskError = requireString(args, 'task_id', 'task_id');
    if (taskError) return taskError;

    const taskId = args.task_id.trim();
    const { task, error: taskLookupError } = requireTask(taskId);
    if (taskLookupError) return taskLookupError;

    const transcriptLog = getTranscriptLogForTask(taskId);
    const messages = transcriptLog.read();
    if (messages.length === 0) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        file_path: transcriptLog.filePath,
        error: `No transcript found for task ${taskId}`,
      });
    }

    const validation = validateTranscript(messages);
    if (!validation.ok) {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        file_path: transcriptLog.filePath,
        errors: validation.errors,
      });
    }

    const metadata = parseTaskMetadata(task);
    const provider = resolveReplayProvider(task, metadata);
    if (provider !== 'claude-code-sdk') {
      return buildToolResult({
        ok: false,
        task_id: taskId,
        provider: provider || null,
        error: 'replay_from_transcript currently supports claude-code-sdk tasks only',
      });
    }

    const replayTaskId = randomUUID();
    const taskCore = require('../db/task-core');
    const providerRoutingCore = require('../db/provider/routing-core');
    const taskManager = require('../task-manager');

    const replayMetadata = {
      ...metadata,
      requested_provider: provider,
      user_provider_override: true,
      transcript_seed_from_task_id: taskId,
      transcript_replay_of: taskId,
    };
    delete replayMetadata.run_dir;
    delete replayMetadata.transcript_path;
    delete replayMetadata.claude_session_id;
    delete replayMetadata.claude_local_session_id;
    delete replayMetadata.fork_from_claude_session_id;

    const replayTags = normalizeTagList(task);
    if (!replayTags.includes(`replay_of:${taskId}`)) {
      replayTags.push(`replay_of:${taskId}`);
    }

    taskCore.createTask({
      id: replayTaskId,
      status: 'queued',
      task_description: normalizeReplayDescription(task.task_description, metadata),
      working_directory: task.working_directory || null,
      timeout_minutes: task.timeout_minutes,
      auto_approve: Boolean(task.auto_approve),
      priority: task.priority || 0,
      max_retries: task.max_retries,
      template_name: task.template_name || null,
      isolated_workspace: task.isolated_workspace || null,
      project: task.project || null,
      tags: replayTags,
      provider,
      model: task.model || null,
      complexity: task.complexity || 'normal',
      metadata: replayMetadata,
    });

    providerRoutingCore.createTaskReplay({
      id: randomUUID(),
      original_task_id: taskId,
      replay_task_id: replayTaskId,
      modified_inputs: {
        transcript_seed_from_task_id: taskId,
        transcript_message_count: messages.length,
      },
      diff_summary: 'Replay from transcript',
    });

    try {
      taskManager.processQueue();
    } catch (error) {
      void error;
    }

    return buildToolResult({
      ok: true,
      task_id: taskId,
      replay_task_id: replayTaskId,
      provider,
      status: 'queued',
      file_path: transcriptLog.filePath,
      transcript_message_count: messages.length,
    });
  } catch (error) {
    return buildToolResult({
      ok: false,
      error: error.message || String(error),
    });
  }
}

function handleRegisterSpecialist(args = {}) {
  const idError = requireString(args, 'id', 'id');
  if (idError) return idError;
  const descriptionError = requireString(args, 'description', 'description');
  if (descriptionError) return descriptionError;

  if (!isPlainObject(args.handler)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'handler must be an object');
  }

  try {
    const agentId = args.id.trim();
    const description = args.description.trim();
    const handler = normalizeSpecialistHandler(args.handler);
    const registry = resolveSpecialistRegistry();
    const existed = Object.prototype.hasOwnProperty.call(registry, agentId);

    registry[agentId] = {
      id: agentId,
      description,
      handler,
      respond: createSpecialistResponder(agentId, description, handler),
    };

    return buildToolResult({
      ok: true,
      updated: existed,
      specialist: {
        id: agentId,
        description,
        handler,
      },
      total_specialists: Object.keys(registry).length,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleRouteTurn(args = {}) {
  try {
    const userIdError = requireString(args, 'user_id', 'user_id');
    if (userIdError) return userIdError;
    const sessionIdError = requireString(args, 'session_id', 'session_id');
    if (sessionIdError) return sessionIdError;
    const inputError = requireString(args, 'user_input', 'user_input');
    if (inputError) return inputError;

    const defaultAgentError = optionalString(args, 'default_agent', 'default_agent');
    if (defaultAgentError) return defaultAgentError;

    const adapter = args.classifier_adapter === undefined || args.classifier_adapter === null
      ? 'heuristic'
      : args.classifier_adapter;
    if (!['heuristic', 'llm'].includes(adapter)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'classifier_adapter must be one of: heuristic, llm');
    }

    const registry = resolveSpecialistRegistry();
    if (Object.keys(registry).length === 0) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, 'No specialists registered');
    }

    const classifier = adapter === 'heuristic'
      ? null
      : require('../routing/turn-classifier').createTurnClassifier({
        adapter: 'llm',
        classifyFn: classifyTurnViaLlm,
      });

    const defaultAgent = typeof args.default_agent === 'string' && args.default_agent.trim()
      ? args.default_agent.trim()
      : 'general';
    const orchestrator = resolveRoutedOrchestrator({
      classifier,
      defaultAgent,
    });
    const result = await orchestrator.routeTurn({
      user_id: args.user_id.trim(),
      session_id: args.session_id.trim(),
      userInput: args.user_input.trim(),
    });

    return buildToolResult({
      ok: true,
      user_id: args.user_id.trim(),
      session_id: args.session_id.trim(),
      classifier_adapter: adapter,
      default_agent: defaultAgent,
      agent_id: result.agent_id,
      response: result.response,
      confidence: result.confidence,
      routed: result.routed,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

function handleGetSessionHistory(args = {}) {
  const userIdError = requireString(args, 'user_id', 'user_id');
  if (userIdError) return userIdError;
  const sessionIdError = requireString(args, 'session_id', 'session_id');
  if (sessionIdError) return sessionIdError;
  const agentIdError = optionalString(args, 'agent_id', 'agent_id');
  if (agentIdError) return agentIdError;

  try {
    const storage = resolveSpecialistStorage();
    const userId = args.user_id.trim();
    const sessionId = args.session_id.trim();
    const agentId = typeof args.agent_id === 'string' && args.agent_id.trim()
      ? args.agent_id.trim()
      : null;
    const history = agentId
      ? storage.readSpecialist({ user_id: userId, session_id: sessionId, agent_id: agentId })
      : storage.readGlobal({ user_id: userId, session_id: sessionId });

    return buildToolResult({
      ok: true,
      scope: agentId ? 'specialist' : 'global',
      user_id: userId,
      session_id: sessionId,
      agent_id: agentId,
      count: history.length,
      history,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

async function handleCreateEvalTask(args = {}) {
  try {
    const nameError = requireString(args, 'name', 'name');
    if (nameError) return nameError;

    const taskSpec = createEvalTaskSpecFromArgs(args);
    registerEvalTask(taskSpec);
    return buildToolResult({
      name: taskSpec.name,
      registered: true,
      dataset_size: taskSpec.dataset.length,
      tags: taskSpec.tags,
      has_approval_policy: Boolean(taskSpec.approvalPolicy),
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

async function handleRunEvalTask(args = {}) {
  try {
    const nameError = requireString(args, 'name', 'name');
    if (nameError) return nameError;

    const task = getRegisteredEvalTask(args.name.trim());
    if (!task) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Eval task not found: ${args.name}`);
    }

    if (args.limit !== undefined) {
      const numeric = Number(args.limit);
      if (!Number.isFinite(numeric) || numeric < 1) {
        return makeError(ErrorCodes.INVALID_PARAM, 'limit must be a positive integer');
      }
    }

    const tools = require('../tools');
    const result = await runSamples(task, {
      limit: args.limit,
      callTool: (toolName, toolArgs) => tools.handleToolCall(toolName, toolArgs),
      onEscalate: queueEvalApprovalReview,
    });
    return buildToolResult(result);
  } catch (error) {
    return makeError(error.code || ErrorCodes.OPERATION_FAILED, error.message || String(error));
  }
}

async function handleSetApprovalPolicy(args = {}) {
  try {
    const nameError = requireString(args, 'name', 'name');
    if (nameError) return nameError;
    if (!Array.isArray(args.rules)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'rules must be an array');
    }

    const task = getRegisteredEvalTask(args.name.trim());
    if (!task) {
      return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Eval task not found: ${args.name}`);
    }

    task.approvalPolicy = createApprovalPolicy({ rules: args.rules });
    return buildToolResult({
      name: task.name,
      updated: true,
      rule_count: task.approvalPolicy.rules.length,
    });
  } catch (error) {
    return makeError(error.code || ErrorCodes.INVALID_PARAM, error.message || String(error));
  }
}

module.exports = {
  handleRegisterActionSchema,
  handleListActions,
  handleDispatchNl,
  handleActionAppRun,
  handleActionAppFork,
  handleActionAppHistory,
  handleDispatchSubagent,
  handleResumeSession,
  handleForkSession,
  handleListSessions,
  handleSaveMemory,
  handleSearchMemory,
  handleOptimizePrompt,
  handleReflectOnRun,
  handleReadTranscript,
  handleEditTranscript,
  handleReplayFromTranscript,
  handleRegisterSpecialist,
  handleRouteTurn,
  handleGetSessionHistory,
  handleCreateEvalTask,
  handleRunEvalTask,
  handleSetApprovalPolicy,
};
