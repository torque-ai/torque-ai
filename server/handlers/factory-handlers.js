'use strict';

const path = require('path');
const fs = require('fs');
const factoryHealth = require('../db/factory-health');
const { scoreAll } = require('../factory/scorer-registry');
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

module.exports = {
  handleRegisterFactoryProject,
  handleListFactoryProjects,
  handleProjectHealth,
  handleScanProjectHealth,
  handleSetFactoryTrustLevel,
  handlePauseProject,
  handleResumeProject,
  handlePauseAllProjects,
  handleFactoryStatus,
};
