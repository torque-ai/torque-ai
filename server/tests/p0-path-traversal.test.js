const fs = require('fs');
const os = require('os');
const path = require('path');
const { setupTestDb, teardownTestDb, getText } = require('./vitest-setup');
const { v4: uuidv4 } = require('uuid');

const automationTsTools = require('../handlers/automation-ts-tools');
const taskCore = require('../handlers/task/core');
const automationBatch = require('../handlers/automation-batch-orchestration');
const integrationPlans = require('../handlers/integration/plans');
const advArtifacts = require('../handlers/advanced/artifacts');
const integrationRouting = require('../handlers/integration/routing');

let db;
const tempDirs = [];

function createTempDir(prefix = 'torque-path-traversal-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createTaskRecord(workDir) {
  const taskId = uuidv4();
  db.createTask({
    id: taskId,
    status: 'pending',
    task_description: 'Traversal test task',
    working_directory: workDir,
    timeout_minutes: 10,
  });
  return taskId;
}

function expectInvalidParam(result) {
  expect(result.isError).toBe(true);
  expect(result.error_code).toBe('INVALID_PARAM');
  expect(getText(result).toLowerCase()).toContain('path traversal');
}

describe('Path traversal hardening', () => {
  beforeAll(() => {
    const env = setupTestDb('p0-path-traversal');
    db = env.db;
  });

  afterAll(() => {
    teardownTestDb();
  });
  afterEach(() => {
    while (tempDirs.length) {
      const dir = tempDirs.pop();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  });

  describe('automation-ts-tools', () => {
    it('rejects path traversal in handleAddTsInterfaceMembers', () => {
      const result = automationTsTools.handleAddTsInterfaceMembers({
        file_path: '../../../etc/passwd',
        interface_name: 'Config',
        members: [{ name: 'foo', type_definition: 'string' }],
      });
      expectInvalidParam(result);
    });

    it('rejects Windows traversal in handleInjectClassDependency', () => {
      const result = automationTsTools.handleInjectClassDependency({
        file_path: '..\\\\..\\\\',
        import_statement: 'import { Foo } from "./Foo";',
        field_declaration: 'private foo!: Foo;',
        initialization: 'this.foo = new Foo();',
      });
      expectInvalidParam(result);
    });

    it('rejects null-byte file path in handleAddTsUnionMembers', () => {
      const result = automationTsTools.handleAddTsUnionMembers({
        file_path: 'file\x00.ts',
        type_name: 'EventType',
        members: ['test_event'],
      });
      expectInvalidParam(result);
    });

    it('rejects path traversal in handleAddTsEnumMembers', () => {
      const result = automationTsTools.handleAddTsEnumMembers({
        file_path: '../../../etc/passwd',
        enum_name: 'EventState',
        members: [{ name: 'bad', value: 1 }],
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleNormalizeInterfaceFormatting', () => {
      const result = automationTsTools.handleNormalizeInterfaceFormatting({
        file_path: '../../../etc/passwd',
        interface_name: 'Config',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleAddTsMethodToClass', () => {
      const result = automationTsTools.handleAddTsMethodToClass({
        file_path: '../../../etc/passwd',
        class_name: 'GameScene',
        method_code: 'public test() {}',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleReplaceTsMethodBody', () => {
      const result = automationTsTools.handleReplaceTsMethodBody({
        file_path: '..\\\\..\\\\',
        class_name: 'GameScene',
        method_name: 'setup',
        new_body: 'console.log(\"ok\");',
      });
      expectInvalidParam(result);
    });

    it('rejects path traversal in handleAddImportStatement', () => {
      const result = automationTsTools.handleAddImportStatement({
        file_path: '../../../etc/passwd',
        import_statement: 'import { Foo } from \"./Foo\";',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleWireSystemToGamescene', () => {
      const workDir = createTempDir();
      const result = automationTsTools.handleWireSystemToGamescene({
        working_directory: workDir,
        system_name: 'OrderSystem',
        file_path: '..\\\\..\\\\GameScene.ts',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleWireEventsToEventsystem', () => {
      const workDir = createTempDir();
      const result = automationTsTools.handleWireEventsToEventsystem({
        working_directory: workDir,
        events: [{ name: 'event', payload: { foo: 'string' } }],
        file_path: '../../../etc/passwd',
      });
      expectInvalidParam(result);
    });

    it('rejects null-byte path in handleWireNotificationsToBridge', () => {
      const workDir = createTempDir();
      const result = automationTsTools.handleWireNotificationsToBridge({
        working_directory: workDir,
        notifications: [{ event_name: 'order_ready', toast_template: 'Order ready' }],
        file_path: 'file\x00.ts',
      });
      expectInvalidParam(result);
    });
  });

  describe('task-core sync_files', () => {
    it('marks traversal attempts as blocked in sync_files pull mode', () => {
      const workDir = createTempDir();
      const taskId = createTaskRecord(workDir);
      const result = taskCore.handleSyncFiles({
        task_id: taskId,
        files: ['../../../etc/passwd'],
        direction: 'pull',
      });

      const summary = result.content[0].text;
      expect(summary).toContain('Path traversal blocked');
      expect(summary).toContain('../../../etc/passwd');
    });
  });

  describe('automation-batch-orchestration', () => {
    it('rejects traversal in handleRunBatch working_directory', async () => {
      const result = await automationBatch.handleRunBatch({
        working_directory: '../../../etc/passwd',
        feature_name: 'TraversalFeature',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleExtractFeatureSpec plan_path', () => {
      const result = automationBatch.handleExtractFeatureSpec({
        plan_path: '../../../plans/plan-14.md',
      });
      expectInvalidParam(result);
    });

    it('rejects traversal in handleRunFullBatch working_directory', async () => {
      const result = await automationBatch.handleRunFullBatch({
        working_directory: '..\\\\..\\\\',
        feature_name: 'TraversalFeature',
      });
      expectInvalidParam(result);
    });
  });

  describe('integration-plans', () => {
    it('rejects traversal in plan import path', async () => {
      const result = await integrationPlans.handleImportPlan({
        file_path: '../../../tmp/plan.md',
        project_name: 'TraversalPlan',
      });
      expect(result.error || result.isError).toBeTruthy();
      const text = result.error || (result.content && result.content[0] && result.content[0].text) || '';
      expect(String(text).toLowerCase()).toContain('path traversal');
    });
  });

  describe('adv-artifacts', () => {
    it('rejects traversal in export_artifacts output_path', async () => {
      const taskId = createTaskRecord(createTempDir());
      const result = await advArtifacts.handleExportArtifacts({
        task_id: taskId,
        output_path: '..\\\\..\\\\attack.zip',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result).toLowerCase()).toContain('path traversal');
    });
  });

  describe('integration-routing', () => {
    it('rejects traversal in smart_submit_task files list', async () => {
      const result = await integrationRouting.handleSmartSubmitTask({
        task: 'Security test task',
        files: ['..\\\\..\\\\secret.ts'],
        override_provider: 'codex',
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result).toLowerCase()).toContain('path traversal');
    });

    it('rejects traversal in test_routing files list', () => {
      const result = integrationRouting.handleTestRouting({
        task: 'Security test task',
        files: ['%2e%2e%2f%2e%2e%2fsecret.md'],
      });
      expect(result.isError).toBe(true);
      expect(result.error_code).toBe('INVALID_PARAM');
      expect(getText(result).toLowerCase()).toContain('path traversal');
    });
  });
});
