'use strict';

const logger = require('../logger').child({ component: 'openrouter-scout' });
const providerModelScores = require('../db/provider/model-scores');
const { parseToolCalls } = require('../providers/ollama-tools');

const PROVIDER = 'openrouter';
const DEFAULT_LIMIT = 60;
const DEFAULT_MIN_ROLE_SCORE = 45;

const NON_CHAT_HINTS = [
  /\baudio\b/i,
  /\bclip\b/i,
  /\bembed(?:ding)?s?\b/i,
  /\bimage\b/i,
  /\blyria\b/i,
  /\bmoderation\b/i,
  /\bocr\b/i,
  /\brerank\b/i,
  /\btts\b/i,
  /\bvision\b/i,
];

const QUALITY_HINTS = [
  [/coder|code|deepseek|qwen|kimi|k2|minimax|mistral|mixtral|nemotron|qwen|glm|llama|hermes|gemma|sonar|dolphin|nous|inclusion|ling/i, 14],
  [/reason|thinking|r1|o1|o3|instruct/i, 8],
  [/flash|fast|mini|small|nano|lite/i, 4],
];

function modelNameOf(model) {
  if (typeof model === 'string') return model.trim();
  return String(model?.model_name || model?.modelName || model?.id || model?.name || model?.model || '').trim();
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeSupportedParameters(model) {
  if (Array.isArray(model?.supported_parameters)) return model.supported_parameters;
  if (Array.isArray(model?.supportedParameters)) return model.supportedParameters;
  return [];
}

function normalizeSupportedParameterValues(rawParameters) {
  const list = Array.isArray(rawParameters) ? rawParameters : normalizeSupportedParameters(rawParameters);
  return Array.isArray(list)
    ? list
      .map((value) => {
        if (typeof value === 'string') return value.trim().toLowerCase();
        if (value && typeof value === 'object' && typeof value.name === 'string') return value.name.trim().toLowerCase();
        return '';
      })
      .filter(Boolean)
    : [];
}

function supportsResponseFormatMetadata(model) {
  const supportedParameters = normalizeSupportedParameterValues(model?.supported_parameters || model?.supportedParameters);
  return supportedParameters.some((parameter) => {
    if (parameter === 'response_format') return true;
    if (parameter === 'json_schema') return true;
    if (parameter.includes('response_format')) return true;
    return false;
  });
}

function supportsTools(model) {
  if (model?.supports_tools === true || model?.supportsTools === true) return true;
  return normalizeSupportedParameterValues(model).some((parameter) => parameter === 'tools');
}

function parseZeroPrice(value) {
  if (value === 0 || value === '0') return true;
  if (value === null || value === undefined || value === '') return false;
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric === 0;
}

function isFreeModel(model) {
  const name = modelNameOf(model);
  if (model?.free === true || /:free$/i.test(name)) return true;
  const pricing = model?.pricing;
  return !!pricing && parseZeroPrice(pricing.prompt) && parseZeroPrice(pricing.completion);
}

function contextWindowOf(model) {
  return numberOrNull(model?.context_window ?? model?.contextWindow ?? model?.context_length ?? model?.contextLength);
}

function isProbablyNonChat(model) {
  const haystack = [
    modelNameOf(model),
    model?.name,
    model?.owned_by,
    model?.architecture?.modality,
    model?.description,
  ].filter(Boolean).join(' ');
  return NON_CHAT_HINTS.some((pattern) => pattern.test(haystack));
}

function clampScore(score) {
  if (!Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(100, Math.round(score * 1000) / 1000));
}

function scoreOpenRouterModel(model) {
  const name = modelNameOf(model);
  const reasons = [];
  let score = 20;

  if (!name) {
    return {
      provider: PROVIDER,
      model_name: '',
      score: 0,
      score_reason: 'missing_model_name',
      smoke_status: 'metadata_skip',
      tool_call_ok: 0,
      read_only_ok: 0,
      rate_limited: 0,
      metadata: model,
    };
  }

  if (isFreeModel(model)) {
    score += 24;
    reasons.push('free');
  } else {
    score -= 35;
    reasons.push('paid_or_unknown_pricing');
  }

  const tools = supportsTools(model);
  if (tools) {
    score += 22;
    reasons.push('tools_metadata');
  }

  const contextWindow = contextWindowOf(model);
  if (contextWindow) {
    const contextScore = Math.min(14, Math.max(0, Math.log2(Math.max(contextWindow, 4096) / 4096) * 3.5));
    score += contextScore;
    reasons.push(`context_${contextWindow}`);
  }

  for (const [pattern, weight] of QUALITY_HINTS) {
    if (pattern.test(name)) {
      score += weight;
      reasons.push(`hint_${pattern.source.split('|')[0]}`);
    }
  }

  const nonChat = isProbablyNonChat(model);
  if (nonChat) {
    score -= 55;
    reasons.push('non_chat_hint');
  }

  if (/^openrouter\/free$/i.test(name)) {
    score -= 8;
    reasons.push('router_alias');
  }

  const finalScore = clampScore(score);
  const smokeStatus = nonChat
    ? 'metadata_skip'
    : finalScore >= DEFAULT_MIN_ROLE_SCORE
      ? 'metadata_pass'
      : 'metadata_review';

  return {
    provider: PROVIDER,
    model_name: name,
    score: finalScore,
    score_reason: reasons.join(','),
    smoke_status: smokeStatus,
    tool_call_ok: tools ? 1 : 0,
    read_only_ok: nonChat ? 0 : 1,
    rate_limited: 0,
    metadata: {
      id: name,
      name: model?.name || null,
      owned_by: model?.owned_by || null,
      context_window: contextWindow,
      supported_parameters: normalizeSupportedParameterValues(model),
      supports_response_format: supportsResponseFormatMetadata(model),
      free: isFreeModel(model),
    },
  };
}

function scoreOpenRouterModels(models, options = {}) {
  const limit = Number.isFinite(Number(options.limit)) ? Math.max(1, Number(options.limit)) : DEFAULT_LIMIT;
  return (Array.isArray(models) ? models : [])
    .map(scoreOpenRouterModel)
    .filter((row) => row.model_name)
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return a.model_name.localeCompare(b.model_name);
    })
    .slice(0, limit);
}

function hasApprovedModel(db, provider, modelName) {
  try {
    return !!db.prepare(`
      SELECT 1
      FROM model_registry
      WHERE provider = ?
        AND model_name = ?
        AND status = 'approved'
      LIMIT 1
    `).get(provider, modelName);
  } catch {
    return true;
  }
}

function hasLivePassSignal(row) {
  return row?.smoke_status === 'pass' && row?.rate_limited !== 1;
}

function roleCandidateRows(db, scoredRows, minScore, options = {}) {
  const requireLivePass = options.requireLivePass !== false;
  return scoredRows
    .filter((row) => row.score >= minScore)
    .filter((row) => row.rate_limited !== 1)
    .filter((row) => row.smoke_status !== 'fail' && row.smoke_status !== 'rate_limited' && row.smoke_status !== 'metadata_skip')
    .filter((row) => !requireLivePass || hasLivePassSignal(row))
    .filter((row) => hasApprovedModel(db, PROVIDER, row.model_name));
}

function pickUnique(candidates, used, predicate = () => true) {
  const found = candidates.find((row) => !used.has(row.model_name) && predicate(row));
  if (!found) return null;
  used.add(found.model_name);
  return found;
}

function setRole(db, role, row) {
  if (!row) return null;
  db.prepare(`
    INSERT OR REPLACE INTO model_roles (provider, role, model_name, updated_at)
    VALUES (?, ?, ?, datetime('now'))
  `).run(PROVIDER, role, row.model_name);
  return { role, model: row.model_name, score: row.score };
}

function assignOpenRouterRoles(db, scoredRows, options = {}) {
  const minScore = Number.isFinite(Number(options.minScore)) ? Number(options.minScore) : DEFAULT_MIN_ROLE_SCORE;
  const requireLivePass = options.requireLivePass !== false;
  const candidates = roleCandidateRows(db, scoredRows, minScore, { requireLivePass });
  if (candidates.length === 0) return [];

  const byScore = [...candidates].sort((a, b) => b.score - a.score || a.model_name.localeCompare(b.model_name));
  const byFastHint = [...candidates].sort((a, b) => {
    const fastA = /flash|fast|mini|small|nano|lite|1\.2b|3b|4b/i.test(a.model_name) ? 1 : 0;
    const fastB = /flash|fast|mini|small|nano|lite|1\.2b|3b|4b/i.test(b.model_name) ? 1 : 0;
    if (fastA !== fastB) return fastB - fastA;
    return b.score - a.score || a.model_name.localeCompare(b.model_name);
  });
  const byTool = [...candidates].sort((a, b) => {
    if (a.tool_call_ok !== b.tool_call_ok) return b.tool_call_ok - a.tool_call_ok;
    return b.score - a.score || a.model_name.localeCompare(b.model_name);
  });

  const used = new Set();
  const assignments = [];

  const defaultRow = pickUnique(byTool, used) || byScore[0];
  assignments.push(setRole(db, 'default', defaultRow));

  const fallbackRow = pickUnique(byScore, used);
  if (fallbackRow) assignments.push(setRole(db, 'fallback', fallbackRow));

  const fastRow = pickUnique(byFastHint, used);
  if (fastRow) assignments.push(setRole(db, 'fast', fastRow));

  const qualityRow = pickUnique(byScore, used) || byScore[0];
  assignments.push(setRole(db, 'quality', qualityRow));

  const balancedRow = pickUnique(byScore, used) || defaultRow;
  assignments.push(setRole(db, 'balanced', balancedRow));

  return assignments.filter(Boolean);
}

function mergeSmokeResult(row, smokeResult) {
  if (!smokeResult) return row;
  const next = { ...row };

  next.latency_ms = smokeResult.latency_ms ?? row.latency_ms ?? null;
  next.first_response_ms = smokeResult.first_response_ms ?? next.latency_ms ?? null;
  next.tool_call_ok = smokeResult.tool_call_ok ? 1 : row.tool_call_ok;
  next.read_only_ok = smokeResult.read_only_ok ? 1 : row.read_only_ok;
  next.rate_limited = smokeResult.rate_limited ? 1 : 0;
  next.error = smokeResult.error || null;

  if (smokeResult.rate_limited) {
    next.score = clampScore(row.score - 25);
    next.smoke_status = 'rate_limited';
  } else if (smokeResult.ok) {
    next.score = clampScore(row.score + (smokeResult.tool_call_ok ? 12 : 5));
    next.smoke_status = 'pass';
  } else {
    next.score = clampScore(row.score - 30);
    next.smoke_status = 'fail';
  }

  next.score_reason = [row.score_reason, smokeResult.reason].filter(Boolean).join(',');
  return next;
}

function messageCallsListDirectory(message) {
  try {
    const parsedCalls = parseToolCalls(message || {});
    return Array.isArray(parsedCalls) && parsedCalls.some((call) => String(call?.name || '').toLowerCase() === 'list_directory');
  } catch {
    return false;
  }
}

function isRateLimitError(error) {
  const message = String(error?.message || '').toLowerCase();
  return /\b429\b|rate.?limit|quota|too many requests/.test(message);
}

async function smokeOneModel({ modelName, apiKey, host, chatCompletion, timeoutMs }) {
  const startedAt = Date.now();
  try {
    const result = await chatCompletion({
      host,
      apiKey,
      model: modelName,
      providerName: PROVIDER,
      messages: [
        { role: 'system', content: 'You are testing tool-call support. Use tools when asked.' },
        { role: 'user', content: 'Call the list_directory tool with path ".". Do not answer in prose.' },
      ],
      tools: [{
        type: 'function',
        function: {
          name: 'list_directory',
          description: 'List a directory.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      }],
      options: { temperature: 0, stream: false, providerName: PROVIDER },
      timeoutMs,
    });

    const toolCalls = Array.isArray(result?.message?.tool_calls) ? result.message.tool_calls : [];
    const toolCallOk = toolCalls.some((call) => String(call?.function?.name || '').toLowerCase() === 'list_directory')
      || messageCallsListDirectory(result.message);
    const content = String(result?.message?.content || '');
    return {
      ok: toolCallOk || content.length > 0,
      tool_call_ok: toolCallOk,
      read_only_ok: true,
      latency_ms: Date.now() - startedAt,
      first_response_ms: Date.now() - startedAt,
      reason: toolCallOk ? 'live_tool_smoke' : 'live_text_smoke',
    };
  } catch (error) {
    return {
      ok: false,
      rate_limited: isRateLimitError(error),
      latency_ms: Date.now() - startedAt,
      first_response_ms: Date.now() - startedAt,
      error: String(error?.message || error).slice(0, 500),
      reason: isRateLimitError(error) ? 'live_rate_limited' : 'live_smoke_failed',
    };
  }
}

async function applyLiveSmoke(scoredRows, options = {}) {
  const smokeLimit = Number.isFinite(Number(options.smokeLimit)) ? Math.max(0, Number(options.smokeLimit)) : 0;
  if (smokeLimit <= 0) return scoredRows;

  const apiKey = options.apiKey || options.providerInstance?.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return scoredRows;

  const chatCompletion = options.chatCompletion || require('../providers/adapters/openai-chat').chatCompletion;
  const host = options.host || options.providerInstance?.baseUrl || 'https://openrouter.ai/api';
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 30000;
  const smokeModels = scoredRows
    .filter((row) => row.smoke_status !== 'metadata_skip')
    .slice(0, smokeLimit);
  const smokeByModel = new Map();

  for (const row of smokeModels) {
    const result = await smokeOneModel({
      modelName: row.model_name,
      apiKey,
      host,
      chatCompletion,
      timeoutMs,
    });
    smokeByModel.set(row.model_name, result);
  }

  return scoredRows
    .map((row) => mergeSmokeResult(row, smokeByModel.get(row.model_name)))
    .sort((a, b) => b.score - a.score || a.model_name.localeCompare(b.model_name));
}

async function runOpenRouterScout(options = {}) {
  const db = options.db;
  if (db) providerModelScores.init(db);

  let models = Array.isArray(options.models) ? options.models : null;
  if (!models && options.adapter && typeof options.adapter.discoverModels === 'function') {
    const discovered = await options.adapter.discoverModels();
    models = discovered?.models || [];
  }

  let scored = scoreOpenRouterModels(models || [], { limit: options.limit || DEFAULT_LIMIT });
  scored = await applyLiveSmoke(scored, options);

  const stored = providerModelScores.upsertModelScores(scored, { preserveLiveOutcome: true });
  const rolesAssigned = options.assignRoles === false || !db
    ? []
    : assignOpenRouterRoles(db, stored, {
      minScore: options.minRoleScore,
      requireLivePass: options.requireLivePass,
    });

  if (rolesAssigned.length > 0) {
    logger.info(`OpenRouter scout assigned roles: ${rolesAssigned.map((row) => `${row.role}=${row.model}`).join(', ')}`);
  }

  return {
    provider: PROVIDER,
    scored: stored.length,
    roles_assigned: rolesAssigned,
    live_pass_required: options.requireLivePass !== false,
    top_models: stored.slice(0, 5).map((row) => ({
      model_name: row.model_name,
      score: row.score,
      smoke_status: row.smoke_status,
    })),
  };
}

module.exports = {
  assignOpenRouterRoles,
  runOpenRouterScout,
  scoreOpenRouterModel,
  scoreOpenRouterModels,
  _smokeOneModel: smokeOneModel,
};
