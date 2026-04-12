'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const shared = require('../handlers/shared');

const HANDLERS_MODULE = '../handlers/codebase-study-handlers';
const INTEGRATION_MODULE = '../integrations/codebase-study';
const SCHEDULING_MODULE = '../db/scheduling-automation';
const TASK_CORE_MODULE = '../db/task-core';
const STUDY_TELEMETRY_MODULE = '../db/study-telemetry';
const LOGGER_MODULE = '../logger';
const CONTAINER_MODULE = '../container';
const MODULES_TO_RESET = [
  HANDLERS_MODULE,
  INTEGRATION_MODULE,
  SCHEDULING_MODULE,
  TASK_CORE_MODULE,
  STUDY_TELEMETRY_MODULE,
  LOGGER_MODULE,
  CONTAINER_MODULE,
];
const STUDY_IMPACT_SUMMARY = {
  window_days: 30,
  task_outcomes: {
    with_context: { count: 0 },
    without_context: { count: 0 },
    delta: {
      comparison_available: false,
      success_rate_points: 0,
    },
  },
};
const GIT_TEST_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Study Handler Test',
  GIT_AUTHOR_EMAIL: 'study-handler@example.com',
  GIT_COMMITTER_NAME: 'Study Handler Test',
  GIT_COMMITTER_EMAIL: 'study-handler@example.com',
};

const patchedExecFileSync = childProcess.execFileSync;
const patchedSpawnSync = childProcess.spawnSync;
const realExecFileSync = childProcess._realExecFileSync || childProcess.execFileSync;
const realSpawnSync = childProcess._realSpawnSync || childProcess.spawnSync;

function installCjsModuleMock(modulePath, exportsValue) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: exportsValue,
  };
}

function resetCjsModule(modulePath) {
  try {
    delete require.cache[require.resolve(modulePath)];
  } catch {
    // Module was not loaded in this test.
  }
}

function resetStudyModules() {
  MODULES_TO_RESET.forEach(resetCjsModule);
}

function getText(result) {
  return result?.content?.[0]?.text || '';
}

function runGit(cwd, args) {
  return realExecFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10000,
    env: GIT_TEST_ENV,
  }).trim();
}

function writeRepoFile(repoDir, relativePath, content) {
  const fullPath = path.join(repoDir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, 'utf8');
}

function createRepo(files) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'torque-study-handler-'));
  runGit(repoDir, ['init']);
  runGit(repoDir, ['config', 'user.email', 'study-handler@example.com']);
  runGit(repoDir, ['config', 'user.name', 'Study Handler Test']);
  Object.entries(files).forEach(([relativePath, content]) => {
    writeRepoFile(repoDir, relativePath, content);
  });
  runGit(repoDir, ['add', '.']);
  runGit(repoDir, ['commit', '-m', 'initial', '--no-gpg-sign']);
  return repoDir;
}

function createSchedulingAutomationMock() {
  let nextScheduleId = 1;
  const schedules = [];
  return {
    schedules,
    listScheduledTasks: vi.fn(() => schedules.map(schedule => ({ ...schedule }))),
    createCronScheduledTask: vi.fn((payload) => {
      const schedule = {
        id: `study-schedule-${nextScheduleId++}`,
        name: payload.name,
        cron_expression: payload.cron_expression,
        enabled: payload.enabled !== false,
        timezone: payload.timezone || null,
        next_run_at: null,
        version_intent: payload.version_intent || null,
        task_config: payload.task_config,
      };
      schedules.push(schedule);
      return { ...schedule };
    }),
    updateScheduledTask: vi.fn((id, updates) => {
      const index = schedules.findIndex(schedule => schedule.id === id);
      const current = index >= 0 ? schedules[index] : { id };
      const schedule = {
        ...current,
        ...updates,
        id,
        name: current.name,
        cron_expression: updates.cron_expression ?? current.cron_expression,
        enabled: updates.enabled ?? current.enabled,
        timezone: updates.timezone ?? current.timezone ?? null,
        next_run_at: current.next_run_at ?? null,
      };
      if (index >= 0) {
        schedules[index] = schedule;
      } else {
        schedules.push(schedule);
      }
      return { ...schedule };
    }),
    listApprovalRules: vi.fn(() => []),
    createApprovalRule: vi.fn(() => 'study-rule-1'),
    createApprovalRequest: vi.fn((taskId) => `approval-${taskId}`),
  };
}

function createTaskCoreMock() {
  let nextTaskId = 1;
  return {
    listTasks: vi.fn(() => []),
    getTask: vi.fn((id) => ({ id, status: 'completed' })),
    createTask: vi.fn((task) => ({
      id: task?.id || `study-task-${nextTaskId++}`,
      ...task,
    })),
  };
}

function loadHandlers() {
  resetStudyModules();

  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
  const mocks = {
    schedulingAutomation: createSchedulingAutomationMock(),
    taskCore: createTaskCoreMock(),
    studyTelemetry: {
      getStudyImpactSummary: vi.fn(() => STUDY_IMPACT_SUMMARY),
    },
    loggerModule: {
      child: vi.fn(() => logger),
    },
    containerModule: {
      defaultContainer: {
        get: vi.fn(() => ({})),
      },
    },
  };

  installCjsModuleMock(SCHEDULING_MODULE, mocks.schedulingAutomation);
  installCjsModuleMock(TASK_CORE_MODULE, mocks.taskCore);
  installCjsModuleMock(STUDY_TELEMETRY_MODULE, mocks.studyTelemetry);
  installCjsModuleMock(LOGGER_MODULE, mocks.loggerModule);
  installCjsModuleMock(CONTAINER_MODULE, mocks.containerModule);

  // The study service shells out to git; load it with the real child_process bindings.
  childProcess.execFileSync = realExecFileSync;
  childProcess.spawnSync = realSpawnSync;
  try {
    const handlers = require(HANDLERS_MODULE);
    if (typeof handlers.init === 'function') {
      handlers.init({ db: {} });
    }
    return {
      handlers,
      mocks,
    };
  } finally {
    childProcess.execFileSync = patchedExecFileSync;
    childProcess.spawnSync = patchedSpawnSync;
  }
}

describe('handler:codebase-study-handlers', () => {
  let repoDir;
  let handlers;
  let mocks;

  beforeEach(() => {
    repoDir = createRepo({
      'package.json': JSON.stringify({
        name: 'study-handler-fixture',
        description: 'Tiny repo for codebase study handler coverage.',
      }, null, 2) + '\n',
      'src/index.js': [
        'const runtime = require("./runtime");',
        'module.exports = { run() { return runtime.boot(); } };',
        '',
      ].join('\n'),
      'src/runtime.js': [
        'const config = require("../config/app.json");',
        'exports.boot = function boot() { return config.enabled === true; };',
        '',
      ].join('\n'),
      'config/app.json': JSON.stringify({ enabled: true, mode: 'demo' }, null, 2) + '\n',
    });
    ({ handlers, mocks } = loadHandlers());
  });

  afterEach(() => {
    if (repoDir) {
      fs.rmSync(repoDir, { recursive: true, force: true });
      repoDir = null;
    }
    childProcess.execFileSync = patchedExecFileSync;
    childProcess.spawnSync = patchedSpawnSync;
    resetStudyModules();
    vi.restoreAllMocks();
  });

  it('runs the codebase study and returns structured output for a small repo', async () => {
    const result = await handlers.handleRunCodebaseStudy({
      working_directory: repoDir,
    });
    const text = getText(result);
    const data = result.structuredData;

    expect(text).toContain('## Codebase Study Run');
    expect(text).toContain(`**Working Directory:** ${repoDir}`);
    expect(text).toContain('**Run Count:** 1');
    expect(data).toEqual(expect.objectContaining({
      working_directory: repoDir,
      task_status: 'completed',
      run_count: 1,
      pending_count: 0,
      last_result: 'completed_local',
      tracked_count: expect.any(Number),
      module_entry_count: expect.any(Number),
      batch_files: expect.any(Array),
      files_modified: expect.any(Array),
      study_impact: STUDY_IMPACT_SUMMARY,
    }));
    expect(data.batch_files.length).toBeGreaterThan(0);
    expect(data.files_modified).toEqual(expect.arrayContaining([
      'docs/architecture/knowledge-pack.json',
      'docs/architecture/study-state.json',
    ]));
    expect(fs.existsSync(path.join(repoDir, 'docs', 'architecture', 'study-state.json'))).toBe(true);
    expect(mocks.studyTelemetry.getStudyImpactSummary).toHaveBeenCalledWith({
      workingDirectory: repoDir,
      sinceDays: 30,
    });
  });

  it('returns null and empty study status fields before the first run', async () => {
    const headSha = runGit(repoDir, ['rev-parse', 'HEAD']);
    const result = await handlers.handleGetStudyStatus({
      working_directory: repoDir,
    });
    const text = getText(result);
    const data = result.structuredData;

    expect(text).toContain('## Codebase Study Status');
    expect(text).toContain('**Run Count:** 0');
    expect(data).toEqual(expect.objectContaining({
      working_directory: repoDir,
      current_sha: headSha,
      last_sha: null,
      last_task_id: null,
      run_count: 0,
      last_run_at: null,
      last_completed_at: null,
      last_result: null,
      last_error: null,
      tracked_count: 0,
      pending_count: 0,
      pending_files: [],
      module_entry_count: 0,
      study_impact: STUDY_IMPACT_SUMMARY,
    }));
  });

  it('returns populated status after a study has run', async () => {
    await handlers.handleRunCodebaseStudy({
      working_directory: repoDir,
    });

    const headSha = runGit(repoDir, ['rev-parse', 'HEAD']);
    const result = await handlers.handleGetStudyStatus({
      working_directory: repoDir,
    });
    const data = result.structuredData;

    expect(getText(result)).toContain('## Codebase Study Status');
    expect(getText(result)).toContain('**Run Count:** 1');
    expect(data).toEqual(expect.objectContaining({
      working_directory: repoDir,
      current_sha: headSha,
      last_sha: headSha,
      run_count: 1,
      pending_count: 0,
      pending_files: [],
      last_result: 'completed_local',
      module_entry_count: expect.any(Number),
      study_impact: STUDY_IMPACT_SUMMARY,
    }));
  });

  it('bootstraps the study and persists schedule metadata through the stubbed scheduler', async () => {
    const result = await handlers.handleBootstrapCodebaseStudy({
      working_directory: repoDir,
      project: 'study-handler-fixture',
      name: 'study bootstrap',
      cron_expression: '0 4 * * *',
      timezone: 'UTC',
    });
    const data = result.structuredData;

    expect(getText(result)).toContain('## Codebase Study Bootstrap');
    expect(data).toEqual(expect.objectContaining({
      working_directory: repoDir,
      bootstrap_plan: expect.objectContaining({
        repo: expect.objectContaining({
          project: 'study-handler-fixture',
        }),
        recommendations: expect.objectContaining({
          create_schedule: true,
          run_initial_study: true,
        }),
      }),
      study_profile: expect.objectContaining({
        id: expect.any(String),
        label: expect.any(String),
      }),
      initial_run: expect.objectContaining({
        skipped: false,
        task_status: 'completed',
        pending_count: 0,
      }),
      schedule: expect.objectContaining({
        schedule_id: 'study-schedule-1',
        name: 'study bootstrap',
        cron_expression: '0 4 * * *',
        enabled: true,
        timezone: 'UTC',
        next_run_at: null,
        created: true,
        updated: false,
      }),
      study_impact: STUDY_IMPACT_SUMMARY,
    }));
    expect(mocks.schedulingAutomation.createCronScheduledTask).toHaveBeenCalledTimes(1);
    expect(mocks.schedulingAutomation.updateScheduledTask).not.toHaveBeenCalled();
    expect(mocks.schedulingAutomation.schedules[0]).toEqual(expect.objectContaining({
      name: 'study bootstrap',
      cron_expression: '0 4 * * *',
      enabled: true,
      timezone: 'UTC',
      task_config: expect.objectContaining({
        working_directory: repoDir,
        project: 'study-handler-fixture',
        tool_name: 'run_codebase_study',
        tool_args: expect.objectContaining({
          working_directory: repoDir,
          project: 'study-handler-fixture',
          submit_proposals: false,
          proposal_min_score: expect.any(Number),
        }),
      }),
    }));
    expect(fs.existsSync(path.join(repoDir, 'docs', 'architecture', 'knowledge-pack.json'))).toBe(true);
  });

  it('rejects invalid proposal threshold values when configuring the schedule', async () => {
    const result = await handlers.handleConfigureStudySchedule({
      working_directory: repoDir,
      proposal_significance_level: 'urgent',
    });

    expect(result.isError).toBe(true);
    expect(result.error_code).toBe(shared.ErrorCodes.INVALID_PARAM.code);
    expect(getText(result)).toContain('proposal_significance_level must be one of: none, baseline, low, moderate, high, critical');
    expect(mocks.schedulingAutomation.createCronScheduledTask).not.toHaveBeenCalled();
  });

  it('persists a valid proposal threshold configuration on the schedule', async () => {
    const result = await handlers.handleConfigureStudySchedule({
      working_directory: repoDir,
      project: 'study-handler-fixture',
      name: 'nightly study',
      cron_expression: '0 6 * * *',
      timezone: 'UTC',
      version_intent: 'feature',
      submit_proposals: true,
      proposal_limit: 3,
      proposal_significance_level: 'high',
      proposal_min_score: 25,
    });
    const text = getText(result);
    const data = result.structuredData;

    expect(text).toContain('## Codebase Study Schedule');
    expect(text).toContain('**Proposal Threshold Level:** high');
    expect(text).toContain('**Proposal Minimum Score:** 25');
    expect(data).toEqual(expect.objectContaining({
      schedule_id: 'study-schedule-1',
      name: 'nightly study',
      cron_expression: '0 6 * * *',
      working_directory: repoDir,
      enabled: true,
      timezone: 'UTC',
      next_run_at: null,
      submit_proposals: true,
      proposal_significance_level: 'high',
      proposal_min_score: 25,
      proposal_limit: 3,
    }));
    expect(mocks.schedulingAutomation.createCronScheduledTask).toHaveBeenCalledTimes(1);
    expect(mocks.schedulingAutomation.schedules[0]).toEqual(expect.objectContaining({
      name: 'nightly study',
      cron_expression: '0 6 * * *',
      enabled: true,
      timezone: 'UTC',
      version_intent: 'feature',
      task_config: expect.objectContaining({
        project: 'study-handler-fixture',
        version_intent: 'feature',
        tool_name: 'run_codebase_study',
        tool_args: expect.objectContaining({
          working_directory: repoDir,
          project: 'study-handler-fixture',
          submit_proposals: true,
          proposal_limit: 3,
          proposal_significance_level: 'high',
          proposal_min_score: 25,
        }),
      }),
    }));
  });
});
