/**
 * Factory orphan-branch reconciler.
 *
 * After the factory auto-rejects a work item for "worktree lost" or similar
 * infrastructure failures, commits pushed to origin/feat/factory-<id>-* can
 * end up orphaned — nobody will merge them. The new origin-recovery path in
 * executeVerifyStage (commit 4454c65e) prevents this going forward, but
 * branches pushed before that fix still sit on origin untouched.
 *
 * findOrphanFactoryBranches scans a project's origin remote for branches
 * matching the factory naming pattern, cross-references each against the
 * factory_work_items table, and returns the set whose commits never landed
 * on the base branch. writeOrphanFindings produces an operator-friendly
 * markdown report at docs/findings/<date>-factory-orphans-<project>.md so
 * a human can decide whether to merge or discard.
 *
 * Auto-merge is deliberately not attempted — the commits may represent
 * rejected quality, incomplete work, or superseded approaches. The goal
 * is visibility, not automated acceptance.
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const logger = require('../logger').child({ component: 'orphan-reconciler' });

const FACTORY_BRANCH_PATTERN = /^feat\/factory-(\d+)-/;

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function detectBaseBranch(repoPath) {
  try {
    const ref = runGit(repoPath, ['symbolic-ref', 'refs/remotes/origin/HEAD']).trim();
    const m = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (m) return m[1];
  } catch { /* fall through */ }
  for (const candidate of ['master', 'main']) {
    try {
      runGit(repoPath, ['rev-parse', '--verify', `origin/${candidate}`]);
      return candidate;
    } catch { /* try next */ }
  }
  return 'main';
}

/**
 * Scan origin for factory branches with commits ahead of base that reference
 * work items. Returns an array of orphan descriptors the caller can report.
 *
 * @param {object} opts
 * @param {string} opts.projectPath Absolute path to the project repo.
 * @param {function} [opts.getWorkItemStatus] (id) => status|null. Used to
 *   annotate each orphan with its work-item state so the operator can
 *   see why it was abandoned.
 * @returns {Array<{ branch: string, workItemId: number, aheadCount: number,
 *                   headSha: string, workItemStatus: string|null }>}
 */
function findOrphanFactoryBranches({ projectPath, getWorkItemStatus } = {}) {
  if (!projectPath) throw new Error('findOrphanFactoryBranches requires projectPath');
  if (!fs.existsSync(projectPath)) throw new Error(`projectPath does not exist: ${projectPath}`);

  const baseBranch = detectBaseBranch(projectPath);
  const remoteListRaw = runGit(projectPath, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/remotes/origin']);
  const orphans = [];
  for (const line of remoteListRaw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [refName, sha] = trimmed.split(/\s+/);
    if (!refName.startsWith('origin/')) continue;
    const shortBranch = refName.slice('origin/'.length);
    const m = shortBranch.match(FACTORY_BRANCH_PATTERN);
    if (!m) continue;
    const workItemId = Number.parseInt(m[1], 10);
    if (!Number.isFinite(workItemId)) continue;

    let aheadCount = 0;
    try {
      const out = runGit(projectPath, ['rev-list', '--count', `origin/${baseBranch}..origin/${shortBranch}`]).trim();
      aheadCount = Number.parseInt(out, 10) || 0;
    } catch {
      continue;
    }
    if (aheadCount === 0) continue;

    let workItemStatus = null;
    if (typeof getWorkItemStatus === 'function') {
      try { workItemStatus = getWorkItemStatus(workItemId); } catch { /* ignore */ }
    }
    orphans.push({
      branch: shortBranch,
      workItemId,
      aheadCount,
      headSha: sha,
      workItemStatus,
    });
  }

  return orphans.sort((a, b) => a.workItemId - b.workItemId);
}

function renderMarkdownReport({ projectName, orphans, baseBranch }) {
  const header = [
    `# Factory Orphan Branches — ${projectName}`,
    '',
    `Base branch: \`${baseBranch}\``,
    `Scan date: ${new Date().toISOString()}`,
    `Total orphans: ${orphans.length}`,
    '',
    'Each entry is an origin branch matching `feat/factory-<work_item_id>-*`',
    `with commits ahead of \`origin/${baseBranch}\` but never merged. Review and`,
    'either fast-forward the base, cherry-pick the relevant commits, or',
    'delete the branch to retire the work.',
    '',
  ].join('\n');

  if (orphans.length === 0) {
    return `${header}_No orphan factory branches detected._\n`;
  }

  const lines = [header];
  for (const o of orphans) {
    lines.push(`## Work item ${o.workItemId}`);
    lines.push('');
    lines.push(`- Branch: \`${o.branch}\``);
    lines.push(`- Commits ahead of \`${baseBranch}\`: ${o.aheadCount}`);
    lines.push(`- HEAD: \`${o.headSha}\``);
    lines.push(`- Work item status: ${o.workItemStatus || 'unknown'}`);
    lines.push('');
    lines.push('Recover with:');
    lines.push('');
    lines.push('```bash');
    lines.push(`git fetch origin ${o.branch}`);
    lines.push(`git log --oneline origin/${baseBranch}..origin/${o.branch}`);
    lines.push(`# If the work is good:`);
    lines.push(`git checkout ${baseBranch} && git merge --ff-only origin/${o.branch}`);
    lines.push(`# If obsolete:`);
    lines.push(`git push origin --delete ${o.branch}`);
    lines.push('```');
    lines.push('');
  }
  return lines.join('\n');
}

function writeOrphanFindings({ projectPath, projectName, orphans, outDir }) {
  const dir = outDir || path.join(projectPath, 'docs', 'findings');
  fs.mkdirSync(dir, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const slug = (projectName || 'project').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const file = path.join(dir, `${date}-factory-orphans-${slug}.md`);
  const baseBranch = detectBaseBranch(projectPath);
  fs.writeFileSync(file, renderMarkdownReport({ projectName: projectName || 'project', orphans, baseBranch }), 'utf8');
  logger.info('orphan-reconciler: findings written', {
    project: projectName,
    file,
    orphan_count: orphans.length,
  });
  return file;
}

module.exports = {
  findOrphanFactoryBranches,
  writeOrphanFindings,
  renderMarkdownReport,
  detectBaseBranch,
};
