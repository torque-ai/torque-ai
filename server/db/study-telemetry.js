'use strict';

const path = require('path');

const database = require('../database');
const costTracking = require('./cost-tracking');
const eventTracking = require('./event-tracking');
const { readStudyArtifacts } = require('../integrations/codebase-study-engine');

const STUDY_EVENT_TYPES = Object.freeze([
  'study_task_submitted',
  'study_task_completed',
  'study_review_submitted',
  'study_review_completed',
]);
const DEFAULT_RECOMMENDED_PROPOSAL_LIMIT = 2;
const MIN_COMPARISON_SAMPLE_SIZE = 2;

function toRepoPath(value) {
  return String(value || '').trim().replace(/\\/g, '/');
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = String(value || '').trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function uniquePaths(values) {
  const seen = new Set();
  const output = [];
  for (const value of Array.isArray(values) ? values : []) {
    const normalized = toRepoPath(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    output.push(normalized);
  }
  return output;
}

function roundTo(value, places = 2) {
  const factor = 10 ** places;
  return Math.round((Number(value) || 0) * factor) / factor;
}

function parseMetadata(rawMetadata) {
  if (!rawMetadata) {
    return {};
  }
  if (typeof rawMetadata === 'object' && !Array.isArray(rawMetadata)) {
    return { ...rawMetadata };
  }
  if (typeof rawMetadata !== 'string') {
    return {};
  }
  try {
    const parsed = JSON.parse(rawMetadata);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...parsed }
      : {};
  } catch {
    return {};
  }
}

function parseFilesModified(rawFilesModified) {
  if (Array.isArray(rawFilesModified)) {
    return rawFilesModified.filter((value) => typeof value === 'string' && value.trim());
  }
  if (typeof rawFilesModified !== 'string' || !rawFilesModified.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawFilesModified);
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === 'string' && value.trim())
      : [];
  } catch {
    return [];
  }
}

function normalizeWorkingDirectory(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const resolved = path.resolve(value.trim());
  return process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

function sumTokenUsage(taskId) {
  if (!taskId || typeof costTracking.getTaskTokenUsage !== 'function') {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
    };
  }
  let rows = [];
  try {
    rows = costTracking.getTaskTokenUsage(taskId) || [];
  } catch {
    rows = [];
  }
  return rows.reduce((totals, row) => ({
    input_tokens: totals.input_tokens + (Number(row?.input_tokens) || 0),
    output_tokens: totals.output_tokens + (Number(row?.output_tokens) || 0),
    total_tokens: totals.total_tokens + (Number(row?.total_tokens) || 0),
    cost_usd: totals.cost_usd + (Number(row?.estimated_cost_usd ?? row?.cost_usd) || 0),
  }), {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  });
}

function countProviderSwitches(task, metadata) {
  const history = Array.isArray(metadata?.provider_switch_history)
    ? metadata.provider_switch_history
    : [];
  if (history.length > 0) {
    return history.length;
  }
  const originalProvider = typeof metadata?.original_provider === 'string' && metadata.original_provider.trim()
    ? metadata.original_provider.trim()
    : (typeof task?.original_provider === 'string' && task.original_provider.trim()
      ? task.original_provider.trim()
      : '');
  const currentProvider = typeof task?.provider === 'string' && task.provider.trim()
    ? task.provider.trim()
    : '';
  return originalProvider && currentProvider && originalProvider !== currentProvider ? 1 : 0;
}

function extractReviewVerdict(output) {
  const text = String(output || '');
  if (/VERDICT:\s*FLAG/i.test(text)) {
    return 'flag';
  }
  if (/VERDICT:\s*APPROVE/i.test(text)) {
    return 'approve';
  }
  return null;
}

function countReviewFindings(output) {
  const text = String(output || '');
  const matches = text.match(/(?:^|\n)\s*(?:[-*]\s*)?(?:\d+\.\s+)?(?:\*\*)?(CRITICAL|IMPORTANT|SUGGESTION)(?:\*\*)?/gim);
  return Array.isArray(matches) ? matches.length : 0;
}

function isRepoBriefingTask(description) {
  const text = String(description || '').toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /read-only|briefing|repo map|repo briefing|understand/i.test(text)
    || (/entrypoint|entry point/i.test(text) && /validation|command|subsystem|risk/i.test(text))
  );
}

function extractReferencedPaths(text) {
  const matches = String(text || '').match(/[\w./\\-]+\.[a-z0-9]{1,8}(?:\.[a-z0-9]{1,8})?/gi) || [];
  return uniquePaths(matches);
}

function extractListItems(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]|\d+[.)])\s+/.test(line))
    .map((line) => line.replace(/^(?:[-*]|\d+[.)])\s+/, '').trim())
    .filter(Boolean);
}

function extractRepoBriefingSections(outputText, {
  expectsSecondaryEntrypoint = false,
  expectsRisk = false,
  expectsValidation = false,
} = {}) {
  const items = extractListItems(outputText);
  if (items.length === 0) {
    return null;
  }

  const entrypointCount = expectsSecondaryEntrypoint ? 2 : 1;
  const entrypointItems = items.slice(0, entrypointCount);
  let cursor = entrypointItems.length;

  const hotspotText = expectsRisk && items.length > cursor ? items[cursor++] : '';
  const validationText = expectsValidation && items.length > cursor ? items[cursor] : '';

  return {
    items,
    entrypointText: entrypointItems.join('\n'),
    hotspotText,
    validationText,
  };
}

function collectPackValidationCommands(knowledgePack) {
  const commands = [];
  for (const playbook of Array.isArray(knowledgePack?.expertise?.change_playbooks) ? knowledgePack.expertise.change_playbooks : []) {
    commands.push(...(playbook?.validation_commands || []));
  }
  for (const item of Array.isArray(knowledgePack?.expertise?.impact_guidance) ? knowledgePack.expertise.impact_guidance : []) {
    commands.push(...(item?.validation_commands || []));
  }
  for (const area of Array.isArray(knowledgePack?.expertise?.test_matrix) ? knowledgePack.expertise.test_matrix : []) {
    commands.push(...(area?.validation_commands || []));
  }
  return uniqueStrings(commands);
}

function buildQualityExpectations(task, metadata) {
  const workingDirectory = normalizeWorkingDirectory(task?.working_directory);
  if (!workingDirectory) {
    return null;
  }

  const studySummary = metadata.study_context_summary && typeof metadata.study_context_summary === 'object'
    ? metadata.study_context_summary
    : null;
  const artifacts = readStudyArtifacts(workingDirectory, { includeKnowledgePack: true });
  const knowledgePack = artifacts?.knowledgePack || null;
  const entrypointFiles = uniquePaths([
    ...(studySummary?.entrypoint_files || []),
    ...((knowledgePack?.entrypoints || []).map((entry) => entry?.file)),
  ]).slice(0, 8);
  const hotspotFiles = uniquePaths([
    ...(studySummary?.hotspot_files || []),
    ...((knowledgePack?.hotspots || []).map((entry) => entry?.file)),
    ...((knowledgePack?.expertise?.impact_guidance || []).flatMap((entry) => entry?.related_files || [])),
  ]).slice(0, 10);
  const validationCommands = uniqueStrings([
    ...(studySummary?.validation_commands || []),
    ...collectPackValidationCommands(knowledgePack),
  ]).slice(0, 10);

  if (entrypointFiles.length === 0 && hotspotFiles.length === 0 && validationCommands.length === 0) {
    return null;
  }

  return {
    entrypoint_files: entrypointFiles,
    hotspot_files: hotspotFiles,
    validation_commands: validationCommands,
  };
}

function outputMentionsAnyPath(outputPaths, expectedPaths) {
  const normalizedOutput = uniquePaths(outputPaths);
  const expected = uniquePaths(expectedPaths);
  if (normalizedOutput.length === 0 || expected.length === 0) {
    return false;
  }
  const outputSet = new Set(normalizedOutput);
  const outputBasenames = new Set(normalizedOutput.map((filePath) => path.basename(filePath).toLowerCase()));
  return expected.some((filePath) => outputSet.has(filePath) || outputBasenames.has(path.basename(filePath).toLowerCase()));
}

function outputMentionsValidationCommand(outputText, commands) {
  const lower = String(outputText || '').toLowerCase();
  if (!lower.trim()) {
    return false;
  }
  for (const command of uniqueStrings(commands)) {
    const normalized = command.toLowerCase();
    if (lower.includes(normalized)) {
      return true;
    }
    const parts = normalized.split(/\s+/).filter(Boolean);
    if (parts.length >= 3) {
      const prefix = parts.slice(0, 3).join(' ');
      if (lower.includes(prefix)) {
        return true;
      }
    } else if (parts.length === 1 && lower.includes(parts[0])) {
      return true;
    }
  }
  return false;
}

function scoreTaskOutputQuality(task, metadata) {
  const description = String(task?.task_description || task?.description || '').trim();
  const outputText = String(task?.output || '').trim();
  if (!description || !outputText || metadata.review_task === true || !isRepoBriefingTask(description)) {
    return null;
  }

  const expectations = buildQualityExpectations(task, metadata);
  if (!expectations) {
    return null;
  }

  const outputPaths = extractReferencedPaths(outputText);
  const expectsSecondaryEntrypoint = /secondary important entrypoint|secondary entrypoint|startup surface/i.test(description);
  const expectsEntrypoint = /entrypoint|entry point|startup|bootstrap/i.test(description) && expectations.entrypoint_files.length > 0;
  const expectsRisk = /high-risk|high risk|risky|subsystem|hotspot|risk/i.test(description) && expectations.hotspot_files.length > 0;
  const expectsValidation = /validation command|validation|verify|test|command worth running/i.test(description) && expectations.validation_commands.length > 0;
  const briefingSections = extractRepoBriefingSections(outputText, {
    expectsSecondaryEntrypoint,
    expectsRisk,
    expectsValidation,
  });
  const entrypointPaths = extractReferencedPaths(briefingSections?.entrypointText || outputText);
  const hotspotPaths = extractReferencedPaths(briefingSections?.hotspotText || outputText);
  const validationText = briefingSections?.validationText || outputText;
  const entrypointHit = outputMentionsAnyPath(entrypointPaths.length > 0 ? entrypointPaths : outputPaths, expectations.entrypoint_files);
  const hotspotHit = outputMentionsAnyPath(hotspotPaths.length > 0 ? hotspotPaths : outputPaths, expectations.hotspot_files);
  const validationHit = outputMentionsValidationCommand(validationText, expectations.validation_commands);
  const reasoning = [];
  let score = 50;

  if (outputPaths.length > 0) {
    score += 5;
    reasoning.push(`Referenced ${outputPaths.length} repo path(s).`);
  }
  if (expectsEntrypoint) {
    if (entrypointHit) {
      score += 20;
      reasoning.push('Matched a studied entrypoint.');
    } else {
      score -= 18;
      reasoning.push('Missed the studied entrypoint surface.');
    }
  }
  if (expectsRisk) {
    if (hotspotHit) {
      score += 15;
      reasoning.push(briefingSections?.hotspotText
        ? 'Matched a studied hotspot or impact seam in the risk callout.'
        : 'Matched a studied hotspot or impact seam.');
    } else {
      score -= 10;
      reasoning.push(briefingSections?.hotspotText
        ? 'Did not anchor the risk callout to a studied seam.'
        : 'Did not anchor the output to a studied seam.');
    }
  }
  if (expectsValidation) {
    if (validationHit) {
      score += 15;
      reasoning.push(briefingSections?.validationText
        ? 'Included a studied validation command in the validation callout.'
        : 'Included a studied validation command.');
    } else {
      score -= 12;
      reasoning.push(briefingSections?.validationText
        ? 'Missed the studied validation command in the validation callout.'
        : 'Missed the studied validation surface.');
    }
  }
  if (/^(?:[-*]|\d+[.)])\s+/m.test(outputText)) {
    score += 3;
  }

  const normalizedScore = Math.max(0, Math.min(100, score));
  return {
    score: normalizedScore,
    label: normalizedScore >= 85 ? 'strong' : (normalizedScore >= 70 ? 'adequate' : 'weak'),
    reasoning,
  };
}

function buildOutcomePayload(task, phase = 'completed') {
  if (!task) {
    return null;
  }
  const metadata = parseMetadata(task.metadata);
  const workingDirectory = normalizeWorkingDirectory(task.working_directory);
  if (!workingDirectory) {
    return null;
  }
  const studySummary = metadata.study_context_summary && typeof metadata.study_context_summary === 'object'
    ? metadata.study_context_summary
    : null;
  const isReviewTask = metadata.review_task === true;
  const sourceStudySummary = metadata.source_study_context_summary && typeof metadata.source_study_context_summary === 'object'
    ? metadata.source_study_context_summary
    : null;
  const tokenUsage = phase === 'completed' ? sumTokenUsage(task.id) : {
    input_tokens: 0,
    output_tokens: 0,
    total_tokens: 0,
    cost_usd: 0,
  };
  const filesModified = parseFilesModified(task.files_modified);
  const outputQuality = phase === 'completed' ? scoreTaskOutputQuality(task, metadata) : null;

  return {
    task_id: task.id,
    working_directory: workingDirectory,
    project: typeof task.project === 'string' && task.project.trim() ? task.project.trim() : null,
    status: task.status || null,
    provider: task.provider || null,
    original_provider: task.original_provider || metadata.original_provider || null,
    model: task.model || null,
    retry_count: Number(task.retry_count) || 0,
    provider_switch_count: countProviderSwitches(task, metadata),
    files_modified_count: filesModified.length,
    study_context_applied: Boolean(studySummary),
    study_profile_id: studySummary?.study_profile_id || null,
    evaluation_grade: studySummary?.grade || null,
    evaluation_score: Number.isInteger(studySummary?.score) ? studySummary.score : null,
    benchmark_grade: studySummary?.benchmark_grade || null,
    benchmark_score: Number.isInteger(studySummary?.benchmark_score) ? studySummary.benchmark_score : null,
    input_tokens: tokenUsage.input_tokens,
    output_tokens: tokenUsage.output_tokens,
    total_tokens: tokenUsage.total_tokens,
    cost_usd: Math.round(tokenUsage.cost_usd * 1000000) / 1000000,
    review_task: isReviewTask,
    review_of_task_id: metadata.review_of_task_id || null,
    source_study_context_applied: sourceStudySummary ? true : Boolean(studySummary),
    source_study_profile_id: sourceStudySummary?.study_profile_id || studySummary?.study_profile_id || null,
    review_verdict: isReviewTask && phase === 'completed' ? extractReviewVerdict(task.output) : null,
    review_issue_count: isReviewTask && phase === 'completed' ? countReviewFindings(task.output) : 0,
    output_quality_score: outputQuality?.score ?? null,
    output_quality_label: outputQuality?.label || null,
    output_quality_reasoning: outputQuality?.reasoning || [],
    completed_at: task.completed_at || null,
    submitted_at: task.created_at || null,
  };
}

function recordStudyTaskSubmitted(task) {
  const payload = buildOutcomePayload(task, 'submitted');
  if (!payload) {
    return false;
  }
  const eventType = payload.review_task ? 'study_review_submitted' : 'study_task_submitted';
  eventTracking.recordEvent(eventType, task.id, payload);
  return true;
}

function recordStudyTaskCompleted(task) {
  const payload = buildOutcomePayload(task, 'completed');
  if (!payload) {
    return false;
  }
  const eventType = payload.review_task ? 'study_review_completed' : 'study_task_completed';
  eventTracking.recordEvent(eventType, task.id, payload);
  return true;
}

function readStudyEvents({ workingDirectory, sinceDays = 30 } = {}) {
  const db = database.getDbInstance?.();
  if (!db || !workingDirectory) {
    return [];
  }
  const normalizedDirectory = normalizeWorkingDirectory(workingDirectory);
  const since = new Date(Date.now() - (Number(sinceDays) || 30) * 24 * 60 * 60 * 1000).toISOString();
  const placeholders = STUDY_EVENT_TYPES.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT event_type, task_id, data, timestamp
    FROM analytics
    WHERE event_type IN (${placeholders})
      AND timestamp >= ?
    ORDER BY timestamp DESC
    LIMIT 5000
  `).all(...STUDY_EVENT_TYPES, since);

  return rows
    .map((row) => ({
      event_type: row.event_type,
      task_id: row.task_id,
      timestamp: row.timestamp,
      data: parseMetadata(row.data),
    }))
    .filter((row) => normalizeWorkingDirectory(row.data?.working_directory) === normalizedDirectory);
}

function createTaskBucket() {
  return {
    count: 0,
    completed: 0,
    successful: 0,
    flagged_reviews: 0,
    total_retry_count: 0,
    total_provider_switch_count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_total_tokens: 0,
    total_cost_usd: 0,
    total_files_modified_count: 0,
    scored_output_count: 0,
    total_output_quality_score: 0,
  };
}

function createReviewBucket() {
  return {
    count: 0,
    flagged: 0,
    total_issue_count: 0,
  };
}

function finalizeTaskBucket(bucket) {
  const divisor = bucket.count || 1;
  const successRate = bucket.count > 0
    ? Math.round((bucket.successful / bucket.count) * 1000) / 10
    : 0;
  return {
    count: bucket.count,
    completed: bucket.completed,
    successful: bucket.successful,
    success_rate: successRate,
    avg_retry_count: Math.round((bucket.total_retry_count / divisor) * 100) / 100,
    avg_provider_switch_count: Math.round((bucket.total_provider_switch_count / divisor) * 100) / 100,
    avg_input_tokens: Math.round(bucket.total_input_tokens / divisor),
    avg_output_tokens: Math.round(bucket.total_output_tokens / divisor),
    avg_total_tokens: Math.round(bucket.total_total_tokens / divisor),
    avg_cost_usd: Math.round((bucket.total_cost_usd / divisor) * 10000) / 10000,
    avg_files_modified_count: Math.round((bucket.total_files_modified_count / divisor) * 100) / 100,
    scored_output_count: bucket.scored_output_count,
    avg_output_quality_score: bucket.scored_output_count > 0
      ? Math.round((bucket.total_output_quality_score / bucket.scored_output_count) * 10) / 10
      : null,
  };
}

function finalizeReviewBucket(bucket) {
  const divisor = bucket.count || 1;
  const flagRate = bucket.count > 0
    ? Math.round((bucket.flagged / bucket.count) * 1000) / 10
    : 0;
  return {
    count: bucket.count,
    flagged: bucket.flagged,
    flag_rate: flagRate,
    avg_issue_count: Math.round((bucket.total_issue_count / divisor) * 100) / 100,
  };
}

function buildDeltaMetrics(withContext, withoutContext) {
  if (!withContext.count || !withoutContext.count) {
    return {
      comparison_available: false,
    };
  }
  return {
    comparison_available: true,
    success_rate_points: Math.round((withContext.success_rate - withoutContext.success_rate) * 10) / 10,
    retry_count_delta: Math.round((withContext.avg_retry_count - withoutContext.avg_retry_count) * 100) / 100,
    provider_switch_delta: Math.round((withContext.avg_provider_switch_count - withoutContext.avg_provider_switch_count) * 100) / 100,
    total_tokens_delta: withContext.avg_total_tokens - withoutContext.avg_total_tokens,
    cost_usd_delta: Math.round((withContext.avg_cost_usd - withoutContext.avg_cost_usd) * 10000) / 10000,
    files_modified_delta: Math.round((withContext.avg_files_modified_count - withoutContext.avg_files_modified_count) * 100) / 100,
    output_quality_delta: Number.isFinite(withContext.avg_output_quality_score) && Number.isFinite(withoutContext.avg_output_quality_score)
      ? Math.round((withContext.avg_output_quality_score - withoutContext.avg_output_quality_score) * 10) / 10
      : null,
  };
}

function buildImpactRecommendation(taskOutcomes, reviewOutcomes) {
  const withContext = taskOutcomes?.with_context || finalizeTaskBucket(createTaskBucket());
  const withoutContext = taskOutcomes?.without_context || finalizeTaskBucket(createTaskBucket());
  const delta = taskOutcomes?.delta || { comparison_available: false };
  const withContextReviews = reviewOutcomes?.with_context_source || finalizeReviewBucket(createReviewBucket());
  const withoutContextReviews = reviewOutcomes?.without_context_source || finalizeReviewBucket(createReviewBucket());
  const recommendation = {
    status: 'insufficient_data',
    confidence: 'low',
    reasoning: [],
    next_step: 'Run at least two comparable tasks with study context on and two without to establish a useful baseline.',
    settings: null,
  };

  const pairedTaskSamples = Math.min(withContext.count || 0, withoutContext.count || 0);
  const pairedReviewSamples = Math.min(withContextReviews.count || 0, withoutContextReviews.count || 0);
  const hasComparison = delta.comparison_available === true;

  if (!hasComparison || pairedTaskSamples < MIN_COMPARISON_SAMPLE_SIZE) {
    recommendation.reasoning.push(
      `Only ${withContext.count || 0} study-context task samples and ${withoutContext.count || 0} baseline samples are available.`
    );
    if ((withContext.count || 0) >= MIN_COMPARISON_SAMPLE_SIZE && (withoutContext.count || 0) === 0) {
      recommendation.status = 'needs_baseline';
      recommendation.next_step = 'Run a small comparison batch with study_context=false so the scheduler can compare the two paths.';
    }
    return recommendation;
  }

  const successDelta = Number(delta.success_rate_points) || 0;
  const retryDelta = Number(delta.retry_count_delta) || 0;
  const tokenDelta = Number(delta.total_tokens_delta) || 0;
  const costDelta = Number(delta.cost_usd_delta) || 0;
  const qualityDelta = Number.isFinite(delta.output_quality_delta) ? Number(delta.output_quality_delta) : null;
  const reviewFlagDelta = pairedReviewSamples > 0
    ? roundTo((withContextReviews.flag_rate || 0) - (withoutContextReviews.flag_rate || 0), 1)
    : null;

  const performanceSignals = {
    success_improved: successDelta >= 10,
    retries_improved: retryDelta <= -0.5,
    cost_regressed: costDelta > 0.01,
    token_regressed: tokenDelta > 1200,
    review_regressed: reviewFlagDelta !== null && reviewFlagDelta >= 10,
    quality_improved: qualityDelta !== null && qualityDelta >= 10,
    quality_regressed: qualityDelta !== null && qualityDelta <= -10,
  };
  const positiveSignals = [
    performanceSignals.success_improved,
    performanceSignals.retries_improved,
    performanceSignals.quality_improved,
    reviewFlagDelta !== null ? reviewFlagDelta <= -10 : false,
  ].filter(Boolean).length;
  const negativeSignals = [
    successDelta <= -5,
    retryDelta >= 0.5,
    performanceSignals.quality_regressed,
    performanceSignals.review_regressed,
  ].filter(Boolean).length;

  let proposalSignificanceLevel = 'moderate';
  let proposalMinScore = 18;
  let submitProposals = false;
  let proposalLimit = DEFAULT_RECOMMENDED_PROPOSAL_LIMIT;
  let status = 'neutral';

  if (negativeSignals > 0) {
    status = 'caution';
    proposalSignificanceLevel = successDelta <= -10 || performanceSignals.review_regressed ? 'high' : 'moderate';
    proposalMinScore = proposalSignificanceLevel === 'high' ? 35 : 24;
    submitProposals = false;
    proposalLimit = 1;
    recommendation.reasoning.push(
      `Study context is underperforming the baseline by ${roundTo(Math.abs(successDelta), 1)} success-rate points or producing noisier reviews/retries.`
    );
  } else if (positiveSignals >= 2) {
    status = 'favorable';
    proposalSignificanceLevel = performanceSignals.cost_regressed || performanceSignals.token_regressed ? 'moderate' : 'low';
    proposalMinScore = proposalSignificanceLevel === 'low' ? 8 : 14;
    submitProposals = true;
    proposalLimit = pairedTaskSamples >= 4 ? 3 : 2;
    recommendation.reasoning.push(
      `Study context improves success by ${roundTo(successDelta, 1)} points and reduces retries by ${roundTo(-retryDelta, 2)} on average.`
    );
  } else {
    recommendation.reasoning.push(
      `Study context is directionally better but still close to baseline: ${roundTo(successDelta, 1)} success-rate points and ${roundTo(-retryDelta, 2)} retry improvement.`
    );
  }

  if (pairedReviewSamples > 0) {
    recommendation.reasoning.push(
      `Review flag rate delta is ${roundTo(reviewFlagDelta, 1)} points (${withContextReviews.flag_rate || 0}% with context vs ${withoutContextReviews.flag_rate || 0}% without).`
    );
  } else {
    recommendation.reasoning.push('No balanced review sample exists yet, so review-quality influence is still provisional.');
  }
  if (qualityDelta !== null) {
    recommendation.reasoning.push(
      `Output quality delta is ${roundTo(qualityDelta, 1)} points (${withContext.avg_output_quality_score ?? 'n/a'} with context vs ${withoutContext.avg_output_quality_score ?? 'n/a'} without).`
    );
  }

  if (performanceSignals.cost_regressed || performanceSignals.token_regressed) {
    recommendation.reasoning.push(
      `Study context adds about ${tokenDelta} tokens and $${roundTo(costDelta, 4).toFixed(4)} per task, so the proposal gate should stay conservative.`
    );
  }

  const confidence = pairedTaskSamples >= 4
    ? (pairedReviewSamples >= 2 ? 'high' : 'medium')
    : 'medium';

  recommendation.status = status;
  recommendation.confidence = confidence;
  recommendation.next_step = status === 'favorable'
    ? 'Apply the recommendation and keep seeding the impact panel with a few more paired tasks before lowering thresholds further.'
    : status === 'caution'
      ? 'Keep auto-submit disabled and gather a few more paired tasks before relaxing the threshold.'
      : 'Keep the threshold moderate until more paired tasks and reviews are available.';
  recommendation.settings = {
    submit_proposals: submitProposals,
    proposal_limit: proposalLimit,
    proposal_significance_level: proposalSignificanceLevel,
    proposal_min_score: proposalMinScore,
  };
  recommendation.evidence = {
    paired_task_samples: pairedTaskSamples,
    paired_review_samples: pairedReviewSamples,
    success_rate_points: roundTo(successDelta, 1),
    retry_count_delta: roundTo(retryDelta, 2),
    total_tokens_delta: tokenDelta,
    cost_usd_delta: roundTo(costDelta, 4),
    review_flag_rate_points: reviewFlagDelta,
    output_quality_delta: qualityDelta,
  };

  return recommendation;
}

function getStudyImpactSummary({ workingDirectory, sinceDays = 30 } = {}) {
  const events = readStudyEvents({ workingDirectory, sinceDays });
  if (!events.length) {
    return {
      generated_at: new Date().toISOString(),
      window_days: Number(sinceDays) || 30,
      has_data: false,
      task_outcomes: {
        with_context: finalizeTaskBucket(createTaskBucket()),
        without_context: finalizeTaskBucket(createTaskBucket()),
        delta: { comparison_available: false },
      },
      review_outcomes: {
        with_context_source: finalizeReviewBucket(createReviewBucket()),
        without_context_source: finalizeReviewBucket(createReviewBucket()),
      },
      recommendation: buildImpactRecommendation({
        with_context: finalizeTaskBucket(createTaskBucket()),
        without_context: finalizeTaskBucket(createTaskBucket()),
        delta: { comparison_available: false },
      }, {
        with_context_source: finalizeReviewBucket(createReviewBucket()),
        without_context_source: finalizeReviewBucket(createReviewBucket()),
      }),
    };
  }

  const taskBuckets = {
    with_context: createTaskBucket(),
    without_context: createTaskBucket(),
  };
  const reviewBuckets = {
    with_context_source: createReviewBucket(),
    without_context_source: createReviewBucket(),
  };

  for (const event of events) {
    const payload = event.data || {};
    if (event.event_type === 'study_task_completed') {
      const key = payload.study_context_applied ? 'with_context' : 'without_context';
      const bucket = taskBuckets[key];
      bucket.count += 1;
      bucket.completed += 1;
      if (payload.status === 'completed') {
        bucket.successful += 1;
      }
      bucket.total_retry_count += Number(payload.retry_count) || 0;
      bucket.total_provider_switch_count += Number(payload.provider_switch_count) || 0;
      bucket.total_input_tokens += Number(payload.input_tokens) || 0;
      bucket.total_output_tokens += Number(payload.output_tokens) || 0;
      bucket.total_total_tokens += Number(payload.total_tokens) || 0;
      bucket.total_cost_usd += Number(payload.cost_usd) || 0;
      bucket.total_files_modified_count += Number(payload.files_modified_count) || 0;
      if (Number.isFinite(payload.output_quality_score)) {
        bucket.scored_output_count += 1;
        bucket.total_output_quality_score += Number(payload.output_quality_score) || 0;
      }
      continue;
    }
    if (event.event_type === 'study_review_completed') {
      const key = payload.source_study_context_applied ? 'with_context_source' : 'without_context_source';
      const bucket = reviewBuckets[key];
      bucket.count += 1;
      if (payload.review_verdict === 'flag') {
        bucket.flagged += 1;
      }
      bucket.total_issue_count += Number(payload.review_issue_count) || 0;
    }
  }

  const withContext = finalizeTaskBucket(taskBuckets.with_context);
  const withoutContext = finalizeTaskBucket(taskBuckets.without_context);
  const finalizedTaskOutcomes = {
    with_context: withContext,
    without_context: withoutContext,
    delta: buildDeltaMetrics(withContext, withoutContext),
  };
  const finalizedReviewOutcomes = {
    with_context_source: finalizeReviewBucket(reviewBuckets.with_context_source),
    without_context_source: finalizeReviewBucket(reviewBuckets.without_context_source),
  };

  return {
    generated_at: new Date().toISOString(),
    window_days: Number(sinceDays) || 30,
    has_data: true,
    task_outcomes: finalizedTaskOutcomes,
    review_outcomes: finalizedReviewOutcomes,
    recommendation: buildImpactRecommendation(finalizedTaskOutcomes, finalizedReviewOutcomes),
  };
}

module.exports = {
  recordStudyTaskSubmitted,
  recordStudyTaskCompleted,
  getStudyImpactSummary,
};
