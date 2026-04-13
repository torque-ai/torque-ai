import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const dataDir = require('../data-dir');

let db;
let routing;
let taskCore;
let taskManager;
let configCore;
let testDir;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForTaskToLeavePending(taskId, timeoutMs = 1000) {
  const startedAt = Date.now();
  let lastTask = taskCore.getTask(taskId);

  while (Date.now() - startedAt < timeoutMs) {
    lastTask = taskCore.getTask(taskId);
    if (lastTask && lastTask.status !== 'pending') {
      return lastTask;
    }
    await sleep(25);
  }

  return lastTask;
}

describe('factory plan generation scheduling', () => {
  beforeAll(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factory-plan-gen-scheduling-'));
    process.env.TORQUE_DATA_DIR = testDir;
    dataDir.setDataDir(null);

    db = require('../database');
    db.init();

    routing = require('../handlers/integration/routing');
    taskCore = require('../db/task-core');
    taskManager = require('../task-manager');
    configCore = require('../db/config-core');

    taskManager.initEarlyDeps();
    taskManager.initSubModules();
  });

  afterAll(() => {
    try {
      db?.close?.();
    } finally {
      if (testDir && fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
      delete process.env.TORQUE_DATA_DIR;
      dataDir.setDataDir(null);
    }
  });

  beforeEach(() => {
    taskManager._testing.resetForTest();
    taskManager._testing.skipGitInCloseHandler = true;

    configCore.setConfig('codex_enabled', '0');
    configCore.setConfig('claude_cli_enabled', '1');
    configCore.setConfig('discovery_enabled', '0');
    configCore.setConfig('health_check_interval_seconds', '99999');
    configCore.setConfig('activity_poll_interval_seconds', '99999');
  });

  it('queues factory-architect smart-submit tasks instead of leaving them pending', async () => {
    const workingDirectory = fs.mkdtempSync(path.join(testDir, 'factory-architect-'));
    const prompt = [
      '# Auto-generate a factory execution plan',
      '',
      'Create a concise markdown plan for a non-plan-file work item.',
    ].join('\n');

    const result = await routing.handleSmartSubmitTask({
      task: prompt,
      project: 'factory-architect',
      provider: 'codex',
      working_directory: workingDirectory,
      timeout_minutes: 10,
      version_intent: 'internal',
      tags: [
        'factory:internal',
        'factory:plan_generation',
        'factory:project_id=test-project',
        'factory:work_item_id=42',
      ],
      task_metadata: {
        factory_internal: true,
        execute_plan_generation: true,
        project_id: 'test-project',
        work_item_id: 42,
      },
    });

    expect(result?.task_id).toBeTruthy();

    const task = await waitForTaskToLeavePending(result.task_id, 1000);
    expect(task).toBeTruthy();
    expect(task.status).toMatch(/^(queued|running)$/);
    expect(task.project).toBe('factory-architect');
    expect(task.provider).toBe('codex');
    expect(task.tags).toEqual(expect.arrayContaining([
      'factory:internal',
      'factory:plan_generation',
      'factory:project_id=test-project',
      'factory:work_item_id=42',
      'project:factory-architect',
    ]));

    const projectConfigRow = db.getDbInstance()
      .prepare('SELECT project FROM project_config WHERE project = ?')
      .get('factory-architect');
    expect(projectConfigRow).toEqual({ project: 'factory-architect' });
  });
});
