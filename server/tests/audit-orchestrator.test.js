'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { getRelevantCategories } = require('../audit/categories');
const { runAudit, init } = require('../audit/orchestrator');

const createTempProject = () => fs.mkdtempSync(path.join(os.tmpdir(), 'audit-orchestrator-'));

const writeTestFiles = (projectPath) => {
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectPath, 'src', 'alpha.js'), 'const alpha = 1\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'src', 'beta.js'), 'const beta = 2\n', 'utf8');
  fs.writeFileSync(path.join(projectPath, 'src', 'gamma.js'), 'const gamma = 3\n', 'utf8');
};

describe('audit orchestrator', () => {
  let projectDir;
  let createAuditRun;
  let updateAuditRun;
  let getAuditRun;
  let createWorkflow;
  let scanProject;

  beforeEach(() => {
    projectDir = createTempProject();
    writeTestFiles(projectDir);

    createAuditRun = vi.fn(() => 'test-run-id');
    updateAuditRun = vi.fn();
    getAuditRun = vi.fn(() => ({ id: 'test-run-id', status: 'pending' }));
    createWorkflow = vi.fn(() => ({
      content: [{
        type: 'text',
        text: '## Workflow Created\n\n**ID:** a1b2c3d4-e5f6-7890-abcd-ef1234567890\n**Name:** test\n**Tasks:** 1',
      }],
    }));
    scanProject = vi.fn(() => Promise.resolve({
      content: [{ type: 'text', text: 'Summary: 5 files' }],
    }));

    init({
      auditStore: {
        createAuditRun,
        updateAuditRun,
        getAuditRun,
      },
      createWorkflow,
      runWorkflow: vi.fn(),
      scanProject,
    });
  });

  afterEach(() => {
    if (projectDir && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('returns a dry-run plan and does not create workflow/task records', async () => {
    const result = await runAudit({
      path: projectDir,
      dry_run: true,
      source_dirs: ['src'],
    });
    const expectedCategories = getRelevantCategories(['.js']);

    expect(result).toMatchObject({
      dry_run: true,
      total_files: 3,
      task_count: 1,
      files_by_tier: { small: 3, medium: 0, large: 0 },
      categories: Object.keys(expectedCategories),
    });
    expect(result).toHaveProperty('estimated_duration', 3);
    expect(createWorkflow).not.toHaveBeenCalled();
    expect(createAuditRun).not.toHaveBeenCalled();
  });

  it('creates audit run, workflow with inline tasks in non-dry-run mode', async () => {
    const result = await runAudit({
      path: projectDir,
      source_dirs: ['src'],
    });

    expect(result).toMatchObject({
      audit_run_id: 'test-run-id',
      workflow_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      total_files: 3,
      task_count: 1,
      status: 'running',
      estimated_duration: 3,
    });

    expect(createAuditRun).toHaveBeenCalledWith({
      project_path: projectDir,
      categories: expect.any(Array),
      provider: null,
    });

    expect(createWorkflow).toHaveBeenCalledTimes(1);
    const workflowArgs = createWorkflow.mock.calls[0][0];
    expect(workflowArgs.name).toBe('audit-test-run');
    expect(workflowArgs.description).toBe(`Audit run for ${projectDir} (3 files, 1 tasks)`);
    expect(workflowArgs.working_directory).toBe(projectDir);
    expect(workflowArgs.tasks).toHaveLength(1);

    const task = workflowArgs.tasks[0];
    expect(task.node_id).toMatch(/^audit-unit-/);
    expect(task.task_description).toBeTruthy();
    expect(task.tags).toContain('audit:test-run-id');

    expect(updateAuditRun).toHaveBeenCalledWith('test-run-id', expect.objectContaining({
      status: 'running',
      workflow_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      total_files: 3,
    }));
  });

  it('awaits async file content reads before creating workflow tasks', async () => {
    vi.resetModules();

    const fsPromises = require('node:fs/promises');
    const actualReadFile = fsPromises.readFile.bind(fsPromises);
    const resolvedContentReads = [];
    const asyncContentByPath = new Map([
      [path.join(projectDir, 'src', 'alpha.js'), 'const alpha = "async-alpha";\n'],
      [path.join(projectDir, 'src', 'beta.js'), 'const beta = "async-beta";\n'],
      [path.join(projectDir, 'src', 'gamma.js'), 'const gamma = "async-gamma";\n'],
    ]);
    const readFile = vi.spyOn(fsPromises, 'readFile').mockImplementation((filePath, encoding) => {
      if (encoding !== 'utf8') {
        return actualReadFile(filePath, encoding);
      }

      return new Promise((resolve) => {
        setTimeout(() => {
          resolvedContentReads.push(filePath);
          resolve(asyncContentByPath.get(filePath) || '');
        }, 0);
      });
    });
    const workflowId = 'abcdef12-3456-7890-abcd-ef1234567890';

    try {
      const {
        init: initWithMockedReadFile,
        runAudit: runAuditWithMockedReadFile,
      } = require('../audit/orchestrator');
      const mockedCreateWorkflow = vi.fn((workflowArgs) => {
        expect(resolvedContentReads).toHaveLength(3);
        expect(workflowArgs.tasks[0].task_description).toContain('const alpha = "async-alpha";');
        expect(workflowArgs.tasks[0].task_description).toContain('const beta = "async-beta";');
        expect(workflowArgs.tasks[0].task_description).toContain('const gamma = "async-gamma";');

        return {
          content: [{
            type: 'text',
            text: `## Workflow Created\n\n**ID:** ${workflowId}\n**Name:** test\n**Tasks:** 1`,
          }],
        };
      });

      initWithMockedReadFile({
        auditStore: {
          createAuditRun,
          updateAuditRun,
          getAuditRun,
        },
        createWorkflow: mockedCreateWorkflow,
        runWorkflow: vi.fn(),
        scanProject,
      });

      const result = await runAuditWithMockedReadFile({
        path: projectDir,
        source_dirs: ['src'],
      });

      expect(result.workflow_id).toBe(workflowId);
      expect(mockedCreateWorkflow).toHaveBeenCalledTimes(1);
      expect(readFile.mock.calls.filter(([, encoding]) => encoding === 'utf8')).toHaveLength(3);
    } finally {
      readFile.mockRestore();
      vi.resetModules();
    }
  });

  it('passes provider and model overrides to workflow tasks', async () => {
    const result = await runAudit({
      path: projectDir,
      source_dirs: ['src'],
      provider: 'provider-override',
      model: 'model-override',
    });

    expect(result.workflow_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');

    const workflowArgs = createWorkflow.mock.calls[0][0];
    expect(workflowArgs.tasks).toHaveLength(1);
    expect(workflowArgs.tasks[0]).toMatchObject({
      provider: 'provider-override',
      model: 'model-override',
    });
    expect(workflowArgs.tasks[0].tags).toContain('audit:test-run-id');
  });

  it('returns error when project has no files', async () => {
    const emptyDir = createTempProject();
    const result = await runAudit({
      path: emptyDir,
      source_dirs: ['src'],
    });

    expect(result).toHaveProperty('error');
    expect(createAuditRun).not.toHaveBeenCalled();
    expect(createWorkflow).not.toHaveBeenCalled();

    fs.rmSync(emptyDir, { recursive: true, force: true });
  });
});
