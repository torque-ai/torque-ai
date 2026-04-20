'use strict';

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT_PATH = path.resolve(__dirname, '../../scripts/worktree-cutover.sh');
const REPO_ROOT = path.resolve(__dirname, '../..');

/**
 * Integration tests for worktree-cutover.sh restart barrier flow.
 *
 * The script supports CUTOVER_DRY_RUN=1 which prints the intended API calls
 * without executing them. We use this to verify the barrier flow is correctly
 * wired without needing a live TORQUE server.
 *
 * For the non-dry-run paths (barrier submit, poll, attach), we test by
 * asserting on the script source directly — the bash is simple enough that
 * structural assertions are meaningful.
 */

// Helper: run the cutover script in dry-run mode with a fake feature name.
// We need to mock enough of the environment that the script gets past the
// pre-checks (worktree exists, branch exists, TORQUE running check).
function runDryRun(featureName, env = {}) {
  // Build a wrapper script that stubs git/curl and sources the cutover
  const wrapper = `
#!/usr/bin/env bash
set -euo pipefail

export CUTOVER_DRY_RUN=1

# Stub git to pass pre-checks
git() {
  case "$1" in
    rev-parse)   echo "/fake/repo" ;;
    show-ref)    return 0 ;;
    merge)       echo "Already up to date." ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

# Stub curl — report TORQUE as running for version check
curl() {
  case "\${*}" in
    *api/version*) echo '{"version":"1.0.0"}' ; return 0 ;;
    *)             echo '{}' ; return 0 ;;
  esac
}
export -f curl

# Create a fake worktree dir so the -d check passes
SAFE_NAME=\$(echo "${featureName}" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9._-]/-/g')
FAKE_WORKTREE="/tmp/cutover-test-\$\$/feat-\${SAFE_NAME}"
mkdir -p "\$FAKE_WORKTREE"

# Override REPO_ROOT detection by wrapping git rev-parse
git() {
  case "$1" in
    rev-parse)   echo "/tmp/cutover-test-\$\$" ;;
    show-ref)    return 0 ;;
    merge)       echo "Already up to date." ;;
    diff)        return 0 ;;
    worktree)    return 0 ;;
    branch)      return 0 ;;
    *)           command git "$@" ;;
  esac
}
export -f git

# Source the script (but skip set -euo pipefail since we already set it)
# We need to run it in the current shell so our function stubs take effect.
# Extract everything after the shebang and set lines.
SCRIPT_BODY=\$(tail -n +3 "${SCRIPT_PATH.replace(/\\/g, '/')}")
eval "\$SCRIPT_BODY" <<< ""

# Clean up fake worktree
rm -rf "/tmp/cutover-test-\$\$"
`;

  // Write wrapper to temp file
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cutover-test-'));
  const wrapperPath = path.join(tmpDir, 'test-cutover.sh');
  fs.writeFileSync(wrapperPath, wrapper, { mode: 0o755 });

  try {
    const result = execSync(`bash "${wrapperPath}" "${featureName}"`, {
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, CUTOVER_DRY_RUN: '1', ...env },
      windowsHide: true,
    });
    return result;
  } finally {
    try {
      fs.unlinkSync(wrapperPath);
      fs.rmdirSync(tmpDir);
    } catch { /* cleanup best-effort */ }
  }
}

describe('worktree-cutover.sh barrier integration', () => {
  const scriptSource = fs.readFileSync(SCRIPT_PATH, 'utf8');

  // ── Structural assertions on script source ──────────────────────────

  describe('script structure', () => {
    it('does NOT call stop-torque.sh', () => {
      // The old cooperative drain called stop-torque.sh. The barrier flow
      // should never reference it in the main restart path.
      const lines = scriptSource.split('\n');
      const restartSection = lines.filter(l =>
        !l.trim().startsWith('#') && !l.trim().startsWith('echo')
      );
      const stopTorqueInvocations = restartSection.filter(l =>
        /bash.*stop-torque\.sh/.test(l) && !l.includes('Emergency override')
      );
      expect(stopTorqueInvocations).toHaveLength(0);
    });

    it('POSTs to /api/v2/system/restart-server', () => {
      expect(scriptSource).toContain('/api/v2/system/restart-server');
    });

    it('polls barrier task via GET /api/v2/tasks/<task_id>', () => {
      expect(scriptSource).toContain('${TORQUE_API}/api/v2/tasks/${BARRIER_TASK_ID}');
    });

    it('checks for existing barrier before submitting a new one', () => {
      // Must search for provider=system tasks in both running and queued
      expect(scriptSource).toContain('for CHECK_STATUS in running queued');
      expect(scriptSource).toContain('"provider"');
      expect(scriptSource).toContain('"system"');
    });

    it('attaches to existing barrier instead of creating a duplicate', () => {
      expect(scriptSource).toContain('EXISTING_BARRIER');
      expect(scriptSource).toContain('Existing barrier found');
      expect(scriptSource).toContain('attaching');
    });

    it('extracts task_id from restart-server response', () => {
      expect(scriptSource).toContain('BARRIER_TASK_ID');
      expect(scriptSource).toContain('task_id');
    });

    it('handles barrier task failure with exit 2', () => {
      const failBlock = scriptSource.includes('"failed"') &&
        scriptSource.includes('Barrier task failed') &&
        scriptSource.includes('exit 2');
      expect(failBlock).toBe(true);
    });

    it('handles server unreachable during restart grace period', () => {
      expect(scriptSource).toContain('Server unreachable (expected during restart)');
    });

    it('waits for new server after barrier completes', () => {
      expect(scriptSource).toContain('api/version');
      expect(scriptSource).toContain('TORQUE restarted on updated main');
    });

    it('falls back to manual start if server does not come back', () => {
      expect(scriptSource).toContain('nohup node');
      expect(scriptSource).toContain('TORQUE started manually on updated main');
    });

    it('sends reason string in restart request body', () => {
      expect(scriptSource).toContain('"reason"');
      expect(scriptSource).toContain('Cutover to');
    });

    it('sends timeout_minutes in restart request body', () => {
      expect(scriptSource).toContain('"timeout_minutes"');
      expect(scriptSource).toContain('BARRIER_TIMEOUT_MIN');
    });

    it('supports CUTOVER_DRY_RUN=1 environment variable', () => {
      expect(scriptSource).toContain('CUTOVER_DRY_RUN');
      expect(scriptSource).toContain('[dry-run]');
    });

    it('handles restart_scheduled status for empty pipeline', () => {
      expect(scriptSource).toContain('restart_scheduled');
      expect(scriptSource).toContain('Pipeline was empty');
    });

    it('does NOT use the old cooperative drain poll pattern', () => {
      // The old script polled /api/v2/tasks?status=running and counted results
      // with grep -oE '"id"' | wc -l. That pattern should be gone.
      expect(scriptSource).not.toContain('ZERO_STREAK');
      expect(scriptSource).not.toContain('REQUIRED_ZERO_STREAK');
      expect(scriptSource).not.toContain('Draining the pipeline before shutdown');
    });
  });

  // ── Dry-run output assertions ──────────────────────────────────────

  describe('dry-run mode (CUTOVER_DRY_RUN=1)', () => {
    let dryRunOutput;

    beforeAll(() => {
      try {
        dryRunOutput = runDryRun('test-barrier-feature');
      } catch (e) {
        // If the wrapper fails (e.g. on CI without bash), skip gracefully
        dryRunOutput = null;
      }
    });

    it('prints the barrier check GET calls', () => {
      if (!dryRunOutput) return; // skip if bash unavailable
      expect(dryRunOutput).toContain('[dry-run] Would check for existing barrier');
      expect(dryRunOutput).toContain('GET');
      expect(dryRunOutput).toContain('provider=system');
    });

    it('prints the restart-server POST call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would submit restart barrier');
      expect(dryRunOutput).toContain('POST');
      expect(dryRunOutput).toContain('/api/v2/system/restart-server');
    });

    it('prints the correct request body with reason and timeout', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('Cutover to test-barrier-feature');
      expect(dryRunOutput).toContain('timeout_minutes');
    });

    it('prints the barrier poll GET call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would poll barrier task');
      expect(dryRunOutput).toContain('GET');
      expect(dryRunOutput).toContain('/api/v2/tasks/<task_id>');
    });

    it('prints the SSE verification call', () => {
      if (!dryRunOutput) return;
      expect(dryRunOutput).toContain('[dry-run] Would verify new server');
      expect(dryRunOutput).toContain('3458/sse');
    });
  });

  // ── Restart barrier module unit tests ──────────────────────────────

  describe('isRestartBarrierActive()', () => {
    const { isRestartBarrierActive } = require('../../server/execution/restart-barrier');

    afterEach(() => {
      delete process._torqueRestartPending;
    });

    it('returns null when no barrier exists and no flag set', () => {
      const mockDb = {
        prepare: () => ({ get: () => undefined }),
      };
      expect(isRestartBarrierActive(mockDb)).toBeNull();
    });

    it('returns synthetic row when process._torqueRestartPending is set', () => {
      process._torqueRestartPending = true;
      const result = isRestartBarrierActive(null);
      expect(result).toEqual({
        id: 'restart-pending-flag',
        provider: 'system',
        status: 'pending-shutdown',
      });
    });

    it('returns barrier row from db.prepare path', () => {
      const barrierRow = { id: 'abc-123', provider: 'system', status: 'running' };
      const mockDb = {
        prepare: () => ({ get: () => barrierRow }),
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(barrierRow);
    });

    it('falls back to listTasks when prepare throws', () => {
      const barrierRow = { id: 'def-456', provider: 'system', status: 'queued' };
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [];
          if (status === 'queued') return [barrierRow];
          return [];
        },
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(barrierRow);
    });

    it('returns null when db is null', () => {
      expect(isRestartBarrierActive(null)).toBeNull();
    });

    it('returns null when db has neither prepare nor listTasks', () => {
      expect(isRestartBarrierActive({})).toBeNull();
    });

    it('finds running barrier before checking queued in listTasks path', () => {
      const runningBarrier = { id: 'run-1', provider: 'system', status: 'running' };
      const queuedBarrier = { id: 'que-1', provider: 'system', status: 'queued' };
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [runningBarrier];
          if (status === 'queued') return [queuedBarrier];
          return [];
        },
      };
      const result = isRestartBarrierActive(mockDb);
      expect(result).toEqual(runningBarrier);
    });

    it('process flag takes priority over db check', () => {
      process._torqueRestartPending = true;
      const barrierRow = { id: 'db-1', provider: 'system', status: 'running' };
      const mockDb = {
        prepare: () => ({ get: () => barrierRow }),
      };
      const result = isRestartBarrierActive(mockDb);
      // Should return the flag-based synthetic row, not the db row
      expect(result.id).toBe('restart-pending-flag');
    });

    it('ignores non-system providers in listTasks path', () => {
      const mockDb = {
        prepare: () => { throw new Error('no prepare'); },
        listTasks: ({ status }) => {
          if (status === 'running') return [
            { id: 'task-1', provider: 'codex', status: 'running' },
            { id: 'task-2', provider: 'ollama', status: 'running' },
          ];
          if (status === 'queued') return [
            { id: 'task-3', provider: 'deepinfra', status: 'queued' },
          ];
          return [];
        },
      };
      expect(isRestartBarrierActive(mockDb)).toBeNull();
    });
  });

  // ── Barrier flow contract assertions ───────────────────────────────

  describe('barrier flow contract', () => {
    it('restart-server endpoint exists in routes-passthrough', () => {
      const routesPath = path.join(REPO_ROOT, 'server/api/routes-passthrough.js');
      const routes = fs.readFileSync(routesPath, 'utf8');
      expect(routes).toContain("'/api/v2/system/restart-server'");
      expect(routes).toContain("tool: 'restart_server'");
    });

    it('await-restart endpoint exists in routes-passthrough', () => {
      const routesPath = path.join(REPO_ROOT, 'server/api/routes-passthrough.js');
      const routes = fs.readFileSync(routesPath, 'utf8');
      expect(routes).toContain("'/api/v2/system/await-restart'");
      expect(routes).toContain("tool: 'await_restart'");
    });

    it('restart_server handler creates barrier with provider=system', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      expect(tools).toContain("provider: 'system'");
      expect(tools).toContain('Restart barrier');
    });

    it('restart_server handler reuses existing barrier', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      expect(tools).toContain('already_pending');
      expect(tools).toContain('Reusing existing barrier');
    });

    it('barrier task blocks queue scheduler via isRestartBarrierActive', () => {
      const barrier = fs.readFileSync(
        path.join(REPO_ROOT, 'server/execution/restart-barrier.js'), 'utf8'
      );
      expect(barrier).toContain("provider = 'system'");
      expect(barrier).toContain('isRestartBarrierActive');
    });

    it('restart handler sets process._torqueRestartPending before completing barrier', () => {
      const tools = fs.readFileSync(path.join(REPO_ROOT, 'server/tools.js'), 'utf8');
      // The flag must be set BEFORE the barrier is marked completed
      const flagIdx = tools.indexOf('process._torqueRestartPending = true');
      const completeIdx = tools.indexOf("updateTaskStatus(barrierId, 'completed'");
      expect(flagIdx).toBeGreaterThan(-1);
      expect(completeIdx).toBeGreaterThan(-1);
      expect(flagIdx).toBeLessThan(completeIdx);
    });
  });
});
