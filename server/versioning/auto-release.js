'use strict';

const { randomUUID } = require('crypto');
const { highestIntent, intentToBump, getVersioningConfig } = require('./version-intent');

function createAutoReleaseService({ db, releaseManager, changelogGenerator, logger }) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('auto-release service requires db with prepare()');
  }
  if (!releaseManager) throw new Error('auto-release service requires releaseManager');
  if (!changelogGenerator) throw new Error('auto-release service requires changelogGenerator');
  const log = logger || console;

  function hasColumn(name) {
    try {
      const cols = db.prepare("PRAGMA table_info('vc_commits')").all().map(c => c.name);
      return cols.includes(name);
    } catch {
      return false;
    }
  }

  function getUnreleasedCommits(repoPath) {
    const tsCol = hasColumn('generated_at') ? 'generated_at' : 'created_at';
    return db.prepare(
      `SELECT * FROM vc_commits WHERE repo_path = ? AND release_id IS NULL ORDER BY ${tsCol} ASC`
    ).all(repoPath);
  }

  function calculateBump(commits) {
    const intents = commits.map(c => c.version_intent || 'internal');
    const intent = highestIntent(intents);
    return intentToBump(intent);
  }

  function cutRelease(repoPath, { workflowId, taskId, trigger }) {
    const config = getVersioningConfig(db, repoPath);
    if (!config || !config.enabled) {
      return null;
    }

    const unreleased = getUnreleasedCommits(repoPath);
    if (unreleased.length === 0) {
      log.info(`[auto-release] No unreleased commits for ${repoPath}`);
      return null;
    }

    const bump = calculateBump(unreleased);
    if (!bump) {
      log.info(`[auto-release] All commits are internal for ${repoPath}, skipping release`);
      return null;
    }

    let releaseResult;
    try {
      releaseResult = releaseManager.createRelease(repoPath, {
        push: config.auto_push,
        startVersion: config.start,
      });
    } catch (err) {
      log.error(`[auto-release] Failed to create release for ${repoPath}: ${err.message}`);
      return null;
    }

    let changelog = '';
    try {
      changelog = changelogGenerator.generateChangelog(repoPath, {
        version: releaseResult.version,
      });
      if (changelog) {
        changelogGenerator.updateChangelogFile(repoPath, releaseResult.version, changelog);
      }
    } catch (err) {
      log.info(`[auto-release] Changelog generation failed (non-fatal): ${err.message}`);
    }

    const releaseId = randomUUID();
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT INTO vc_releases (id, repo_path, version, tag, bump_type, changelog, commit_count, files_changed, workflow_id, task_id, trigger, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        releaseId, repoPath, releaseResult.version, releaseResult.tag, bump,
        changelog || null, unreleased.length, 0,
        workflowId || null, taskId || null, trigger, now
      );
    } catch (err) {
      log.error(`[auto-release] Failed to record release: ${err.message}`);
    }

    try {
      const commitIds = unreleased.map(c => c.id);
      const placeholders = commitIds.map(() => '?').join(',');
      db.prepare(`UPDATE vc_commits SET release_id = ? WHERE id IN (${placeholders})`).run(releaseId, ...commitIds);
    } catch (err) {
      log.info(`[auto-release] Failed to link commits to release: ${err.message}`);
    }

    log.info(`[auto-release] Released ${releaseResult.tag} (${bump}) for ${repoPath}`);

    return {
      releaseId,
      version: releaseResult.version,
      tag: releaseResult.tag,
      bump,
      commitCount: unreleased.length,
      pushed: releaseResult.pushed,
    };
  }

  return { cutRelease, getUnreleasedCommits, calculateBump };
}

module.exports = { createAutoReleaseService };
