import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { randomUUID } = require('crypto');
const { setupTestDbOnly, teardownTestDb } = require('./vitest-setup');
const pipelineCrud = require('../db/pipeline-crud');

function makePipeline(overrides = {}) {
  return pipelineCrud.createPipeline({
    id: overrides.id ?? randomUUID(),
    name: overrides.name ?? 'Test Pipeline',
    description: overrides.description ?? 'Pipeline used by pipeline-crud tests',
    working_directory: overrides.working_directory ?? 'C:/repo/project',
    ...overrides,
  });
}

describe('db/pipeline-crud', () => {
  let dbModule;
  let db;
  let recordEvent;

  beforeEach(() => {
    ({ db: dbModule } = setupTestDbOnly('pipeline-crud'));
    db = dbModule.getDbInstance();
    recordEvent = vi.fn();
    pipelineCrud.setDb(db);
    pipelineCrud.setRecordEvent(recordEvent);
    vi.useRealTimers();
  });

  afterEach(() => {
    pipelineCrud.setRecordEvent(null);
    pipelineCrud.setDb(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
    teardownTestDb();
  });

  it('creates a pipeline, records the event, and returns it with an empty steps array', () => {
    vi.useFakeTimers();
    const createdAt = new Date('2026-04-05T15:16:17.000Z');
    vi.setSystemTime(createdAt);

    const created = pipelineCrud.createPipeline({
      id: 'pipeline-create-1',
      name: 'Deploy Pipeline',
      description: 'Deploys the app',
      working_directory: 'C:/repo/app',
    });
    const fetched = pipelineCrud.getPipeline('pipeline-create-1');

    expect(recordEvent).toHaveBeenCalledWith('pipeline_created', 'pipeline-create-1', {
      name: 'Deploy Pipeline',
    });

    expect(created).toMatchObject({
      id: 'pipeline-create-1',
      name: 'Deploy Pipeline',
      description: 'Deploys the app',
      status: 'pending',
      current_step: 0,
      working_directory: 'C:/repo/app',
      created_at: createdAt.toISOString(),
      started_at: null,
      completed_at: null,
      error: null,
      project: null,
      steps: [],
    });
    expect(fetched).toMatchObject({
      id: 'pipeline-create-1',
      name: 'Deploy Pipeline',
      description: 'Deploys the app',
      status: 'pending',
      steps: [],
    });
  });

  it('adds steps with auto-incrementing step_order and returns them ordered', () => {
    const pipeline = makePipeline({ id: 'pipeline-steps-1' });

    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Lint',
      task_template: 'npm run lint',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Test',
      task_template: 'npm test',
    });

    const steps = pipelineCrud.getPipelineSteps(pipeline.id);

    expect(steps).toHaveLength(2);
    expect(steps.map((step) => ({
      name: step.name,
      step_order: step.step_order,
      status: step.status,
    }))).toEqual([
      { name: 'Lint', step_order: 1, status: 'pending' },
      { name: 'Test', step_order: 2, status: 'pending' },
    ]);
  });

  it('updates pipeline status timestamps and only applies whitelisted additional fields', () => {
    vi.useFakeTimers();
    const pipeline = makePipeline({ id: 'pipeline-status-1' });
    const startedAt = new Date('2026-04-05T16:00:00.000Z');
    const completedAt = new Date('2026-04-05T16:30:00.000Z');

    vi.setSystemTime(startedAt);
    const running = pipelineCrud.updatePipelineStatus(pipeline.id, 'running', {
      current_step: 2,
      ignored_field: 'not-persisted',
    });

    expect(running).toMatchObject({
      id: pipeline.id,
      status: 'running',
      current_step: 2,
      started_at: startedAt.toISOString(),
      completed_at: null,
    });
    expect(Object.prototype.hasOwnProperty.call(running, 'ignored_field')).toBe(false);

    vi.setSystemTime(completedAt);
    const completed = pipelineCrud.updatePipelineStatus(pipeline.id, 'completed', {
      error: 'completed with warnings',
      ignored_field: 'still-not-persisted',
    });

    expect(completed).toMatchObject({
      id: pipeline.id,
      status: 'completed',
      current_step: 2,
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      error: 'completed with warnings',
    });
    expect(Object.prototype.hasOwnProperty.call(completed, 'ignored_field')).toBe(false);
  });

  it('updates a step status and output_vars fields', () => {
    const pipeline = makePipeline({ id: 'pipeline-step-update-1' });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Build',
      task_template: 'npm run build',
    });
    const [step] = pipelineCrud.getPipelineSteps(pipeline.id);

    pipelineCrud.updatePipelineStep(step.id, {
      status: 'completed',
      output_vars: { result: 'build finished', code: 0 },
    });

    const [updated] = pipelineCrud.getPipelineSteps(pipeline.id);
    expect(updated).toMatchObject({
      id: step.id,
      status: 'completed',
      output_vars: { result: 'build finished', code: 0 },
    });
  });

  it('serializes output_vars to JSON and parses them on readback', () => {
    const pipeline = makePipeline({ id: 'pipeline-step-update-2' });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Archive',
      task_template: 'npm run archive',
    });
    const [step] = pipelineCrud.getPipelineSteps(pipeline.id);

    pipelineCrud.updatePipelineStep(step.id, {
      status: 'completed',
      output_vars: { artifact: 'dist.zip', retries: 1 },
    });

    const [updated] = pipelineCrud.getPipelineSteps(pipeline.id);
    const stored = db.prepare('SELECT output_vars FROM pipeline_steps WHERE id = ?').get(step.id);

    expect(updated).toMatchObject({
      id: step.id,
      status: 'completed',
      output_vars: { artifact: 'dist.zip', retries: 1 },
    });
    expect(stored.output_vars).toBe(JSON.stringify({ artifact: 'dist.zip', retries: 1 }));
  });

  it('transitions a step atomically when the current status matches and returns false otherwise', () => {
    const pipeline = makePipeline({ id: 'pipeline-transition-1' });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Verify',
      task_template: 'npm run verify',
    });
    const [step] = pipelineCrud.getPipelineSteps(pipeline.id);

    const success = pipelineCrud.transitionPipelineStepStatus(step.id, 'pending', 'running');
    const failure = pipelineCrud.transitionPipelineStepStatus(step.id, 'pending', 'completed');

    expect(success).toBe(true);
    expect(failure).toBe(false);
    expect(pipelineCrud.getPipelineSteps(pipeline.id)[0]).toMatchObject({
      id: step.id,
      status: 'running',
    });
  });

  it('accepts an array for fromStatus and transitions from either allowed status', () => {
    const pipeline = makePipeline({ id: 'pipeline-transition-2' });

    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Queued Step',
      task_template: 'npm run queued',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Running Step',
      task_template: 'npm run running',
    });

    const [pendingStep, runningStep] = pipelineCrud.getPipelineSteps(pipeline.id);
    pipelineCrud.updatePipelineStep(runningStep.id, { status: 'running' });

    const fromPending = pipelineCrud.transitionPipelineStepStatus(
      pendingStep.id,
      ['pending', 'running'],
      'running',
    );
    const fromRunning = pipelineCrud.transitionPipelineStepStatus(
      runningStep.id,
      ['pending', 'running'],
      'completed',
    );

    const steps = pipelineCrud.getPipelineSteps(pipeline.id);

    expect(fromPending).toBe(true);
    expect(fromRunning).toBe(true);
    expect(steps.map((step) => ({ id: step.id, status: step.status }))).toEqual([
      { id: pendingStep.id, status: 'running' },
      { id: runningStep.id, status: 'completed' },
    ]);
  });

  it('lists pipelines by status with limit applied and batch-loads their steps', () => {
    vi.useFakeTimers();

    vi.setSystemTime(new Date('2026-04-05T12:00:00.000Z'));
    const firstPending = makePipeline({
      id: 'pipeline-list-1',
      name: 'First Pending',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: firstPending.id,
      name: 'First Step',
      task_template: JSON.stringify({ command: 'npm run first' }),
    });

    vi.setSystemTime(new Date('2026-04-05T12:01:00.000Z'));
    const running = makePipeline({
      id: 'pipeline-list-2',
      name: 'Running Pipeline',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: running.id,
      name: 'Running Step',
      task_template: JSON.stringify({ command: 'npm run running' }),
    });
    pipelineCrud.updatePipelineStatus(running.id, 'running');

    vi.setSystemTime(new Date('2026-04-05T12:02:00.000Z'));
    const secondPending = makePipeline({
      id: 'pipeline-list-3',
      name: 'Second Pending',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: secondPending.id,
      name: 'Second Step',
      task_template: JSON.stringify({ command: 'npm run second' }),
    });

    const prepareSpy = vi.spyOn(db, 'prepare');
    const pipelines = pipelineCrud.listPipelines({ status: 'pending', limit: 2 });
    const preparedSql = prepareSpy.mock.calls.map(([sql]) => sql.replace(/\s+/g, ' ').trim());

    expect(pipelines).toHaveLength(2);
    expect(pipelines.map((pipeline) => pipeline.id)).toEqual([
      secondPending.id,
      firstPending.id,
    ]);
    expect(pipelines.map((pipeline) => ({
      id: pipeline.id,
      stepCount: pipeline.steps.length,
      taskTemplate: pipeline.steps[0].task_template,
    }))).toEqual([
      {
        id: secondPending.id,
        stepCount: 1,
        taskTemplate: { command: 'npm run second' },
      },
      {
        id: firstPending.id,
        stepCount: 1,
        taskTemplate: { command: 'npm run first' },
      },
    ]);
    expect(preparedSql.some((sql) => /SELECT \* FROM pipelines WHERE status = \? ORDER BY created_at DESC LIMIT \?/.test(sql))).toBe(true);
    expect(preparedSql.some((sql) => /SELECT \* FROM pipeline_steps WHERE pipeline_id IN \(\?, \?\) ORDER BY pipeline_id, step_order ASC/.test(sql))).toBe(true);
  });

  it('returns the next pending step and expands the next parallel group when the prior step is completed', () => {
    const pipeline = makePipeline({ id: 'pipeline-next-1' });

    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Prepare',
      task_template: 'npm run prepare',
    });
    pipelineCrud.addParallelPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Shard A',
      task_template: 'npm run shard-a',
      parallel_group: 'group-1',
    });
    pipelineCrud.addParallelPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Shard B',
      task_template: 'npm run shard-b',
      parallel_group: 'group-1',
    });
    pipelineCrud.addPipelineStep({
      pipeline_id: pipeline.id,
      name: 'Finalize',
      task_template: 'npm run finalize',
    });

    const steps = pipelineCrud.getPipelineSteps(pipeline.id);
    pipelineCrud.updatePipelineStep(steps[0].id, { status: 'completed' });

    const nextStep = pipelineCrud.getNextPipelineStep(pipeline.id);
    const nextSteps = pipelineCrud.getNextPipelineSteps(pipeline.id);

    expect(nextStep).toMatchObject({
      pipeline_id: pipeline.id,
      name: 'Shard A',
      step_order: 2,
      status: 'pending',
      parallel_group: 'group-1',
    });
    expect(nextSteps.map((step) => ({
      name: step.name,
      step_order: step.step_order,
      parallel_group: step.parallel_group,
    }))).toEqual([
      { name: 'Shard A', step_order: 2, parallel_group: 'group-1' },
      { name: 'Shard B', step_order: 3, parallel_group: 'group-1' },
    ]);
  });
});
