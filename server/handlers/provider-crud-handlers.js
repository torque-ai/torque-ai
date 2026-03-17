'use strict';

const { randomUUID } = require('crypto');
const db = require('../database');
const taskManager = require('../task-manager');
const { normalizeProviderTransport } = require('../db/provider-routing-core');
const { ErrorCodes, makeError } = require('./error-codes');
const credentialCrypto = require('../utils/credential-crypto');

const VALID_PROVIDER_TYPES = new Set(['ollama', 'cloud-cli', 'cloud-api', 'custom']);
const DEFAULT_MAX_CONCURRENT = 3;
const MAX_CONCURRENT_LIMIT = 100;
const DEFAULT_TRANSPORT_BY_TYPE = {
  ollama: 'api',
  'cloud-cli': 'cli',
  'cloud-api': 'api',
  custom: 'api',
};

function getDatabaseHandle() {
  if (typeof db.getDb === 'function') {
    return db.getDb();
  }
  if (typeof db.getDbInstance === 'function') {
    return db.getDbInstance();
  }
  return null;
}

function safeJsonParse(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch (_e) { void _e;
    return fallback;
  }
}

function makeCrudError(errorCode, detail, {
  code = 'operation_failed',
  status = 400,
  details = {},
} = {}) {
  const base = makeError(errorCode, detail, Object.keys(details).length > 0 ? details : null);
  return {
    ...base,
    code,
    status,
    details,
  };
}

function normalizeRequiredString(value, fieldName) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw makeCrudError(
      ErrorCodes.MISSING_REQUIRED_PARAM,
      `${fieldName} is required`,
      { code: 'validation_error', status: 400, details: { field: fieldName } },
    );
  }
  return normalized;
}

function normalizeOptionalString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeInteger(value, fieldName, {
  defaultValue = undefined,
  min = Number.MIN_SAFE_INTEGER,
  max = Number.MAX_SAFE_INTEGER,
} = {}) {
  if (value === undefined || value === null || value === '') {
    return defaultValue;
  }

  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw makeCrudError(
      ErrorCodes.INVALID_PARAM,
      `${fieldName} must be an integer`,
      { code: 'validation_error', status: 400, details: { field: fieldName, value } },
    );
  }

  if (value < min || value > max) {
    throw makeCrudError(
      ErrorCodes.INVALID_PARAM,
      `${fieldName} must be between ${min} and ${max}`,
      { code: 'validation_error', status: 400, details: { field: fieldName, value, min, max } },
    );
  }

  return value;
}

function normalizeModels(models) {
  if (models === undefined || models === null) {
    return [];
  }

  if (!Array.isArray(models)) {
    throw makeCrudError(
      ErrorCodes.INVALID_PARAM,
      'models must be an array of strings',
      { code: 'validation_error', status: 400, details: { field: 'models' } },
    );
  }

  const normalized = models
    .map((model) => (typeof model === 'string' ? model.trim() : ''))
    .filter(Boolean);

  if (normalized.length !== models.length) {
    throw makeCrudError(
      ErrorCodes.INVALID_PARAM,
      'models must contain only non-empty strings',
      { code: 'validation_error', status: 400, details: { field: 'models' } },
    );
  }

  return [...new Set(normalized)];
}

function resolveTransport(providerName, providerType, transport) {
  if (transport === undefined || transport === null || transport === '') {
    return DEFAULT_TRANSPORT_BY_TYPE[providerType] || normalizeProviderTransport(null, providerName);
  }

  const normalizedInput = String(transport).trim().toLowerCase();
  const normalizedTransport = normalizeProviderTransport(normalizedInput, providerName);
  if (normalizedTransport !== normalizedInput) {
    throw makeCrudError(
      ErrorCodes.INVALID_PARAM,
      `transport must be one of api, cli, hybrid`,
      { code: 'validation_error', status: 400, details: { field: 'transport', value: transport } },
    );
  }

  return normalizedTransport;
}

function getNextPriority(database) {
  const row = database.prepare('SELECT COALESCE(MAX(priority), 0) + 1 AS next_priority FROM provider_config').get();
  return Number.isFinite(Number(row?.next_priority)) ? Number(row.next_priority) : 1;
}

function getTaskSummary(database, provider) {
  const rows = database.prepare(`
    SELECT status, COUNT(*) AS count
    FROM tasks
    WHERE provider = ?
      AND status IN ('queued', 'running')
      AND archived = 0
    GROUP BY status
  `).all(provider);

  const summary = { queued: 0, running: 0, total: 0 };
  for (const row of rows) {
    summary[row.status] = Number(row.count) || 0;
    summary.total += Number(row.count) || 0;
  }

  return summary;
}

function getModelSummary(database, provider) {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN status = 'removed' THEN 1 ELSE 0 END) AS removed,
      SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved
    FROM model_registry
    WHERE provider = ?
  `).get(provider) || {};

  return {
    total: Number(row.total) || 0,
    pending: Number(row.pending) || 0,
    removed: Number(row.removed) || 0,
    approved: Number(row.approved) || 0,
  };
}

function getBestAvailableProvider(removedProvider, task = null) {
  const providers = typeof db.listProviders === 'function' ? db.listProviders() : [];
  const availableProviders = providers.filter((provider) => provider && provider.provider !== removedProvider);
  const enabledProviders = availableProviders.filter((provider) => provider.enabled);

  if (task && typeof db.analyzeTaskForRouting === 'function') {
    try {
      const routing = db.analyzeTaskForRouting(
        task.task_description || '',
        task.working_directory || null,
        [],
        {},
      );
      const candidate = typeof routing?.provider === 'string' ? routing.provider.trim() : '';
      if (candidate && enabledProviders.some((provider) => provider.provider === candidate)) {
        return candidate;
      }
    } catch (_e) { void _e;
      // Fall through to priority-based selection.
    }
  }

  return enabledProviders[0]?.provider || availableProviders[0]?.provider || null;
}

function ensureProviderExists(database, providerName) {
  const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
  if (!existing) {
    throw makeCrudError(
      ErrorCodes.RESOURCE_NOT_FOUND,
      `Provider not found: ${providerName}`,
      { code: 'provider_not_found', status: 404, details: { provider: providerName } },
    );
  }
}

function formatAddProviderText(result) {
  const parts = [
    `Provider \`${result.provider}\` created.`,
    `type=${result.provider_type}`,
    `transport=${result.transport}`,
    `max_concurrent=${result.max_concurrent}`,
  ];
  if (result.default_model) {
    parts.push(`default_model=${result.default_model}`);
  }
  if (result.models_registered > 0) {
    parts.push(`models_registered=${result.models_registered}`);
  }
  return parts.join(' ');
}

function formatRemovePreviewText(result) {
  return [
    `Provider \`${result.provider}\` can be removed.`,
    `Queued tasks: ${result.affected_tasks.queued}.`,
    `Running tasks: ${result.affected_tasks.running}.`,
    `Models tracked: ${result.affected_models.total}.`,
    'Re-run with confirm=true to delete it.',
  ].join(' ');
}

function formatRemoveConfirmText(result) {
  const parts = [
    `Provider \`${result.provider}\` removed.`,
    `Queued tasks rerouted: ${result.rerouted_tasks}.`,
    `Queued tasks left without a provider: ${result.unresolved_tasks}.`,
    `Running tasks unaffected: ${result.running_tasks}.`,
    `Models marked removed: ${result.affected_models.total}.`,
  ];
  if (result.default_provider_reassigned) {
    parts.push(`Default provider reassigned to \`${result.default_provider_reassigned}\`.`);
  }
  return parts.join(' ');
}

function encryptApiKey(plaintext) {
  if (!plaintext || typeof plaintext !== 'string') return null;
  const key = credentialCrypto.getOrCreateKey();
  const { encrypted_value, iv, auth_tag } = credentialCrypto.encrypt(plaintext, key);
  return `${iv}:${auth_tag}:${encrypted_value}`;
}

function decryptApiKey(packed) {
  if (!packed || typeof packed !== 'string' || !packed.includes(':')) return null;
  const parts = packed.split(':');
  if (parts.length !== 3) return null;
  try {
    const key = credentialCrypto.getOrCreateKey();
    const result = credentialCrypto.decrypt(parts[2], parts[0], parts[1], key);
    return typeof result === 'string' ? result : String(result);
  } catch {
    return null;
  }
}

function handleAddProvider(args = {}) {
  try {
    const database = getDatabaseHandle();
    if (!database || typeof database.prepare !== 'function') {
      return makeCrudError(ErrorCodes.DATABASE_ERROR, 'Database is not available', {
        code: 'operation_failed',
        status: 500,
      });
    }

    const providerName = normalizeRequiredString(args.name, 'name');
    const providerType = normalizeRequiredString(args.provider_type, 'provider_type');
    if (!VALID_PROVIDER_TYPES.has(providerType)) {
      return makeCrudError(
        ErrorCodes.INVALID_PARAM,
        `provider_type must be one of ${[...VALID_PROVIDER_TYPES].join(', ')}`,
        { code: 'validation_error', status: 400, details: { field: 'provider_type', value: providerType } },
      );
    }

    const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
    if (existing) {
      return makeCrudError(
        ErrorCodes.CONFLICT,
        `Provider already exists: ${providerName}`,
        { code: 'provider_conflict', status: 409, details: { provider: providerName } },
      );
    }

    const maxConcurrent = normalizeInteger(args.max_concurrent, 'max_concurrent', {
      defaultValue: DEFAULT_MAX_CONCURRENT,
      min: 1,
      max: MAX_CONCURRENT_LIMIT,
    });
    const priority = normalizeInteger(args.priority, 'priority', {
      defaultValue: getNextPriority(database),
      min: 0,
      max: 1000,
    });
    const transport = resolveTransport(providerName, providerType, args.transport);
    const apiBaseUrl = normalizeOptionalString(args.api_base_url);
    const apiKey = normalizeOptionalString(args.api_key);
    const defaultModel = normalizeOptionalString(args.default_model);
    const models = normalizeModels(args.models);
    const cliPath = providerType === 'cloud-cli' ? providerName : null;
    const now = new Date().toISOString();

    const insertProvider = database.transaction(() => {
      database.prepare(`
        INSERT INTO provider_config (
          provider,
          enabled,
          priority,
          cli_path,
          transport,
          quota_error_patterns,
          max_concurrent,
          created_at,
          updated_at,
          api_base_url,
          api_key_encrypted,
          provider_type,
          default_model
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        providerName,
        1,
        priority,
        cliPath,
        transport,
        JSON.stringify([]),
        maxConcurrent,
        now,
        now,
        apiBaseUrl,
        apiKey ? encryptApiKey(apiKey) : null,
        providerType,
        defaultModel,
      );

      for (const modelName of models) {
        const existingModel = database.prepare(`
          SELECT id
          FROM model_registry
          WHERE provider = ?
            AND COALESCE(host_id, '') = ''
            AND model_name = ?
          LIMIT 1
        `).get(providerName, modelName);

        if (existingModel) {
          database.prepare(`
            UPDATE model_registry
            SET status = 'pending',
                first_seen_at = COALESCE(first_seen_at, ?),
                last_seen_at = ?,
                approved_at = NULL,
                approved_by = NULL
            WHERE id = ?
          `).run(now, now, existingModel.id);
          continue;
        }

        database.prepare(`
          INSERT INTO model_registry (
            id,
            provider,
            host_id,
            model_name,
            status,
            first_seen_at,
            last_seen_at
          ) VALUES (?, ?, NULL, ?, 'pending', ?, ?)
        `).run(randomUUID(), providerName, modelName, now, now);
      }
    });

    insertProvider();

    const result = {
      provider: providerName,
      created: true,
      provider_type: providerType,
      api_base_url: apiBaseUrl,
      max_concurrent: maxConcurrent,
      default_model: defaultModel,
      priority,
      transport,
      models_registered: models.length,
      models,
    };

    return {
      ...result,
      content: [{ type: 'text', text: formatAddProviderText(result) }],
    };
  } catch (error) {
    if (error && error.isError) {
      return error;
    }
    return makeCrudError(ErrorCodes.OPERATION_FAILED, error.message || String(error), {
      code: 'operation_failed',
      status: 500,
    });
  }
}

function handleRemoveProvider(args = {}) {
  try {
    const database = getDatabaseHandle();
    if (!database || typeof database.prepare !== 'function') {
      return makeCrudError(ErrorCodes.DATABASE_ERROR, 'Database is not available', {
        code: 'operation_failed',
        status: 500,
      });
    }

    const providerName = normalizeRequiredString(args.provider, 'provider');
    ensureProviderExists(database, providerName);

    const affectedTasks = getTaskSummary(database, providerName);
    const affectedModels = getModelSummary(database, providerName);

    if (args.confirm !== true) {
      const preview = {
        provider: providerName,
        confirm_required: true,
        affected_tasks: affectedTasks,
        affected_models: affectedModels,
      };

      return {
        ...preview,
        content: [{ type: 'text', text: formatRemovePreviewText(preview) }],
      };
    }

    const removalResult = database.transaction(() => {
      ensureProviderExists(database, providerName);

      const queuedTasks = database.prepare(`
        SELECT id, provider, original_provider, task_description, working_directory, metadata
        FROM tasks
        WHERE provider = ?
          AND status = 'queued'
          AND archived = 0
        ORDER BY created_at ASC
      `).all(providerName);

      const defaultProviderRow = database.prepare(`
        SELECT value
        FROM config
        WHERE key = 'default_provider'
      `).get();
      const currentDefaultProvider = typeof defaultProviderRow?.value === 'string'
        ? defaultProviderRow.value
        : null;

      const now = new Date().toISOString();
      let reroutedTasks = 0;
      let unresolvedTasks = 0;

      database.prepare(`
        UPDATE model_registry
        SET status = 'removed',
            last_seen_at = ?
        WHERE provider = ?
      `).run(now, providerName);

      database.prepare('DELETE FROM provider_config WHERE provider = ?').run(providerName);

      for (const task of queuedTasks) {
        const nextProvider = getBestAvailableProvider(providerName, task);
        const metadata = safeJsonParse(task.metadata, {});
        metadata.provider_removed = true;
        metadata.removed_provider = providerName;

        if (nextProvider) {
          database.prepare(`
            UPDATE tasks
            SET provider = ?,
                model = NULL,
                original_provider = COALESCE(original_provider, ?),
                provider_switched_at = ?,
                metadata = ?
            WHERE id = ?
          `).run(
            nextProvider,
            providerName,
            now,
            JSON.stringify(metadata),
            task.id,
          );
          reroutedTasks += 1;
          continue;
        }

        database.prepare(`
          UPDATE tasks
          SET provider = NULL,
              model = NULL,
              original_provider = COALESCE(original_provider, ?),
              provider_switched_at = ?,
              metadata = ?
          WHERE id = ?
        `).run(
          providerName,
          now,
          JSON.stringify(metadata),
          task.id,
        );
        unresolvedTasks += 1;
      }

      let defaultProviderReassigned = null;
      if (currentDefaultProvider === providerName) {
        defaultProviderReassigned = getBestAvailableProvider(providerName, null);
        if (defaultProviderReassigned) {
          database.prepare(`
            INSERT INTO config (key, value)
            VALUES ('default_provider', ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
          `).run(defaultProviderReassigned);
        } else {
          database.prepare(`DELETE FROM config WHERE key = 'default_provider'`).run();
        }
      }

      return {
        reroutedTasks,
        unresolvedTasks,
        defaultProviderReassigned,
      };
    })();

    try {
      if (typeof taskManager.processQueue === 'function') {
        taskManager.processQueue();
      }
    } catch (_e) { void _e;
      // Non-fatal: queued tasks will still be picked up by the scheduler loop.
    }

    const result = {
      provider: providerName,
      deleted: true,
      affected_tasks: affectedTasks,
      affected_models: affectedModels,
      rerouted_tasks: removalResult.reroutedTasks,
      unresolved_tasks: removalResult.unresolvedTasks,
      running_tasks: affectedTasks.running,
      default_provider_reassigned: removalResult.defaultProviderReassigned,
    };

    return {
      ...result,
      content: [{ type: 'text', text: formatRemoveConfirmText(result) }],
    };
  } catch (error) {
    if (error && error.isError) {
      return error;
    }
    return makeCrudError(ErrorCodes.OPERATION_FAILED, error.message || String(error), {
      code: 'operation_failed',
      status: 500,
    });
  }
}

// ── API Key Management ──────────────────────────────────────────────────

const validatingProviders = new Map();
const VALIDATION_TIMEOUT_MS = 30000;

const API_KEY_ENV_VARS = {
  anthropic: 'ANTHROPIC_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY',
  'google-ai': 'GOOGLE_AI_API_KEY', 'ollama-cloud': 'OLLAMA_CLOUD_API_KEY',
  openrouter: 'OPENROUTER_API_KEY', deepinfra: 'DEEPINFRA_API_KEY',
  hyperbolic: 'HYPERBOLIC_API_KEY', codex: 'OPENAI_API_KEY',
};

function getApiKeyStatus(providerName) {
  // Check validation timeout
  const validatingTs = validatingProviders.get(providerName);
  if (validatingTs && (Date.now() - validatingTs) < VALIDATION_TIMEOUT_MS) {
    return 'validating';
  }
  if (validatingTs) validatingProviders.delete(providerName);

  // Check env var
  const envVar = API_KEY_ENV_VARS[providerName];
  if (envVar && process.env[envVar]) return 'env';

  // Check DB encrypted key
  const database = getDatabaseHandle();
  if (database) {
    try {
      const row = database.prepare('SELECT api_key_encrypted FROM provider_config WHERE provider = ?').get(providerName);
      if (row && row.api_key_encrypted) {
        const decrypted = decryptApiKey(row.api_key_encrypted);
        if (decrypted) return 'stored';
      }
    } catch { /* table may not exist */ }
  }

  return 'not_set';
}

function handleSetApiKey(args) {
  const providerName = normalizeRequiredString(args.provider, 'provider');
  const apiKey = typeof args.api_key === 'string' ? args.api_key.trim() : '';

  if (!apiKey) {
    return makeCrudError(ErrorCodes.MISSING_REQUIRED_PARAM, 'api_key is required', { code: 'validation_error', status: 400 });
  }
  if (apiKey.length > 256) {
    return makeCrudError(ErrorCodes.INVALID_PARAM, 'api_key must be 256 characters or fewer', { code: 'validation_error', status: 400 });
  }

  const database = getDatabaseHandle();
  if (!database) {
    return makeCrudError(ErrorCodes.INTERNAL_ERROR, 'Database not available', { code: 'operation_failed', status: 500 });
  }

  const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
  if (!existing) {
    return makeCrudError(ErrorCodes.RESOURCE_NOT_FOUND, `Provider not found: ${providerName}`, { code: 'provider_not_found', status: 404 });
  }

  const encrypted = encryptApiKey(apiKey);
  database.prepare("UPDATE provider_config SET api_key_encrypted = ?, updated_at = datetime('now') WHERE provider = ?").run(encrypted, providerName);

  // Invalidate caches so provider reconstructs with the new key
  try {
    const { invalidateAdapterCache } = require('../providers/adapter-registry');
    if (typeof invalidateAdapterCache === 'function') invalidateAdapterCache(providerName);
  } catch { /* best effort */ }
  try {
    const providerRegistry = require('../providers/registry');
    if (typeof providerRegistry.resetInstances === 'function') providerRegistry.resetInstances();
  } catch { /* best effort */ }

  // Mark as validating and trigger async health check
  validatingProviders.set(providerName, Date.now());
  try {
    const hostMonitoring = require('../utils/host-monitoring');
    if (typeof hostMonitoring.runHostHealthChecks === 'function') {
      hostMonitoring.runHostHealthChecks().finally(() => {
        validatingProviders.delete(providerName);
      });
    } else {
      setTimeout(() => validatingProviders.delete(providerName), VALIDATION_TIMEOUT_MS);
    }
  } catch {
    setTimeout(() => validatingProviders.delete(providerName), VALIDATION_TIMEOUT_MS);
  }

  let masked = '••••••';
  try {
    const { redactValue } = require('../utils/sensitive-keys');
    if (typeof redactValue === 'function') masked = redactValue(apiKey);
  } catch { /* best effort */ }

  const logger = require('../logger');
  logger.info(`API key set for provider ${providerName}`);

  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'saved', masked, validating: true }) }],
  };
}

function handleClearApiKey(args) {
  const providerName = normalizeRequiredString(args.provider, 'provider');
  const database = getDatabaseHandle();
  if (!database) {
    return makeCrudError(ErrorCodes.INTERNAL_ERROR, 'Database not available', { code: 'operation_failed', status: 500 });
  }

  const existing = database.prepare('SELECT provider FROM provider_config WHERE provider = ?').get(providerName);
  if (!existing) {
    return makeCrudError(ErrorCodes.RESOURCE_NOT_FOUND, `Provider not found: ${providerName}`, { code: 'provider_not_found', status: 404 });
  }

  database.prepare("UPDATE provider_config SET api_key_encrypted = NULL, updated_at = datetime('now') WHERE provider = ?").run(providerName);
  validatingProviders.delete(providerName);

  // Invalidate caches
  try {
    const { invalidateAdapterCache } = require('../providers/adapter-registry');
    if (typeof invalidateAdapterCache === 'function') invalidateAdapterCache(providerName);
  } catch { /* best effort */ }
  try {
    const providerRegistry = require('../providers/registry');
    if (typeof providerRegistry.resetInstances === 'function') providerRegistry.resetInstances();
  } catch { /* best effort */ }

  const logger = require('../logger');
  logger.info(`API key cleared for provider ${providerName}`);

  return {
    content: [{ type: 'text', text: JSON.stringify({ status: 'cleared' }) }],
  };
}

module.exports = {
  handleAddProvider,
  handleRemoveProvider,
  handleSetApiKey,
  handleClearApiKey,
  encryptApiKey,
  decryptApiKey,
  getApiKeyStatus,
  validatingProviders,
};
