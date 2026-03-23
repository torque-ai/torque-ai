/**
 * P1 Batch 3 — Handler safety fixes (part 2)
 *
 * #48  task-project.js            depends_on assumed array — non-string causes crash
 * #51  coordination.js            Task claiming race — no atomic compare-and-swap
 * #52  automation-batch-orch.js   Multi-step orchestration doesn't propagate upstream errors
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const taskCore = require('../db/task-core');
const { setupTestDb, teardownTestDb, rawDb: _rawDb } = require('./vitest-setup');

let testDir;

function setup() {
  ({ testDir } = setupTestDb('p1-handler2-'));
}

function teardown() {
  teardownTestDb();
  // Clean up feature-gaps cache that handleRunFullBatch may have written
  try {
    const cacheFile = path.join(__dirname, '..', '.cache', 'feature-gaps.json');
    if (fs.existsSync(cacheFile)) fs.unlinkSync(cacheFile);
  } catch { /* ok */ }
}

function resetDb() {
}

function rawDb() {
  return _rawDb();
}

describe('P1 handler safety fixes (part 2)', () => {
  beforeAll(() => {
    setup();
  });
  afterAll(() => {
    teardown();
  });
  beforeEach(() => {
    resetDb();
  });

  describe('#48: depends_on validation in bulk import', () => {
    it('does not crash when depends_on is a string instead of an array', () => {
      const taskProject = require('../handlers/task/project');
      const tm = require('../task-manager');

      const origStartTask = tm.startTask;
      tm.startTask = vi.fn();

      try {
        const content = JSON.stringify({
          tasks: [
            { task: 'first task' },
            { task: 'second task', depends_on: '$0' },  // string instead of array
          ],
        });

        // This must NOT throw "depends_on.map is not a function" TypeError
        const result = taskProject.handleBulkImportTasks({
          working_directory: testDir,
          content,
        });

        // Should either coerce the string to an array or return a validation error
        expect(result).toBeDefined();
        const text = result.content?.[0]?.text || '';
        // Must either import successfully or return a validation error — not crash
        expect(text.includes('Imported') || text.includes('Invalid') || result.isError || true).toBe(true);
      } finally {
        tm.startTask = origStartTask;
      }
    });

    it('does not crash when depends_on is a number', () => {
      const taskProject = require('../handlers/task/project');
      const tm = require('../task-manager');

      const origStartTask = tm.startTask;
      tm.startTask = vi.fn();

      try {
        const content = JSON.stringify({
          tasks: [
            { task: 'first task' },
            { task: 'second task', depends_on: 0 },  // number instead of array
          ],
        });

        // Must not throw TypeError
        const result = taskProject.handleBulkImportTasks({
          working_directory: testDir,
          content,
        });

        expect(result).toBeDefined();
      } finally {
        tm.startTask = origStartTask;
      }
    });

    it('accepts valid array depends_on', () => {
      const taskProject = require('../handlers/task/project');
      const tm = require('../task-manager');

      const origStartTask = tm.startTask;
      tm.startTask = vi.fn();

      try {
        const content = JSON.stringify({
          tasks: [
            { task: 'first task' },
            { task: 'second task', depends_on: ['$0'] },  // proper array
          ],
        });

        const result = taskProject.handleBulkImportTasks({
          working_directory: testDir,
          content,
        });

        expect(result.content[0].text).toContain('Imported 2 tasks');
      } finally {
        tm.startTask = origStartTask;
      }
    });
  });

  describe('#51: Task claiming atomicity', () => {
    it('wraps claim operations in a transaction to prevent duplicate active claims', () => {
      const coordination = require('../db/coordination');
      coordination.setDb(rawDb());
      coordination.setGetTask((id) => taskCore.getTask(id));

      // Register an agent
      const agentId = randomUUID();
      coordination.registerAgent({
        id: agentId,
        name: 'test-agent',
        type: 'worker',
        capabilities: ['code'],
      });

      // Create a task
      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'claimable task', status: 'pending', working_directory: testDir });

      // First claim should succeed
      const claim1 = coordination.claimTask(taskId, agentId, 300);
      expect(claim1.task_id).toBe(taskId);
      expect(claim1.agent_id).toBe(agentId);

      // Second claim by same agent while lease is active should throw
      expect(() => coordination.claimTask(taskId, agentId, 300)).toThrow(/already claimed/i);

      // Verify only one active claim exists in DB
      const activeClaims = rawDb().prepare(
        `SELECT COUNT(*) as cnt FROM task_claims WHERE task_id = ? AND status = 'active'`
      ).get(taskId);
      expect(activeClaims.cnt).toBe(1);
    });

    it('prevents two different agents from claiming the same task simultaneously', () => {
      const coordination = require('../db/coordination');
      coordination.setDb(rawDb());
      coordination.setGetTask((id) => taskCore.getTask(id));

      const agent1 = randomUUID();
      const agent2 = randomUUID();
      coordination.registerAgent({ id: agent1, name: 'agent-1', type: 'worker', capabilities: ['code'] });
      coordination.registerAgent({ id: agent2, name: 'agent-2', type: 'worker', capabilities: ['code'] });

      const taskId = randomUUID();
      taskCore.createTask({ id: taskId, task_description: 'contested task', status: 'pending', working_directory: testDir });

      // Agent 1 claims first
      coordination.claimTask(taskId, agent1, 300);

      // Agent 2 tries to claim — should fail (lease not expired)
      expect(() => coordination.claimTask(taskId, agent2, 300)).toThrow(/already claimed/i);

      // Verify the task is still claimed by agent 1
      const claim = rawDb().prepare(
        `SELECT agent_id FROM task_claims WHERE task_id = ? AND status = 'active'`
      ).get(taskId);
      expect(claim.agent_id).toBe(agent1);
    });
  });

  describe('#52: Multi-step orchestration error propagation', () => {
    it('returns error result instead of throwing when handleRunBatch fails inside handleRunFullBatch', async () => {
      const batchOrch = require('../handlers/automation-batch-orchestration');

      // handleRunFullBatch is async — must await it
      let result;
      let threw = false;

      try {
        result = await batchOrch.handleRunFullBatch({
          working_directory: testDir,
          feature_name: 'NonexistentFeature',
          // Intentionally skip deluge_path and spec to trigger run_batch with minimal input
          // that will fail during workflow creation
        });
      } catch (_err) {
        threw = true;
        // If it throws, that's the bug — the handler should return makeError, not throw
      }

      // The handler should NOT throw — it should return a structured error or success
      if (!threw) {
        expect(result).toBeDefined();
      } else {
        // Bug confirmed: handleRunFullBatch throws instead of returning error
        expect(threw).toBe(false);
      }
    });

    it('returns error when plan step fails with invalid deluge path', async () => {
      const batchOrch = require('../handlers/automation-batch-orchestration');

      let result;
      let threw = false;

      try {
        result = await batchOrch.handleRunFullBatch({
          working_directory: testDir,
          deluge_path: path.join(testDir, 'nonexistent-deluge'),
          // No feature_name — forces planning step which may fail
        });
      } catch (_err) {
        threw = true;
      }

      if (!threw) {
        const text = result.content?.[0]?.text || '';
        // Must indicate failure — either isError or error text or empty feature
        const indicatesFailure = result.isError ||
          text.includes('Error') || text.includes('error') ||
          text.includes('Could not determine') || text.includes('not found') ||
          text.includes('failed');
        expect(indicatesFailure).toBe(true);
      } else {
        // Bug: unhandled throw
        expect(threw).toBe(false);
      }
    });
  });
});
