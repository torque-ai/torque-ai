'use strict';

const path = require('path');
const fs = require('fs');
const factoryHealth = require('../db/factory-health');
const factoryIntake = require('../db/factory-intake');
const factoryArchitect = require('../db/factory-architect');
const { runArchitectCycle } = require('../factory/architect-runner');
const { scoreAll } = require('../factory/scorer-registry');
const { runPreBatchChecks, runPostBatchChecks, runPreShipChecks, getGuardrailSummary } = require('../factory/guardrail-runner');
const guardrailDb = require('../db/factory-guardrails');
const loopController = require('../factory/loop-controller');
const { analyzeBatch, detectDrift, recordHumanCorrection } = require('../factory/feedback');
const logger = require('../logger').child({ component: 'factory-handlers' });

function resolveProject(projectRef) {
  let project = factoryHealth.getProject(projectRef);
  if (!project) {
    project = factoryHealth.getProjectByPath(projectRef);
  }
  if (!project) {
    throw new Error(`Project not found: ${projectRef}`);
  }
  return project;
}

function jsonResponse(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

async function handleRegisterFactoryProject(args) {
  const project = factoryHealth.registerProject({
    name: args.name,
    path: args.path,
    brief: args.brief,
    trust_level: args.trust_level,
  });
  logger.info(`Registered factory project: ${project.name} (${project.id})`);
  return jsonResponse({
    message: `Project "${project.name}" registered with trust level: ${project.trust_level}`,
    project,
  });
}

async function handleListFactoryProjects(args) {
  const projects = factoryHealth.listProjects(args.status ? { status: args.status } : undefined);
  const summaries = projects.map(p => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id);
    return { ...p, scores, balance };
  });
  return jsonResponse({ projects: summaries });
}

async function handleProjectHealth(args) {
  const project = resolveProject(args.project);
  const scores = factoryHealth.getLatestScores(project.id);
  const balance = factoryHealth.getBalanceScore(project.id);
  const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];

  const result = {
    project: { id: project.id, name: project.name, path: project.path, trust_level: project.trust_level, status: project.status },
    scores,
    balance,
    weakest_dimension: weakest ? { dimension: weakest[0], score: weakest[1] } : null,
  };

  if (args.include_trends) {
    result.trends = {};
    for (const dim of Object.keys(scores)) {
      result.trends[dim] = factoryHealth.getScoreHistory(project.id, dim, 20);
    }
  }

  if (args.include_findings) {
    result.findings = {};
    for (const dim of Object.keys(scores)) {
      const history = factoryHealth.getScoreHistory(project.id, dim, 1);
      if (history.length > 0) {
        result.findings[dim] = factoryHealth.getFindings(history[history.length - 1].id);
      }
    }
  }

  return jsonResponse(result);
}

async function handleScanProjectHealth(args) {
  const project = resolveProject(args.project);
  const dimensions = args.dimensions || [...factoryHealth.VALID_DIMENSIONS];
  const scanType = args.scan_type || 'incremental';

  // Run scan_project to get filesystem data
  let scanReport = {};
  try {
    const { handleScanProject } = require('../handlers/integration/infra');
    const scanResult = handleScanProject({ path: project.path });
    if (scanResult?.content?.[0]) {
      scanReport = JSON.parse(scanResult.content[0].text);
    }
  } catch (err) {
    logger.warn(`scan_project failed for ${project.path}: ${err.message}`);
  }

  // Resolve findings directory
  let findingsDir = null;
  const candidates = [
    path.join(project.path, 'docs', 'findings'),
    path.join(project.path, '..', 'docs', 'findings'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(dir)) { findingsDir = dir; break; }
  }

  // Score all requested dimensions
  const scored = scoreAll(project.path, scanReport, findingsDir, dimensions);

  // Record snapshots and findings
  const results = {};
  for (const [dim, result] of Object.entries(scored)) {
    const snap = factoryHealth.recordSnapshot({
      project_id: project.id,
      dimension: dim,
      score: result.score,
      scan_type: scanType,
      batch_id: args.batch_id,
      details: result.details,
    });

    if (result.findings && result.findings.length > 0) {
      factoryHealth.recordFindings(snap.id, result.findings);
    }

    results[dim] = { snapshot_id: snap.id, score: result.score, details: result.details };
  }

  return jsonResponse({
    message: `Scanned ${dimensions.length} dimensions for "${project.name}" (${scanType})`,
    project_id: project.id,
    results,
  });
}

async function handleSetFactoryTrustLevel(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { trust_level: args.trust_level });
  logger.info(`Trust level for "${updated.name}" changed to ${args.trust_level}`);
  return jsonResponse({
    message: `Trust level for "${updated.name}" set to: ${updated.trust_level}`,
    project: updated,
  });
}

async function handlePauseProject(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { status: 'paused' });
  logger.info(`Factory project paused: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" paused`,
    project: updated,
  });
}

async function handleResumeProject(args) {
  const project = resolveProject(args.project);
  const updated = factoryHealth.updateProject(project.id, { status: 'running' });
  logger.info(`Factory project resumed: ${updated.name}`);
  return jsonResponse({
    message: `Project "${updated.name}" running`,
    project: updated,
  });
}

async function handlePauseAllProjects() {
  const projects = factoryHealth.listProjects();
  let paused = 0;
  for (const p of projects) {
    if (p.status !== 'paused') {
      factoryHealth.updateProject(p.id, { status: 'paused' });
      paused++;
    }
  }
  logger.info(`Emergency pause: ${paused} projects paused`);
  return jsonResponse({
    message: `${paused} project(s) paused`,
    total: projects.length,
    paused,
  });
}

async function handleFactoryStatus() {
  const projects = factoryHealth.listProjects();
  const summaries = projects.map(p => {
    const scores = factoryHealth.getLatestScores(p.id);
    const balance = factoryHealth.getBalanceScore(p.id);
    const weakest = Object.entries(scores).sort((a, b) => a[1] - b[1])[0];
    return {
      id: p.id,
      name: p.name,
      path: p.path,
      trust_level: p.trust_level,
      status: p.status,
      balance,
      weakest_dimension: weakest ? weakest[0] : null,
      dimension_count: Object.keys(scores).length,
    };
  });

  const running = summaries.filter(p => p.status === 'running').length;
  const paused = summaries.filter(p => p.status === 'paused').length;

  return jsonResponse({
    projects: summaries,
    summary: { total: projects.length, running, paused },
  });
}

async function handleCreateWorkItem(args) {
  const project = resolveProject(args.project);
  const item = factoryIntake.createWorkItem({
    project_id: project.id,
    source: args.source,
    title: args.title,
    description: args.description,
    priority: args.priority,
    requestor: args.requestor,
    origin: args.origin,
    constraints: args.constraints,
  });
  return jsonResponse({ message: `Work item #${item.id} created`, item });
}

async function handleListWorkItems(args) {
  const project = resolveProject(args.project);
  const items = factoryIntake.listWorkItems({
    project_id: project.id,
    status: args.status,
    limit: args.limit || 50,
    offset: args.offset,
  });
  const stats = factoryIntake.getIntakeStats(project.id);
  return jsonResponse({ items, stats });
}

async function handleUpdateWorkItem(args) {
  const updates = {};
  if (args.title !== undefined) updates.title = args.title;
  if (args.description !== undefined) updates.description = args.description;
  if (args.priority !== undefined) updates.priority = args.priority;
  if (args.status !== undefined) updates.status = args.status;
  if (args.batch_id !== undefined) updates.batch_id = args.batch_id;
  if (args.linked_item_id !== undefined) updates.linked_item_id = args.linked_item_id;
  if (args.constraints !== undefined) updates.constraints_json = args.constraints;
  const item = factoryIntake.updateWorkItem(args.id, updates);
  if (!item) throw new Error(`Work item not found: ${args.id}`);
  return jsonResponse({ message: `Work item #${args.id} updated`, item });
}

async function handleRejectWorkItem(args) {
  const item = factoryIntake.rejectWorkItem(args.id, args.reason);
  if (!item) throw new Error(`Work item not found: ${args.id}`);
  return jsonResponse({ message: `Work item #${args.id} rejected`, item });
}

async function handleIntakeFromFindings(args) {
  const project = resolveProject(args.project);
  const result = factoryIntake.createFromFindings(project.id, args.findings, args.source);
  return jsonResponse({
    message: `Imported ${result.created.length} items, ${result.skipped.length} skipped`,
    created: result.created,
    skipped: result.skipped,
  });
}

async function handleTriggerArchitect(args) {
  const project = resolveProject(args.project);
  const cycle = await runArchitectCycle(project.id, 'manual');
  return jsonResponse({
    message: `Architect cycle completed for "${project.name}"`,
    reasoning: cycle.reasoning,
    backlog: cycle.backlog,
    flags: cycle.flags,
    cycle_id: cycle.id,
  });
}

async function handleArchitectBacklog(args) {
  const project = resolveProject(args.project);
  const backlog = factoryArchitect.getBacklog(project.id);
  const latest = factoryArchitect.getLatestCycle(project.id);
  return jsonResponse({
    project: project.name,
    backlog,
    reasoning_summary: latest ? latest.reasoning.slice(0, 500) : null,
    cycle_id: latest ? latest.id : null,
  });
}

async function handleArchitectLog(args) {
  const project = resolveProject(args.project);
  const log = factoryArchitect.getReasoningLog(project.id, args.limit || 10);
  return jsonResponse({ project: project.name, entries: log });
}

async function handleGetProjectPolicy(args) {
  const project = resolveProject(args.project);
  const policy = factoryHealth.getProjectPolicy(project.id);
  return jsonResponse({ project: project.name, policy });
}

async function handleSetProjectPolicy(args) {
  const project = resolveProject(args.project);
  const policy = factoryHealth.setProjectPolicy(project.id, args.policy);
  logger.info(`Policy updated for "${project.name}"`);
  return jsonResponse({ message: `Policy updated for "${project.name}"`, policy });
}

async function handleGuardrailStatus(args) {
  const project = resolveProject(args.project);
  const summary = getGuardrailSummary(project.id);
  return jsonResponse({ project: project.name, ...summary });
}

async function handleRunGuardrailCheck(args) {
  const project = resolveProject(args.project);
  let result;
  switch (args.phase) {
    case 'pre_batch':
      result = runPreBatchChecks(project.id, args.batch_plan || { tasks: [], scope_budget: 5 }, {
        recent_batches: [],
        write_sets: [],
      });
      break;
    case 'post_batch':
      result = runPostBatchChecks(project.id, args.batch_id || 'manual', args.files_changed || []);
      break;
    case 'pre_ship':
      result = runPreShipChecks(project.id, args.batch_id || 'manual', {
        test_results: args.test_results || { passed: 0, failed: 0, skipped: 0 },
      });
      break;
    default:
      throw new Error(`Invalid phase: ${args.phase}`);
  }
  logger.info(`Guardrail ${args.phase} check for "${project.name}": ${result.passed ? 'PASSED' : 'BLOCKED'}`);
  return jsonResponse({ project: project.name, phase: args.phase, ...result });
}

async function handleGuardrailEvents(args) {
  const project = resolveProject(args.project);
  const events = guardrailDb.getEvents(project.id, {
    category: args.category,
    status: args.status,
    limit: args.limit,
  });
  return jsonResponse({ project: project.name, events });
}

async function handleStartFactoryLoop(args) {
  const project = resolveProject(args.project);
  const result = await loopController.startLoop(project.id);
  return jsonResponse(result);
}

async function handleAdvanceFactoryLoop(args) {
  const project = resolveProject(args.project);
  const result = await loopController.advanceLoop(project.id);
  return jsonResponse(result);
}

async function handleApproveFactoryGate(args) {
  const project = resolveProject(args.project);
  const result = await loopController.approveGate(project.id, args.stage);
  return jsonResponse(result);
}

async function handleFactoryLoopStatus(args) {
  const project = resolveProject(args.project);
  const result = loopController.getLoopState(project.id);
  return jsonResponse(result);
}

async function handleAnalyzeBatch(args) {
  const project = resolveProject(args.project);
  const result = await analyzeBatch(project.id, args.batch_id, {
    task_count: args.task_count,
    retry_count: args.retry_count,
    duration_seconds: args.duration_seconds,
    estimated_cost: args.estimated_cost,
    human_corrections: args.human_corrections,
  });
  logger.info(`Batch analysis complete for "${project.name}" batch ${args.batch_id}`);
  return jsonResponse(result);
}

async function handleFactoryDriftStatus(args) {
  const project = resolveProject(args.project);
  const result = detectDrift(project.id, { window: args.window });
  return jsonResponse({ project: project.name, ...result });
}

async function handleRecordCorrection(args) {
  const project = resolveProject(args.project);
  const result = recordHumanCorrection(project.id, {
    type: args.type,
    description: args.description,
  });
  logger.info(`Correction recorded for "${project.name}": ${args.type}`);
  return jsonResponse(result);
}

module.exports = {
  handleRegisterFactoryProject,
  handleListFactoryProjects,
  handleProjectHealth,
  handleScanProjectHealth,
  handleSetFactoryTrustLevel,
  handleGetProjectPolicy,
  handleSetProjectPolicy,
  handleGuardrailStatus,
  handleRunGuardrailCheck,
  handleGuardrailEvents,
  handlePauseProject,
  handleResumeProject,
  handlePauseAllProjects,
  handleFactoryStatus,
  handleCreateWorkItem,
  handleListWorkItems,
  handleUpdateWorkItem,
  handleRejectWorkItem,
  handleIntakeFromFindings,
  handleTriggerArchitect,
  handleArchitectBacklog,
  handleArchitectLog,
  handleStartFactoryLoop,
  handleAdvanceFactoryLoop,
  handleApproveFactoryGate,
  handleFactoryLoopStatus,
  handleAnalyzeBatch,
  handleFactoryDriftStatus,
  handleRecordCorrection,
};
