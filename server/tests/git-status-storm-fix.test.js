'use strict';

/**
 * Tests for git-status storm prevention (server/docs/investigations/git-status-storm.md)
 *
 * Verifies three fix mechanisms:
 * 1. TTL cache in getWorktreeFingerprint — prevents duplicate git spawns
 * 2. skipGitCheck flag — status rendering paths never trigger git
 * 3. Cache invalidation — explicit clear after known git operations
 */

const fs = require('fs');
const path = require('path');
const { createTestRepoWithCommit, commitFile, cleanupRepo } = require('./git-test-utils');
const { getWorktreeFingerprint, invalidateFingerprintCache, _fingerprintCache } = require('../utils/git');

describe('Git Status Storm Fix', () => {
  let repoDir;

  beforeAll(() => {
    repoDir = createTestRepoWithCommit('storm-fix');
  });

  afterAll(() => {
    cleanupRepo(repoDir);
  });

  beforeEach(() => {
    invalidateFingerprintCache(); // clean slate for every test
  });

  // ── TTL Cache Tests ─────────────────────────────────────────────

  describe('getWorktreeFingerprint TTL cache', () => {
    it('returns a non-empty fingerprint for a valid git repo', () => {
      const fp = getWorktreeFingerprint(repoDir);
      expect(fp).toBeTruthy();
      expect(typeof fp).toBe('string');
    });

    it('returns cached result on second call within TTL', () => {
      const fp1 = getWorktreeFingerprint(repoDir);
      // Mutate the repo — if cache works, fingerprint stays the same
      fs.writeFileSync(path.join(repoDir, 'noise.txt'), 'cache-test');
      const fp2 = getWorktreeFingerprint(repoDir);

      expect(fp2).toBe(fp1); // same cached result, git not re-invoked
    });

    it('refreshes fingerprint after TTL expires', () => {
      const fp1 = getWorktreeFingerprint(repoDir, { ttl: 1 }); // 1ms TTL

      // Write a new file so the repo state actually changes
      fs.writeFileSync(path.join(repoDir, 'after-ttl.txt'), 'new-content');

      // Wait for TTL to expire
      const start = Date.now();
      while (Date.now() - start < 5) { /* spin */ }

      const fp2 = getWorktreeFingerprint(repoDir, { ttl: 1 });
      expect(fp2).not.toBe(fp1); // should reflect new untracked file
    });

    it('caches per working directory independently', () => {
      const repoDir2 = createTestRepoWithCommit('storm-fix-2');
      try {
        const fp1 = getWorktreeFingerprint(repoDir);
        const fp2 = getWorktreeFingerprint(repoDir2);

        // Different repos → different fingerprints
        expect(fp1).not.toBe(fp2);
        // Both cached
        expect(_fingerprintCache.has(repoDir)).toBe(true);
        expect(_fingerprintCache.has(repoDir2)).toBe(true);
      } finally {
        cleanupRepo(repoDir2);
      }
    });

    it('deduplicates concurrent calls via cache hit', () => {
      // First call populates the cache
      getWorktreeFingerprint(repoDir);
      const cacheEntry = _fingerprintCache.get(repoDir);
      expect(cacheEntry).toBeDefined();
      const cachedTimestamp = cacheEntry.timestamp;

      // Immediate second call should reuse cache (timestamp unchanged)
      getWorktreeFingerprint(repoDir);
      const cacheEntry2 = _fingerprintCache.get(repoDir);
      expect(cacheEntry2.timestamp).toBe(cachedTimestamp);
    });
  });

  // ── Cache Invalidation Tests ────────────────────────────────────

  describe('invalidateFingerprintCache', () => {
    it('clears cache for a specific directory', () => {
      getWorktreeFingerprint(repoDir);
      expect(_fingerprintCache.has(repoDir)).toBe(true);

      invalidateFingerprintCache(repoDir);
      expect(_fingerprintCache.has(repoDir)).toBe(false);
    });

    it('clears all cached entries when no directory specified', () => {
      const repoDir2 = createTestRepoWithCommit('storm-fix-clear');
      try {
        getWorktreeFingerprint(repoDir);
        getWorktreeFingerprint(repoDir2);
        expect(_fingerprintCache.size).toBeGreaterThanOrEqual(2);

        invalidateFingerprintCache();
        expect(_fingerprintCache.size).toBe(0);
      } finally {
        cleanupRepo(repoDir2);
      }
    });

    it('allows fresh fingerprint after invalidation', () => {
      const fp1 = getWorktreeFingerprint(repoDir);

      // Change repo state
      fs.writeFileSync(path.join(repoDir, 'post-invalidate.txt'), 'content');

      // Without invalidation, cache returns stale fp
      const fpStale = getWorktreeFingerprint(repoDir);
      expect(fpStale).toBe(fp1);

      // After invalidation, returns fresh fp reflecting the new file
      invalidateFingerprintCache(repoDir);
      const fpFresh = getWorktreeFingerprint(repoDir);
      expect(fpFresh).not.toBe(fp1);
    });
  });

  // ── skipGitCheck in getTaskActivity ─────────────────────────────

  describe('skipGitCheck prevents git calls in status rendering', () => {
    let activityMonitoring;
    let runningProcesses;

    beforeEach(() => {
      // Fresh require to avoid state leakage
      activityMonitoring = require('../utils/activity-monitoring');
      runningProcesses = new Map();
      activityMonitoring.init({
        runningProcesses,
        getStallThreshold: () => 60, // 60s threshold
        safeConfigInt: () => 10,
        getSkipGitInCloseHandler: () => false,
      });
    });

    function makeStalledAgentProc(provider = 'codex') {
      return {
        process: {},
        model: 'gpt-5.3-codex-spark',
        provider,
        metadata: {},
        lastOutputAt: Date.now() - 120_000, // 120s ago — exceeds 60s threshold
        output: '',
        errorOutput: '',
        startTime: Date.now() - 300_000,
        lastFsFingerprint: 'old-fingerprint',
        stallWarned: false,
        workingDirectory: repoDir,
      };
    }

    it('with skipGitCheck:true, reports stalled WITHOUT calling filesystem check', () => {
      runningProcesses.set('stalled-1', makeStalledAgentProc('codex'));

      const activity = activityMonitoring.getTaskActivity('stalled-1', { skipGitCheck: true });

      // Should report stalled because we skipped the filesystem rescue
      expect(activity).not.toBeNull();
      expect(activity.isStalled).toBe(true);
      // The lastFsFingerprint should NOT have been updated (no git call)
      expect(runningProcesses.get('stalled-1').lastFsFingerprint).toBe('old-fingerprint');
    });

    it('with skipGitCheck:true, does not update lastOutputAt on stalled agent', () => {
      const proc = makeStalledAgentProc('claude-cli');
      const originalOutputAt = proc.lastOutputAt;
      runningProcesses.set('stalled-2', proc);

      activityMonitoring.getTaskActivity('stalled-2', { skipGitCheck: true });

      // lastOutputAt unchanged — no filesystem activity detected
      expect(proc.lastOutputAt).toBe(originalOutputAt);
    });

    it('without skipGitCheck, stalled agent triggers filesystem check', () => {
      const proc = makeStalledAgentProc('codex');
      runningProcesses.set('stalled-3', proc);

      const activity = activityMonitoring.getTaskActivity('stalled-3');

      // The real repo has changed since 'old-fingerprint',
      // so filesystem activity should be detected
      expect(activity).not.toBeNull();
      expect(activity.isStalled).toBe(false); // rescued by filesystem activity
      // Fingerprint should have been updated
      expect(proc.lastFsFingerprint).not.toBe('old-fingerprint');
    });

    it('non-agent providers are unaffected by skipGitCheck', () => {
      // Ollama is not in AGENT_PROVIDERS — skipGitCheck doesn't matter
      const proc = makeStalledAgentProc('ollama');
      runningProcesses.set('stalled-4', proc);

      const withSkip = activityMonitoring.getTaskActivity('stalled-4', { skipGitCheck: true });
      // Reset for second call
      proc.stallWarned = false;
      const withoutSkip = activityMonitoring.getTaskActivity('stalled-4');

      // Both report stalled — ollama doesn't get filesystem rescue either way
      expect(withSkip.isStalled).toBe(true);
      expect(withoutSkip.isStalled).toBe(true);
    });
  });

  // ── Fingerprint change detection ────────────────────────────────

  describe('checkFilesystemActivity via fingerprint', () => {
    let activityMonitoring;
    let runningProcesses;

    beforeEach(() => {
      activityMonitoring = require('../utils/activity-monitoring');
      runningProcesses = new Map();
      activityMonitoring.init({
        runningProcesses,
        getStallThreshold: () => 60,
        safeConfigInt: () => 10,
        getSkipGitInCloseHandler: () => false,
      });
      invalidateFingerprintCache();
    });

    it('detects filesystem change and resets stall state', () => {
      // Seed with a known fingerprint, then change the repo
      const oldFp = getWorktreeFingerprint(repoDir);
      invalidateFingerprintCache(repoDir);

      const proc = {
        process: {},
        model: 'gpt-5.3-codex-spark',
        provider: 'codex',
        metadata: {},
        lastOutputAt: Date.now() - 120_000,
        output: '',
        errorOutput: '',
        startTime: Date.now() - 300_000,
        lastFsFingerprint: oldFp,
        stallWarned: true,
        workingDirectory: repoDir,
      };
      runningProcesses.set('active-agent', proc);

      // Change the repo so fingerprint differs
      const marker = path.join(repoDir, `activity-marker-${Date.now()}.txt`);
      fs.writeFileSync(marker, 'agent wrote this');

      const activity = activityMonitoring.getTaskActivity('active-agent');

      expect(activity.isStalled).toBe(false); // rescued
      expect(proc.stallWarned).toBe(false); // reset
      expect(proc.lastFsFingerprint).not.toBe(oldFp); // updated
    });

    it('seeds fingerprint on first check without declaring activity', () => {
      const proc = {
        process: {},
        model: 'gpt-5.3-codex-spark',
        provider: 'codex',
        metadata: {},
        lastOutputAt: Date.now() - 120_000,
        output: '',
        errorOutput: '',
        startTime: Date.now() - 300_000,
        lastFsFingerprint: null, // first check — no prior fingerprint
        stallWarned: false,
        workingDirectory: repoDir,
      };
      runningProcesses.set('new-agent', proc);

      const activity = activityMonitoring.getTaskActivity('new-agent');

      // First check seeds the fingerprint but can't compare, so stall stands
      expect(activity.isStalled).toBe(true);
      expect(proc.lastFsFingerprint).toBeTruthy(); // seeded
    });
  });
});
