import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
const path = require('path');
const fs = require('fs');
const os = require('os');

const { probeStaleness } = require('../factory/stale-probe');
const { DEFAULT_PROMOTION_CONFIG } = require('../factory/promotion-policy');

function mkScoutItem(over = {}) {
  return {
    id: 1,
    source: 'scout',
    created_at: '2026-04-20T00:00:00Z',
    origin: over.origin ?? { target_file: 'src/foo.js', severity: 'HIGH', variant: 'security' },
    ...over,
  };
}

describe('stale-probe.probeStaleness', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-probe-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('Gate 1: non-scout item skips with reason not_scout_eligible', async () => {
    const item = { id: 1, source: 'plan_file', origin: { target_file: 'x.js' }, created_at: '2026-04-20T00:00:00Z' };
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('not_scout_eligible');
  });

  it('Gate 1: missing target_file skips with reason no_target_file', async () => {
    const item = mkScoutItem({ origin: { severity: 'HIGH' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('no_target_file');
  });

  it('Gate 1: stale_probe_enabled=false skips with reason probe_disabled', async () => {
    const item = mkScoutItem();
    const cfg = { ...DEFAULT_PROMOTION_CONFIG, stale_probe_enabled: false };
    const out = await probeStaleness(item, { projectPath: tmpDir, promotionConfig: cfg });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_disabled');
  });

  it('Gate 2: path traversal target is rejected', async () => {
    const item = mkScoutItem({ origin: { target_file: '../outside.js', severity: 'HIGH', variant: 'security' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('invalid_target_path');
  });

  it('Gate 3: target_file missing -> stale with reason target_file_deleted', async () => {
    const item = mkScoutItem({ origin: { target_file: 'does/not/exist.js', severity: 'HIGH', variant: 'security' } });
    const out = await probeStaleness(item, { projectPath: tmpDir });
    expect(out.stale).toBe(true);
    expect(out.reason).toBe('target_file_deleted');
    expect(out.commits_since_scan).toBe(0);
  });

  it('Gate 4: zero commits since scan -> not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: '' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('no_commits_since_scan');
    expect(out.commits_since_scan).toBe(0);
  });

  it('Gate 4: fewer than threshold commits -> minor churn, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: 'abc123\ndef456\n' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('minor_churn_probably_valid');
    expect(out.commits_since_scan).toBe(2);
  });

  it('Gate 4: threshold or more commits -> substantial churn, stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const manyCommits = Array.from({ length: 6 }, (_, i) => `hash${i}`).join('\n');
    const gitRunner = vi.fn().mockResolvedValue({ stdout: manyCommits });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(true);
    expect(out.reason).toBe('substantial_churn');
    expect(out.commits_since_scan).toBe(6);
  });

  it('git timeout -> not stale (fail-open)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    // The runner is now responsible for honoring timeoutMs and rejecting
    // with code 'PROBE_TIMEOUT' (defaultGitRunner does this via execFile's
    // own timeout option, which SIGKILLs the child rather than leaking it).
    const timeoutRunner = vi.fn().mockImplementation((_cwd, _args, opts) => {
      const timeoutMs = opts && opts.timeoutMs;
      const err = new Error('probe_timeout');
      err.code = 'PROBE_TIMEOUT';
      err.killed = true;
      err.signal = 'SIGKILL';
      err.timeoutMs = timeoutMs;
      return Promise.reject(err);
    });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner: timeoutRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_timeout');
    expect(timeoutRunner).toHaveBeenCalledWith(
      tmpDir,
      expect.any(Array),
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
  });

  it('git throws ENOENT -> git_unavailable, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const err = new Error('spawn git ENOENT');
    err.code = 'ENOENT';
    const gitRunner = vi.fn().mockRejectedValue(err);
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('git_unavailable');
  });

  it('gitRunner throws anything else -> probe_errored, not stale', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockRejectedValue(new Error('unexpected'));
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(out.stale).toBe(false);
    expect(out.reason).toBe('probe_errored');
  });

  it('result object includes probe_ms timing', async () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.js'), 'content');
    const item = mkScoutItem({ origin: { target_file: 'foo.js', severity: 'HIGH', variant: 'security' } });
    const gitRunner = vi.fn().mockResolvedValue({ stdout: '' });
    const out = await probeStaleness(item, { projectPath: tmpDir, gitRunner });
    expect(typeof out.probe_ms).toBe('number');
    expect(out.probe_ms).toBeGreaterThanOrEqual(0);
  });
});
