'use strict';

const MIN_DESCRIPTION_LENGTH = 100;
const SIMILARITY_THRESHOLD = 0.9;

const reasonPatterns = [
  /^plan_quality_gate_rejected_after_2_attempts$/i,
  /^replan_generation_failed$/i,
];

function tokenize(text) {
  return new Set(
    String(text || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  let intersect = 0;
  for (const t of a) if (b.has(t)) intersect++;
  const union = a.size + b.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function detectCycle(children) {
  const n = children.length;
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    const dep = children[i].depends_on_index;
    if (dep === undefined || dep === null) continue;
    if (typeof dep !== 'number' || !Number.isInteger(dep) || dep < 0 || dep >= n) {
      return true;
    }
    if (dep === i) return true;
    adj[i].push(dep);
  }
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Array(n).fill(WHITE);
  function dfs(u) {
    color[u] = GRAY;
    for (const v of adj[u]) {
      if (color[v] === GRAY) return true;
      if (color[v] === WHITE && dfs(v)) return true;
    }
    color[u] = BLACK;
    return false;
  }
  for (let i = 0; i < n; i++) {
    if (color[i] === WHITE && dfs(i)) return true;
  }
  return false;
}

function validateDecomposeResponse(response, parent, config) {
  if (!response || typeof response !== 'object') {
    return { ok: false, reason: 'decompose_response_invalid: not an object' };
  }
  if (!Array.isArray(response.children)) {
    return { ok: false, reason: 'decompose_response_invalid: children not an array' };
  }
  const minChildren = 2;
  const maxChildren = config?.splitMaxChildren ?? 5;
  if (response.children.length < minChildren) {
    return { ok: false, reason: `decompose_response_invalid: fewer than ${minChildren} children` };
  }
  if (response.children.length > maxChildren) {
    return { ok: false, reason: `decompose_response_invalid: more than ${maxChildren} children` };
  }
  const titles = new Set();
  for (const child of response.children) {
    if (!child || typeof child.title !== 'string' || !child.title.trim()) {
      return { ok: false, reason: 'decompose_response_invalid: child missing title' };
    }
    if (typeof child.description !== 'string' || child.description.length < MIN_DESCRIPTION_LENGTH) {
      return { ok: false, reason: `decompose_response_invalid: child description < ${MIN_DESCRIPTION_LENGTH} chars` };
    }
    if (!Array.isArray(child.acceptance_criteria) || child.acceptance_criteria.length === 0) {
      return { ok: false, reason: 'decompose_response_invalid: child missing acceptance_criteria' };
    }
    const t = child.title.trim().toLowerCase();
    if (titles.has(t)) {
      return { ok: false, reason: 'decompose_response_invalid: duplicate child titles' };
    }
    titles.add(t);
  }
  if (detectCycle(response.children)) {
    return { ok: false, reason: 'decompose_response_invalid: cycle in depends_on_index' };
  }
  const parentTokens = tokenize(`${parent.title} ${parent.description}`);
  for (const child of response.children) {
    const childTokens = tokenize(`${child.title} ${child.description}`);
    if (jaccard(parentTokens, childTokens) >= SIMILARITY_THRESHOLD) {
      return { ok: false, reason: 'decompose_response_invalid: child >= 90% similar to parent' };
    }
  }
  return { ok: true };
}

function appendAcceptanceCriteria(description, criteria) {
  const lines = ['', '## Acceptance Criteria', ''];
  for (const c of criteria) lines.push(`- ${String(c).trim()}`);
  return `${description.trimEnd()}\n${lines.join('\n')}`;
}

async function replan({ workItem, history, deps }) {
  const { architectRunner, logger, config } = deps;
  const splitMaxDepth = config?.splitMaxDepth ?? 2;
  const currentDepth = Number(workItem.depth || 0);
  if (currentDepth >= splitMaxDepth) {
    return {
      outcome: 'unrecoverable',
      reason: `decompose_refused: depth ${currentDepth} >= max ${splitMaxDepth}`,
    };
  }

  let response;
  try {
    response = await architectRunner.decomposeWorkItem({
      workItem,
      history,
      priorPlans: history.priorPlans || [],
      projectPath: deps.projectPath || null,
    });
  } catch (err) {
    if (logger?.warn) {
      logger.warn('decompose: architect call threw', { work_item_id: workItem.id, err: err.message });
    }
    throw err;
  }

  const validation = validateDecomposeResponse(response, workItem, config);
  if (!validation.ok) {
    return { outcome: 'unrecoverable', reason: validation.reason };
  }

  const children = response.children.map((c) => ({
    title: c.title.trim(),
    description: appendAcceptanceCriteria(c.description, c.acceptance_criteria),
    constraints: c.constraints || null,
  }));

  return { outcome: 'split', children };
}

module.exports = {
  name: 'decompose',
  reasonPatterns,
  replan,
};
