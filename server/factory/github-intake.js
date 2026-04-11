'use strict';

const factoryIntake = require('../db/factory-intake');
const logger = require('../logger').child({ component: 'factory-github-intake' });

const GITHUB_API_BASE_URL = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_ISSUES_PER_PAGE = 100;
const MAX_PAGES = 100;

function normalizeRepo(repo) {
  if (typeof repo !== 'string') {
    return null;
  }

  const trimmed = repo.trim();
  if (!trimmed) {
    return null;
  }

  const parts = trimmed.split('/').map((part) => part.trim()).filter(Boolean);
  if (parts.length !== 2) {
    return null;
  }

  return `${parts[0]}/${parts[1]}`;
}

function normalizeLabels(labels) {
  if (labels === undefined || labels === null) {
    return [];
  }

  if (typeof labels === 'string') {
    return labels
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
  }

  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) => (typeof label === 'string' ? label.trim() : ''))
    .filter(Boolean);
}

function hasValidLabelConfig(labels) {
  return labels === undefined
    || labels === null
    || typeof labels === 'string'
    || Array.isArray(labels);
}

function resolveGitHubToken(config = {}) {
  if (typeof config.github_token === 'string' && config.github_token.trim()) {
    return config.github_token.trim();
  }

  if (typeof process.env.GITHUB_TOKEN === 'string' && process.env.GITHUB_TOKEN.trim()) {
    return process.env.GITHUB_TOKEN.trim();
  }

  if (typeof process.env.GH_TOKEN === 'string' && process.env.GH_TOKEN.trim()) {
    return process.env.GH_TOKEN.trim();
  }

  return null;
}

function buildIssuesUrl(repo, page) {
  const [owner, name] = repo.split('/');
  return `${GITHUB_API_BASE_URL}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues?state=open&per_page=${MAX_ISSUES_PER_PAGE}&page=${page}`;
}

async function parseGitHubResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse GitHub response: ${error.message}`);
  }
}

async function fetchOpenIssues(repo, token) {
  if (typeof fetch !== 'function') {
    return { issues: [], error: 'GitHub issue intake requires a Node.js runtime with fetch support' };
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'User-Agent': 'TORQUE Factory GitHub Intake',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };

  const issues = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const response = await fetch(buildIssuesUrl(repo, page), {
      headers,
    });

    let payload;
    try {
      payload = await parseGitHubResponse(response);
    } catch (error) {
      return { issues: [], error: error.message };
    }

    if (!response.ok) {
      const message = payload && typeof payload.message === 'string'
        ? payload.message
        : `GitHub API request failed with status ${response.status}`;
      return { issues: [], error: `${message} (${response.status})` };
    }

    if (!Array.isArray(payload)) {
      return { issues: [], error: 'GitHub API returned an unexpected issues payload' };
    }

    issues.push(...payload);
    if (payload.length < MAX_ISSUES_PER_PAGE) {
      break;
    }
  }

  return { issues, error: null };
}

function issueMatchesLabels(issue, labels) {
  if (!labels.length) {
    return true;
  }

  const configured = new Set(labels.map((label) => label.toLowerCase()));
  const issueLabels = Array.isArray(issue.labels) ? issue.labels : [];
  return issueLabels.some((label) => {
    const name = typeof label === 'string' ? label : label && label.name;
    return typeof name === 'string' && configured.has(name.toLowerCase());
  });
}

function getExistingOriginRefs(projectId) {
  const items = factoryIntake.listWorkItems({
    project_id: projectId,
    limit: 10000,
  });

  const refs = new Set();
  for (const item of items) {
    if (!item || item.status === 'rejected' || item.status === 'shipped') {
      continue;
    }

    const origin = item.origin;
    if (origin && origin.type === 'github_issue' && typeof origin.ref === 'string' && origin.ref.trim()) {
      refs.add(origin.ref.trim());
    }
  }

  return refs;
}

function buildIssueDescription(issue) {
  const body = typeof issue.body === 'string' ? issue.body.trim() : '';
  const url = typeof issue.html_url === 'string' ? issue.html_url.trim() : '';

  if (body && url) {
    return `${body}\n\nSource: ${url}`;
  }

  if (body) {
    return body;
  }

  if (url) {
    return `Source: ${url}`;
  }

  return null;
}

async function pollGitHubIssues(project_id, config = {}) {
  const result = { imported: 0, skipped: 0, errors: [] };

  if (!project_id) {
    result.errors.push('project_id is required');
    return result;
  }

  const repo = normalizeRepo(config.github_repo);
  if (!repo) {
    result.errors.push('GitHub issue intake requires config.github_repo in owner/repo format');
    return result;
  }

  if (!hasValidLabelConfig(config.github_labels)) {
    result.errors.push('GitHub issue intake requires config.github_labels to be an array of label names');
    return result;
  }

  const token = resolveGitHubToken(config);
  if (!token) {
    result.errors.push('GitHub issue intake requires a configured GitHub token (GITHUB_TOKEN, GH_TOKEN, or config.github_token)');
    return result;
  }

  const labels = normalizeLabels(config.github_labels);
  const existingRefs = getExistingOriginRefs(project_id);

  let issues;
  try {
    const response = await fetchOpenIssues(repo, token);
    if (response.error) {
      result.errors.push(response.error);
      return result;
    }
    issues = response.issues;
  } catch (error) {
    const message = (error && error.message) || 'Failed to fetch GitHub issues';
    logger.warn(`GitHub intake request failed for ${repo}: ${message}`);
    result.errors.push(message);
    return result;
  }

  for (const issue of issues) {
    if (!issue || issue.pull_request) {
      continue;
    }

    if (!issueMatchesLabels(issue, labels)) {
      continue;
    }

    const ref = `${repo}#${issue.number}`;
    if (existingRefs.has(ref)) {
      result.skipped += 1;
      continue;
    }

    try {
      factoryIntake.createWorkItem({
        project_id,
        source: 'github_issue',
        origin: { type: 'github_issue', ref },
        title: issue.title || `GitHub issue #${issue.number}`,
        description: buildIssueDescription(issue),
        requestor: issue.user && typeof issue.user.login === 'string' ? issue.user.login : null,
      });
      existingRefs.add(ref);
      result.imported += 1;
    } catch (error) {
      const message = (error && error.message) || 'Failed to create intake item';
      logger.warn(`GitHub intake failed for ${ref}: ${message}`);
      result.errors.push(`Failed to import ${ref}: ${message}`);
    }
  }

  return result;
}

module.exports = {
  pollGitHubIssues,
};
