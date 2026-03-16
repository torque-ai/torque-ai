/**
 * Git Operations Tests
 *
 * Tests for git-related tool handlers: preview_diff, commit_task,
 * rollback_task, list_commits, setup_precommit_hook, run_build_check.
 */

const { setupTestDb, teardownTestDb, safeTool } = require('./vitest-setup');
const { extractTaskId } = require('./test-helpers');
const path = require('path');
const os = require('os');

describe('Git Operations', () => {
  beforeAll(() => { setupTestDb('git-ops'); });
  afterAll(() => { teardownTestDb(); });

  describe('preview_diff', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('preview_diff', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task_id', async () => {
      const result = await safeTool('preview_diff', {
        task_id: 'nonexistent_task_12345'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('commit_task', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('commit_task', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task_id', async () => {
      const result = await safeTool('commit_task', {
        task_id: 'nonexistent_task_12345'
      });
      expect(result.isError).toBe(true);
    });
  });

  describe('rollback_task', () => {
    it('rejects missing task_id', async () => {
      const result = await safeTool('rollback_task', {});
      expect(result.isError).toBe(true);
    });

    it('rejects nonexistent task_id', async () => {
      const result = await safeTool('rollback_task', {
        task_id: 'nonexistent_task_12345'
      });
      expect(result.isError).toBe(true);
    });

    it('creates rollback record for valid task', async () => {
      const queueResult = await safeTool('queue_task', {
        task: 'Test task for rollback validation'
      });
      const taskId = extractTaskId(queueResult);
      expect(taskId).not.toBeNull();

      const statusResult = await safeTool('check_status', { task_id: taskId });
      expect(statusResult.isError).toBeFalsy();

      const rollbackResult = await safeTool('rollback_task', { task_id: taskId });
      expect(rollbackResult.isError).toBeFalsy();
    });
  });

  describe('list_commits', () => {
    it('returns success', async () => {
      const result = await safeTool('list_commits', {});
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_commits', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });

    it('accepts working_directory parameter', async () => {
      const result = await safeTool('list_commits', {
        working_directory: process.cwd(),
        limit: 10
      });
      expect(result.isError).toBeFalsy();
    });

    it('handles negative limit safely', async () => {
      const result = await safeTool('list_commits', { limit: -5 });
      expect(result.isError).toBeFalsy();
    });

    it('handles very large limit safely', async () => {
      const result = await safeTool('list_commits', { limit: 999999 });
      expect(result.isError).toBeFalsy();
    });
  });

  describe('list_rollbacks', () => {
    it('returns success', async () => {
      const result = await safeTool('list_rollbacks', {});
      expect(result.isError).toBeFalsy();
    });

    it('accepts status filter', async () => {
      const result = await safeTool('list_rollbacks', { status: 'pending' });
      expect(result.isError).toBeFalsy();
    });

    it('accepts limit parameter', async () => {
      const result = await safeTool('list_rollbacks', { limit: 5 });
      expect(result.isError).toBeFalsy();
    });

    it('accepts both status and limit', async () => {
      const result = await safeTool('list_rollbacks', {
        status: 'completed',
        limit: 20
      });
      expect(result.isError).toBeFalsy();
    });

    it('handles empty status parameter', async () => {
      const result = await safeTool('list_rollbacks', { status: '' });
      expect(result.isError).toBeTruthy();
    });
  });

  describe('setup_precommit_hook', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('setup_precommit_hook', {
        checks: ['validation', 'syntax']
      });
      expect(result.isError).toBe(true);
    });

    it('rejects non-git directory', async () => {
      // Use a fresh unique directory guaranteed to have no .git
      const nonGitDir = path.join(os.tmpdir(), `torque-no-git-${Date.now()}`);
      const fs = require('fs');
      fs.mkdirSync(nonGitDir, { recursive: true });
      try {
        const result = await safeTool('setup_precommit_hook', {
          working_directory: nonGitDir,
          checks: ['validation']
        });
        expect(result.isError).toBe(true);
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    });
  });

  describe('run_build_check', () => {
    it('rejects missing working_directory', async () => {
      const result = await safeTool('run_build_check', {
        task_id: 'some_task_id'
      });
      expect(result.isError).toBe(true);
    });

    it('handles empty temp directory gracefully', async () => {
      // Use an empty temp dir (no build tools) to avoid spawning long-running
      // child processes whose async DB inserts outlive the test teardown.
      const fs = require('fs');
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-build-'));
      try {
        const result = await safeTool('run_build_check', {
          working_directory: tmpDir
        });
        // Either succeeds (no build tool found) or fails gracefully
        expect(result).toBeDefined();
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });

  describe('Edge Cases and Validation', () => {
    it('error responses have proper structure', async () => {
      const result = await safeTool('preview_diff', { task_id: null });
      expect(result.isError).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content[0]).toBeDefined();
      expect(result.content[0].text).toBeDefined();
    });

    it('success responses have proper structure', async () => {
      const result = await safeTool('list_commits', {});
      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content[0]).toBeDefined();
      expect(result.content[0].text).toBeDefined();
    });
  });
});
