import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { gitSync } = require('./git-test-utils');

const handlers = require('../handlers/automation-batch-orchestration');
const automationHandlers = require('../handlers/automation-handlers');
const configCore = require('../db/config-core');
const schedulingAutomation = require('../db/scheduling-automation');
const taskCore = require('../db/task-core');
const fileTracking = require('../db/file-tracking');
const workflowEngine = require('../db/workflow-engine');
const projectConfigCore = require('../db/project-config-core');
const mockTaskManager = require('../task-manager');
const { ErrorCodes: _ErrorCodes } = require('../handlers/shared');
const { createConfigMock } = require('./test-helpers');

function setDbDefaults() {
  vi.spyOn(configCore, 'getConfig').mockImplementation(createConfigMock());
  vi.spyOn(configCore, 'setConfig').mockImplementation(() => undefined);
  vi.spyOn(schedulingAutomation, 'listScheduledTasks').mockReturnValue([]);
  vi.spyOn(schedulingAutomation, 'createCronScheduledTask').mockImplementation((name) => ({ id: 'sched-1', name }));
  vi.spyOn(taskCore, 'getTask').mockReturnValue(null);
  vi.spyOn(fileTracking, 'getTaskFileChanges').mockReturnValue([]);
  vi.spyOn(workflowEngine, 'getWorkflowTasks').mockReturnValue([]);
  vi.spyOn(taskCore, 'listTasks').mockReturnValue({ tasks: [], pagination: {} });
  vi.spyOn(workflowEngine, 'getWorkflow').mockReturnValue(null);
  vi.spyOn(workflowEngine, 'getWorkflowStatus').mockReturnValue(null);
  vi.spyOn(projectConfigCore, 'getProjectFromPath').mockReturnValue('project-1');
  vi.spyOn(projectConfigCore, 'getProjectMetadata').mockReturnValue(null);
  vi.spyOn(taskCore, 'createTask').mockImplementation((task) => ({ ...task, id: task.id }));

  vi.spyOn(mockTaskManager, 'startTask').mockImplementation(() => undefined);
}

const tempRoots = [];

function createTempDir(prefix = 'torque-batch-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(dir);
  return dir;
}

function cleanupTempDirs() {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

function extractJsonBlock(text) {
  const match = text.match(/```json\n([\s\S]+?)\n```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function createFeatureFixture(workingDir) {
  const srcDir = path.join(workingDir, 'src');
  const typesDir = path.join(srcDir, 'types');
  const systemsDir = path.join(srcDir, 'systems');
  const dataDir = path.join(srcDir, 'data');
  const testsDir = path.join(systemsDir, '__tests__');
  const scenesDir = path.join(srcDir, 'scenes');

  [typesDir, systemsDir, dataDir, testsDir, scenesDir].forEach((dir) => {
    fs.mkdirSync(dir, { recursive: true });
  });

  fs.writeFileSync(
    path.join(systemsDir, 'EventSystem.ts'),
    `export interface GameEvents {
  app_started: {
    userId: string;
  };
  order_completed: {
    orderId: string;
  };
}
`
  );

  fs.writeFileSync(
    path.join(systemsDir, 'NotificationBridge.ts'),
    `export type NotificationEvent = 'order_completed' | 'order_canceled';`
  );

  fs.writeFileSync(
    path.join(systemsDir, 'SampleSystem.ts'),
    `export class SampleSystem { }`
  );

  fs.writeFileSync(
    path.join(typesDir, 'order-flow.ts'),
    `export interface OrderFlowEntity { id: string; }`
  );

  fs.writeFileSync(
    path.join(dataDir, 'order-flows.ts'),
    `export const seed = []`
  );

  fs.writeFileSync(
    path.join(testsDir, 'sample-system.test.ts'),
    `import { describe, it, expect } from 'vitest';`
  );

  fs.writeFileSync(
    path.join(scenesDir, 'GameScene.ts'),
    `import { SampleSystem } from "../systems/SampleSystem";

export class GameScene {
  private sampleSystem!: SampleSystem;

  create() {
    this.sampleSystem = new SampleSystem();
  }
}`
  );
}

function createPlanFixture(workingDir) {
  const plansDir = path.join(workingDir, 'docs', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const planPath = path.join(plansDir, 'plan-14-donation-points.md');

  const planContent = `# Plan 14: Donation Points

## Overview

Donation points coordinate community rewards and tracking.

## Phase 1

Foundation schema for point awards.

\`\`\`prisma
model Reward {
  id       String @id
  userId   String
  amount   Float
  status   String // pending, granted, redeemed
  createdAt DateTime
}

model RewardLedger {
  id       String @id
  rewardId String
  total    Float
  type     String // credit, debit
  date     DateTime
}
\`\`\`

## Phase 2

Add redemption and reporting.
`;

  fs.writeFileSync(planPath, planContent);
  return planPath;
}

function createJsSource(workingDir, relativePath, lines = 24) {
  const fullPath = path.join(workingDir, 'src', relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  const content = Array.from({ length: lines }).map((_, i) => `export const value${i} = ${i};`).join('\n');
  fs.writeFileSync(fullPath, content);
  return path.relative(workingDir, fullPath).replace(/\\/g, '/');
}

function initGitRepo(workingDir) {
  gitSync(['init'], { cwd: workingDir });
  gitSync(['config', 'user.name', 'Test User'], { cwd: workingDir });
  gitSync(['config', 'user.email', 'test@example.com'], { cwd: workingDir });
}

function commitAll(workingDir, message = 'init') {
  gitSync(['add', '--all'], { cwd: workingDir });
  gitSync(['commit', '-m', message, '--no-gpg-sign'], { cwd: workingDir });
}

function isUnderGitDirectory(testDir) {
  let cursor = path.resolve(testDir);
  while (cursor) {
    if (fs.existsSync(path.join(cursor, '.git'))) {
      return true;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return false;
    cursor = parent;
  }
  return false;
}

function createNonGitDir() {
  // Try os.tmpdir() first (always writable), then filesystem root as fallback
  const candidates = [os.tmpdir(), path.parse(process.cwd()).root];
  for (const base of candidates) {
    let nonGit;
    try {
      nonGit = fs.mkdtempSync(path.join(base, 'torque-non-git-'));
    } catch {
      continue; // base not writable (e.g., filesystem root on Linux CI)
    }
    if (!isUnderGitDirectory(nonGit)) {
      tempRoots.push(nonGit);
      return nonGit;
    }
    fs.rmSync(nonGit, { recursive: true, force: true });
  }
  throw new Error('Unable to create non-git directory in current environment');
}

describe('automation-batch-orchestration handlers', () => {
  beforeEach(() => {
    setDbDefaults();
  });

  afterEach(() => {
    cleanupTempDirs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('handleGenerateFeatureTasks', () => {
    it('returns error when working_directory is missing', () => {
      const result = handlers.handleGenerateFeatureTasks({});
      expect(result.content[0].text).toMatch(/working_directory/i);
      expect(result.isError).toBe(true);
    });

    it('returns error when feature_name is missing', () => {
      const result = handlers.handleGenerateFeatureTasks({ working_directory: '/tmp' });
      expect(result.content[0].text).toMatch(/feature_name/i);
      expect(result.isError).toBe(true);
    });

    it('generates six task descriptions for a valid feature with reference project files', () => {
      const workingDir = createTempDir();
      createFeatureFixture(workingDir);

      const result = handlers.handleGenerateFeatureTasks({
        working_directory: workingDir,
        feature_name: 'OrderFlow',
        feature_description: 'Track and score customer orders',
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      expect(result._tasks).toBeDefined();
      expect(text).toContain('Generated Task Descriptions: OrderFlowSystem');
      expect(text).toContain('#### types');
      expect(text).toContain('#### events');
      expect(text).toContain('#### data');
      expect(text).toContain('#### system');
      expect(text).toContain('#### tests');
      expect(text).toContain('#### wire');

      const sections = Object.keys(result._tasks);
      expect(sections).toEqual(expect.arrayContaining([
        'types',
        'events',
        'data',
        'system',
        'tests',
        'wire',
      ]));
      expect((text.match(/#### /g) || []).length).toBe(6);
      for (const section of sections) {
        expect(typeof result._tasks[section]).toBe('string');
        expect(result._tasks[section].trim().length).toBeGreaterThan(0);
      }

      expect(result._tasks.types).toContain('Track and score customer orders');
      expect(result._tasks.system).toContain('OrderFlowSystem');
      expect(result._tasks.events).toContain('order_completed');
      expect(result._tasks.wire).toContain('orderFlowSystem');
    });

    it('generates non-empty task descriptions with no optional reference files', () => {
      const workingDir = createTempDir();
      // Keep only required structure to verify fallback behavior
      fs.mkdirSync(path.join(workingDir, 'src', 'types'), { recursive: true });

      const result = handlers.handleGenerateFeatureTasks({
        working_directory: workingDir,
        feature_name: 'QuickShip',
        feature_description: 'Minimal feature fixture',
      });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      expect(text).toContain('Generated Task Descriptions: QuickShipSystem');
      expect(result._tasks.types).toContain('QuickShip');
      expect(result._tasks.events).toContain('Edit src/systems/EventSystem.ts');
      expect(result._tasks.system).toContain('Create src/systems/QuickShipSystem.ts implementing the QuickShip feature.');
      expect(result._tasks.tests).toContain('Create src/systems/__tests__/QuickShipSystem.test.ts');
      expect(result._tasks.wire).toContain('Edit two existing files');
    });
  });

  describe('handleCacheFeatureGaps', () => {
    it('returns error when headwaters_path is missing', () => {
      const result = handlers.handleCacheFeatureGaps({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/headwaters_path|working_directory/i);
    });

    it('returns error when deluge_path is missing', () => {
      const result = handlers.handleCacheFeatureGaps({ headwaters_path: '/tmp' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/deluge_path/i);
    });
  });

  describe('handleDetectFileConflicts', () => {
    it('returns error when workflow_id is missing', () => {
      const result = handlers.handleDetectFileConflicts({});
      expect(result.content[0].text).toMatch(/workflow_id/i);
      expect(result.isError).toBe(true);
    });

  it('returns error when workflow is missing', () => {
      const result = handlers.handleDetectFileConflicts({ workflow_id: 'missing-workflow' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/not found/i);
    });

    it('detects conflicts when completed tasks touch same file', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-conflict-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: {
            id: 'task-11111111',
            status: 'completed',
            node_id: 'order-system',
          },
          t2: {
            id: 'task-22222222',
            status: 'completed',
            node_id: 'wire-step',
          },
        },
      });

      taskCore.getTask.mockImplementation((id) => {
        if (id === 'task-11111111') {
          return { files_modified: JSON.stringify(['src/systems/Shared.ts']) };
        }
        if (id === 'task-22222222') {
          return { files_modified: JSON.stringify([{ path: 'src/systems/Shared.ts' }]) };
        }
        return null;
      });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Potential Conflict');
      expect(text).toContain('src/systems/Shared.ts');
      expect(text).toContain('order-system');
      expect(text).toContain('wire-step');
    });

    it('reports no conflicts when completed tasks modify disjoint files', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-clean-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: {
            id: 'task-11111111',
            status: 'completed',
            node_id: 'task-a',
          },
          t2: {
            id: 'task-22222222',
            status: 'pending',
            node_id: 'task-b',
          },
          t3: {
            id: 'task-33333333',
            status: 'completed',
            node_id: 'task-c',
          },
        },
      });

      taskCore.getTask.mockImplementation((id) => {
        if (id === 'task-11111111') {
          return { files_modified: JSON.stringify(['src/systems/Flow.ts']) };
        }
        if (id === 'task-33333333') {
          return { files_modified: JSON.stringify(['src/systems/Order.ts']) };
        }
        return null;
      });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Result: No Conflicts');
      expect(text).toContain('Task | Files');
      expect(text).toContain('No files were modified by multiple tasks');
    });

    it('includes completed-task file summary even with conflicts', () => {
      const workingDir = createTempDir();
      const workflowId = 'workflow-summary-1';

      workflowEngine.getWorkflow.mockReturnValue({
        id: workflowId,
        working_directory: workingDir,
      });

      workflowEngine.getWorkflowStatus.mockReturnValue({
        name: 'Feature Workflow',
        tasks: {
          t1: { id: 'task-aaaa1111', status: 'completed', node_id: 'node-a' },
          t2: { id: 'task-bbbb2222', status: 'completed', node_id: 'node-b' },
        },
      });

      taskCore.getTask.mockReturnValue({ files_modified: JSON.stringify(['src/data/shared.ts']) });

      const result = handlers.handleDetectFileConflicts({ workflow_id: workflowId });
      const text = result.content[0].text;

      expect(text).toContain('node-a');
      expect(text).toContain('node-b');
    });
  });

  describe('handleAutoCommitBatch', () => {
    it('returns error when working_directory is missing', async () => {
      const result = await handlers.handleAutoCommitBatch({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('rejects path traversal stage paths', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'safe.ts'), 'export const safe = true;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        stage_paths: ['../../etc/passwd'],
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(result.content[0].text).toContain('Invalid stage path: ../../etc/passwd');
    });

    it('rejects absolute paths outside working_directory for stage_paths', async () => {
      const workingDir = createTempDir();
      // Create outsidePath under os.tmpdir() to avoid permission issues on CI
      const outsidePath = fs.mkdtempSync(path.join(os.tmpdir(), 'outside-autocommit-root-'));
      tempRoots.push(outsidePath);
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'safe.ts'), 'export const safe = true;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        stage_paths: [outsidePath],
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(result.content[0].text).toContain(`Invalid stage path: ${outsidePath}`);
    });

    it('rejects non-git working_directory', async () => {
      const workingDir = createNonGitDir();
      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        test_count_command: 'node --version',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/git/i);
    });

    it('truncates commit messages over 4096 characters', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const filePath = path.join(workingDir, 'src', 'long-message-test.ts');
      fs.writeFileSync(filePath, 'export const x = 1;');
      commitAll(workingDir);
      fs.writeFileSync(filePath, 'export const x = 2;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        verify: false,
        push: false,
        commit_message: 'a'.repeat(5000),
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Warning: commit_message exceeded 4096 characters and was truncated.');
      expect(result.content[0].text).toContain(`Committed: "${'a'.repeat(4096)}"`);
    });

    it('commits only task-tracked files and leaves unrelated changes uncommitted', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const intendedPath = path.join(workingDir, 'src', 'intended.ts');
      const unrelatedPath = path.join(workingDir, 'src', 'unrelated.ts');
      fs.writeFileSync(intendedPath, 'export const intended = 1;');
      fs.writeFileSync(unrelatedPath, 'export const unrelated = 1;');
      commitAll(workingDir);

      fs.writeFileSync(intendedPath, 'export const intended = 2;');
      fs.writeFileSync(unrelatedPath, 'export const unrelated = 2;');
      fileTracking.getTaskFileChanges.mockImplementation((taskId) => (
        taskId === 'task-commit-1'
          ? [{ relative_path: 'src/intended.ts', is_outside_workdir: 0 }]
          : []
      ));
      taskCore.getTask.mockReturnValue({ files_modified: [] });

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        batch_name: 'scoped-batch',
        verify: false,
        push: false,
        task_id: 'task-commit-1',
        commit_message: 'feat: scoped batch commit',
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Committed: "feat: scoped batch commit"');

      const committedFiles = gitSync(['show', '--pretty=', '--name-only', 'HEAD'], {
        cwd: workingDir,
      }).split(/\r?\n/).filter(Boolean);
      expect(committedFiles).toContain('src/intended.ts');
      expect(committedFiles).not.toContain('src/unrelated.ts');

      const statusOutput = gitSync(['status', '--porcelain'], {
        cwd: workingDir,
      });
      expect(statusOutput).toContain('src/unrelated.ts');
      expect(statusOutput).not.toContain('src/intended.ts');
    });

    it('does not push by default after committing tracked changes', async () => {
      const workingDir = createTempDir();
      initGitRepo(workingDir);
      fs.mkdirSync(path.join(workingDir, 'src'), { recursive: true });
      const filePath = path.join(workingDir, 'src', 'no-push.ts');
      fs.writeFileSync(filePath, 'export const value = 1;');
      commitAll(workingDir);
      fs.writeFileSync(filePath, 'export const value = 2;');

      const result = await handlers.handleAutoCommitBatch({
        working_directory: workingDir,
        batch_name: 'default-no-push',
        verify: false,
        commit_message: 'feat: commit without push',
        test_count_command: 'node --version',
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Committed: "feat: commit without push"');
      expect(result.content[0].text).toContain('- **Pushed:** No');
      expect(result.content[0].text).not.toContain('### Step 4: Push');
    });
  });

  describe('handleExtractFeatureSpec', () => {
    it('returns error when plan_path is missing', () => {
      const result = handlers.handleExtractFeatureSpec({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/plan_path/i);
    });

    it('returns error when plan file does not exist', () => {
      const result = handlers.handleExtractFeatureSpec({ plan_path: '/nonexistent/plan.md' });
      expect(result.isError).toBe(true);
    });

    it('extracts entities and fields from prisma blocks', () => {
      const workingDir = createTempDir();
      const planPath = createPlanFixture(workingDir);

      const result = handlers.handleExtractFeatureSpec({ plan_path: planPath });

      expect(result.isError).toBeFalsy();
      const text = result.content[0].text;

      expect(result._spec).toBeDefined();
      expect(result._spec.entities).toHaveLength(2);
      expect(result._spec.entities[0].name).toBe('Reward');
      expect(result._spec.entities[1].name).toBe('RewardLedger');
      expect(result._spec.entities[0].fields).toContain('id: String');
      expect(text).toContain('### Entities (2)');
      expect(text).toContain('Reward');
      expect(text).toContain('RewardLedger');
    });

    it('extracts status enum values from inline field comments', () => {
      const workingDir = createTempDir();
      const planPath = createPlanFixture(workingDir);

      const result = handlers.handleExtractFeatureSpec({ plan_path: planPath });

      expect(result.isError).toBeFalsy();
      expect(result._spec.status_enums).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            entity: 'Reward',
            field: 'status',
            values: expect.stringContaining('pending'),
          }),
          expect.objectContaining({
            entity: 'RewardLedger',
            field: 'type',
            values: expect.stringContaining('credit'),
          }),
        ])
      );
      expect(result.content[0].text).toContain('pending');
      expect(result.content[0].text).toContain('credit');
    });

    it('extracts file references from backtick code in the plan', () => {
      const workingDir = createTempDir();
      const planPath = createPlanFixture(workingDir);
      fs.appendFileSync(planPath, '\nAlso referenced in `src/lib/rewards/engine.ts`.\n');

      const result = handlers.handleExtractFeatureSpec({ plan_path: planPath });

      expect(result.isError).toBeFalsy();
      expect(result._spec.file_references).toContain('src/lib/rewards/engine.ts');
    });

    it('derives feature name from plan filename and honors override', () => {
      const workingDir = createTempDir();
      const planPath = createPlanFixture(workingDir);

      const derived = handlers.handleExtractFeatureSpec({ plan_path: planPath });
      const override = handlers.handleExtractFeatureSpec({
        plan_path: planPath,
        feature_name: 'ManualDonationPoints',
      });

      expect(derived.isError).toBeFalsy();
      expect(override.isError).toBeFalsy();
      expect(derived.content[0].text).toContain('DonationPoints');
      expect(override.content[0].text).toContain('ManualDonationPoints');
    });
  });

  describe('handleGenerateTestTasks', () => {
    it('returns error when working_directory is missing', () => {
      const result = automationHandlers.handleGenerateTestTasks({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('generates test task descriptions for untested js files', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/order-service.js', 24);
      createJsSource(workingDir, 'core/validation.js', 30);
      createJsSource(workingDir, 'core/format.js', 32);

      const result = automationHandlers.handleGenerateTestTasks({ working_directory: workingDir });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(3);
      expect(json[0]).toMatchObject({ node_id: expect.any(String), task: expect.any(String) });
      expect(json[0].task).toContain('Create ');
      expect(json[1].task).toContain('test');
    });

    it('respects source file exclusion by line count', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/tiny.js', 3);
      createJsSource(workingDir, 'core/large.js', 30);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        min_lines: 20,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(1);
      expect(json[0].task).toContain('large');
    });

    it('respects requested count limit', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/alpha.js', 30);
      createJsSource(workingDir, 'core/beta.js', 30);
      createJsSource(workingDir, 'core/gamma.js', 30);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        count: 2,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json.length).toBe(2);
      expect(json[0].node_id).not.toBe(json[1].node_id);
    });

    it('auto-submits test tasks and starts task manager when requested', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/submit-me.js', 25);

      taskCore.createTask.mockImplementation((task) => ({ ...task, id: 'test-task-1' }));
      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: true,
        count: 1,
        provider: 'codex',
      });

      expect(result.isError).toBeFalsy();
      expect(taskCore.createTask).toHaveBeenCalled();
      expect(mockTaskManager.startTask).toHaveBeenCalled();
      const startedTaskId = mockTaskManager.startTask.mock.calls[0]?.[0];
      expect(startedTaskId).toBe('test-task-1');
      expect(result.content[0].text).toContain('submitted');
      expect(result.content[0].text).toContain('`test-tas`');
    });

    it('does not include duplicate tasks when matching test files exist', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/existing.js', 40);
      createJsSource(workingDir, 'core/only-source.js', 40);

      // Matching test for existing.js
      fs.mkdirSync(path.join(workingDir, 'src', 'core', '__tests__'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'src', 'core', '__tests__', 'existing.test.ts'), 'export {}');

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src'],
        count: 5,
      });
      const json = extractJsonBlock(result.content[0].text);

      expect(result.isError).toBeFalsy();
      expect(json).toBeInstanceOf(Array);
      expect(json).toHaveLength(1);
      expect(json[0].node_id).toContain('only-source');
      expect(json[0].testPath).toBeUndefined();
    });

    it('extends an existing related test file outside __tests__ instead of creating a new one', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'handlers/task-pipeline.js', 40);

      fs.mkdirSync(path.join(workingDir, 'tests'), { recursive: true });
      fs.writeFileSync(path.join(workingDir, 'tests', 'handler-task-pipeline.test.js'), 'export {};');

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        source_dirs: ['src/handlers', 'tests'],
        test_pattern: '.test.js',
        count: 5,
      });
      const text = result.content[0].text;

      expect(result.isError).toBeFalsy();
      expect(text).toContain('Extend the existing test file tests/handler-task-pipeline.test.js');
      expect(text).not.toContain('Create tests/handler-task-pipeline.test.js');
    });

    it('returns ready-to-use json when auto_submit is false', () => {
      const workingDir = createTempDir();
      createJsSource(workingDir, 'core/manual-review.js', 40);

      const result = automationHandlers.handleGenerateTestTasks({
        working_directory: workingDir,
        auto_submit: false,
      });
      const text = result.content[0].text;

      expect(text).toContain('Generated Task Descriptions');
      expect(text).toContain('Use these with `add_workflow_task` or `submit_task`:');
      expect(text).toMatch(/```json/);
      expect(text).toContain('manual-review');
    });
  });

  describe('handlePlanNextBatch', () => {
    it('returns recommendations with models and phases parsed when plan doc has phases', () => {
      const headwatersDir = createTempDir();
      const delugeDir = createTempDir();
      fs.mkdirSync(path.join(headwatersDir, 'src', 'systems'), { recursive: true });

      const planPath = path.join(delugeDir, 'docs', 'plans');
      fs.mkdirSync(planPath, { recursive: true });
      fs.writeFileSync(
        path.join(planPath, 'plan-66-aurora-wave.md'),
        `# Plan 66: Credit Flow

## Overview

Explore an experimental pipeline.

## Phase 1

Model setup.

\`\`\`prisma
model Credit {
  id String @id
}
\`\`\`

## Phase 2

Add runtime behavior.
`
      );

      const result = handlers.handlePlanNextBatch({
        headwaters_path: headwatersDir,
        deluge_path: delugeDir,
        count: 1,
      });

      expect(result.isError).toBeFalsy();
      expect(result.content[0].text).toContain('Next Batch Recommendations');
      expect(result._recommendations).toBeInstanceOf(Array);
      expect(result._recommendations[0].phaseCount).toBe(2);
      expect(result._recommendations[0].modelCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('handleRunBatch', () => {
    it('returns error when working_directory is missing', async () => {
      const result = await handlers.handleRunBatch({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });

    it('returns error when feature_name is missing', async () => {
      const result = await handlers.handleRunBatch({ working_directory: '/tmp' });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/feature_name/i);
    });
  });

  describe('handleContinuousBatchSubmission', () => {
    it('returns null when continuous batch submission is disabled', async () => {
      const planNextBatch = vi.fn();
      const runBatch = vi.fn();
      const result = await handlers.handleContinuousBatchSubmission(
        'wf-complete',
        { working_directory: '/repo' },
        {
          db: {
            getConfig: vi.fn().mockImplementation(createConfigMock({
              continuous_batch_enabled: '0',
            })),
            recordEvent: vi.fn(),
          },
          logger: { info: vi.fn(), warn: vi.fn() },
          handlePlanNextBatch: planNextBatch,
          handleRunBatch: runBatch,
        }
      );

      expect(result).toBeNull();
      expect(planNextBatch).not.toHaveBeenCalled();
      expect(runBatch).not.toHaveBeenCalled();
    });

    it('logs and returns null when no recommendation is available', async () => {
      const info = vi.fn();
      const runBatch = vi.fn();
      const result = await handlers.handleContinuousBatchSubmission(
        'wf-complete',
        { working_directory: '/repo' },
        {
          db: {
            getConfig: vi.fn().mockImplementation(createConfigMock({
              continuous_batch_enabled: '1',
              continuous_batch_deluge_path: '/deluge',
            })),
            recordEvent: vi.fn(),
          },
          logger: { info, warn: vi.fn() },
          handlePlanNextBatch: vi.fn().mockResolvedValue({ _recommendations: [] }),
          handleRunBatch: runBatch,
        }
      );

      expect(result).toBeNull();
      expect(info).toHaveBeenCalledWith('No features available for continuous batch');
      expect(runBatch).not.toHaveBeenCalled();
    });

    it('plans and submits the next workflow using configured defaults', async () => {
      const recordEvent = vi.fn();
      const getConfig = vi.fn().mockImplementation(createConfigMock({
        continuous_batch_enabled: '1',
        continuous_batch_working_directory: '/configured-repo',
        continuous_batch_deluge_path: '/deluge',
        continuous_batch_step_providers: '{"wire":"ollama","tests":"codex"}',
      }));
      const info = vi.fn();
      const warn = vi.fn();
      const handlePlanNextBatch = vi.fn().mockResolvedValue({
        _recommendations: [{ featureName: 'AuroraWave', score: 9 }],
      });
      const handleRunBatch = vi.fn().mockResolvedValue({
        _workflow_id: 'workflow-123',
      });

      const result = await handlers.handleContinuousBatchSubmission(
        'wf-complete',
        {},
        {
          db: { getConfig, recordEvent },
          logger: { info, warn },
          handlePlanNextBatch,
          handleRunBatch,
        }
      );

      expect(handlePlanNextBatch).toHaveBeenCalledWith({
        working_directory: '/configured-repo',
        deluge_path: '/deluge',
        count: 1,
      });
      expect(handleRunBatch).toHaveBeenCalledWith({
        working_directory: '/configured-repo',
        feature_name: 'AuroraWave',
        step_providers: { wire: 'ollama', tests: 'codex' },
        batch_name: 'auto-batch-AuroraWave',
      });
      expect(recordEvent).toHaveBeenCalledWith('continuous_batch_submitted', 'wf-complete', {
        next_workflow_id: 'workflow-123',
        feature_name: 'AuroraWave',
        score: 9,
      });
      expect(info).toHaveBeenCalledWith('[Continuous Batch] Submitted AuroraWave as workflow workflow-123');
      expect(result).toEqual({
        workflow_id: 'workflow-123',
        feature_name: 'AuroraWave',
      });
      expect(warn).not.toHaveBeenCalled();
    });

    it('swallows errors and logs a warning', async () => {
      const warn = vi.fn();
      const error = new Error('planner failed');

      const result = await handlers.handleContinuousBatchSubmission(
        'wf-complete',
        { working_directory: '/repo' },
        {
          db: {
            getConfig: vi.fn().mockImplementation(createConfigMock({
              continuous_batch_enabled: '1',
              continuous_batch_deluge_path: '/deluge',
            })),
            recordEvent: vi.fn(),
          },
          logger: { info: vi.fn(), warn },
          handlePlanNextBatch: vi.fn().mockRejectedValue(error),
          handleRunBatch: vi.fn(),
        }
      );

      expect(result).toBeNull();
      expect(warn).toHaveBeenCalledWith('[Continuous Batch] Failed to submit next batch:', 'planner failed');
    });
  });

  describe('handleRunFullBatch', () => {
    it('returns error when working_directory is missing', async () => {
      const result = await handlers.handleRunFullBatch({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/working_directory/i);
    });
  });
});
