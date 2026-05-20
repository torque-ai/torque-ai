import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test-utils';
import CommandCenter from './CommandCenter';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  tasks: {
    list: vi.fn(),
    kanbanSummary: vi.fn(),
    commandCenterSummary: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    approveBatch: vi.fn(),
    approveSwitch: vi.fn(),
    rejectSwitch: vi.fn(),
    reassignProvider: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
  factory: {
    projects: vi.fn(),
    loopStatus: vi.fn(),
    startLoop: vi.fn(),
    listLoopInstances: vi.fn(),
    startLoopInstance: vi.fn(),
    loopInstanceStatus: vi.fn(),
    advanceLoopInstance: vi.fn(),
    loopInstanceJobStatus: vi.fn(),
    approveGateInstance: vi.fn(),
    rejectGateInstance: vi.fn(),
    retryVerifyInstance: vi.fn(),
    advanceLoopAsync: vi.fn(),
    loopJobStatus: vi.fn(),
    approveGate: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
  },
  stats: {
    overview: vi.fn(),
    stuck: vi.fn(),
    quality: vi.fn(),
    timeseries: vi.fn(),
  },
}));

vi.mock('../hooks/useAbortableRequest', () => {
  const stableRequest = {
    execute: (fn) => fn(() => true),
  };
  return {
    useAbortableRequest: () => stableRequest,
  };
});

import { factory as factoryApi, tasks as tasksApi, stats as statsApi, providers as providersApi } from '../api';
import { requestV2 } from '../api';

const emptyTasks = { tasks: [] };
const runningTask = {
  id: 'task-run-1',
  status: 'running',
  task_description: 'Running test task',
  project: 'alpha',
  provider: 'codex',
  started_at: new Date().toISOString(),
  created_at: '2026-01-15T10:00:00Z',
};
const queuedTask = {
  id: 'task-queue-1',
  status: 'queued',
  task_description: 'Queued test task',
  project: 'alpha',
  provider: 'codex',
  created_at: '2026-01-15T10:00:00Z',
};
const pendingSwitchTask = {
  id: 'task-switch-1',
  status: 'pending_provider_switch',
  task_description: 'Pending provider switch task',
  project: 'alpha',
  provider: 'codex',
  created_at: '2026-01-15T10:00:00Z',
};
const pendingApprovalTask = {
  id: 'task-approval-1',
  status: 'pending_approval',
  task_description: 'Pending approval test task',
  project: 'alpha',
  provider: 'codex',
  created_at: '2026-01-15T10:00:00Z',
};
const failedTask = {
  id: 'task-fail-1',
  status: 'failed',
  task_description: 'Failed deploy verification task',
  project: 'alpha',
  provider: 'codex',
  exit_code: 1,
  started_at: '2026-01-15T10:00:00Z',
  completed_at: '2026-01-15T10:03:00Z',
  created_at: '2026-01-15T09:59:00Z',
  quality_score: 42,
  tags: ['tests:fail:2'],
};
const factoryArchitectTask = {
  id: 'factory-arch-1',
  status: 'completed',
  description: 'You are the Architect for a software factory. Read the context below and return ONLY valid JSON output matching the specified format.',
  project: 'factory-architect',
  provider: 'codex',
  created_at: '2026-01-15T09:00:00Z',
  started_at: '2026-01-15T09:01:00Z',
  completed_at: '2026-01-15T09:02:00Z',
  tags: ['factory:internal', 'factory:architect_cycle', 'factory:target_project=DLPhone'],
  metadata: { kind: 'architect_cycle', target_project: 'DLPhone' },
};
const factoryPlanTask = {
  id: 'factory-plan-task-2',
  status: 'queued',
  description: 'Plan: Run and document the new-user first-run path Plan Task 2: Add focused Pester coverage for the new-user startup decision',
  project: 'StateTrace',
  provider: 'ollama',
  created_at: '2026-01-15T09:05:00Z',
  tags: ['factory:batch_id=factory-659', 'factory:plan_task_number=2'],
  metadata: { plan_task_title: 'Add focused Pester coverage for the new-user startup decision', plan_task_number: 2 },
};
const mockOverview = {
  today: { total: 15, completed: 12, failed: 3, successRate: 80 },
  yesterday: { total: 10 },
  active: { running: 2, queued: 3 },
};
const localStorageState = {};

function createStuckTasks(overrides = {}) {
  return {
    total_needs_attention: 0,
    long_running: { tasks: [] },
    pending_approval: { tasks: [] },
    pending_switch: { tasks: [] },
    ...overrides,
  };
}

function setStorageValue(key, value) {
  localStorageState[key] = value;
}

function installStorageMock(initialState = {}) {
  Object.keys(localStorageState).forEach((k) => {
    delete localStorageState[k];
  });
  Object.assign(localStorageState, initialState);

  vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
    if (Object.prototype.hasOwnProperty.call(localStorageState, key)) return localStorageState[key];
    return null;
  });

  vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
    localStorageState[key] = String(value);
  });

  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation((key) => {
    delete localStorageState[key];
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  promise.catch(() => {});
  return { promise, resolve, reject };
}

describe('CommandCenter', () => {
  beforeEach(() => {
    requestV2.mockReset();
    requestV2.mockResolvedValue([
      { name: 'alpha', task_count: 3 },
      { name: 'beta', task_count: 2 },
    ]);
    // All list calls return empty by default
    tasksApi.list.mockResolvedValue(emptyTasks);
    // commandCenterSummary default adapter: call tasksApi.list per status so existing
    // test fixtures (`tasksApi.list.mockImplementation({ status } => ...)`)
    // keep working without rewriting every it() block. Each status becomes a
    // bucket whose `tasks` come from the per-status list call.
    tasksApi.commandCenterSummary.mockImplementation(async () => {
      const statuses = [
        'pending_approval', 'queued', 'running', 'pending_provider_switch',
        'completed', 'failed', 'cancelled',
      ];
      const buckets = {};
      await Promise.all(statuses.map(async (status) => {
        try {
          const resp = await tasksApi.list({ status, limit: 50 });
          buckets[status] = { tasks: (resp && resp.tasks) || [], total: (resp && resp.total) || 0 };
        } catch {
          buckets[status] = { tasks: [], total: 0 };
        }
      }));
      return buckets;
    });
    tasksApi.approve.mockResolvedValue({});
    tasksApi.reject.mockResolvedValue({});
    tasksApi.rejectSwitch.mockResolvedValue({});
    tasksApi.reassignProvider.mockResolvedValue({});
    factoryApi.projects.mockResolvedValue([]);
    factoryApi.loopStatus.mockResolvedValue({ loop_state: 'IDLE', loop_paused_at_stage: null, loop_last_action_at: null });
    factoryApi.startLoop.mockResolvedValue({});
    factoryApi.listLoopInstances.mockResolvedValue([]);
    factoryApi.startLoopInstance.mockResolvedValue({});
    factoryApi.loopInstanceStatus.mockResolvedValue({});
    factoryApi.advanceLoopInstance.mockResolvedValue({ job_id: 'instance-job-1', status: 'running' });
    factoryApi.loopInstanceJobStatus.mockResolvedValue({ status: 'running' });
    factoryApi.approveGateInstance.mockResolvedValue({});
    factoryApi.rejectGateInstance.mockResolvedValue({});
    factoryApi.retryVerifyInstance.mockResolvedValue({});
    factoryApi.advanceLoopAsync.mockResolvedValue({ job_id: 'loop-job-1', status: 'running' });
    factoryApi.loopJobStatus.mockResolvedValue({ status: 'completed' });
    factoryApi.approveGate.mockResolvedValue({});
    factoryApi.pause.mockResolvedValue({});
    factoryApi.resume.mockResolvedValue({});
    providersApi.list.mockResolvedValue([]);
    statsApi.overview.mockResolvedValue(mockOverview);
    statsApi.stuck.mockResolvedValue(createStuckTasks());
    statsApi.quality.mockResolvedValue({ overall: { avgScore: 85 } });
    statsApi.timeseries.mockResolvedValue([]);
    // Mock localStorage
    installStorageMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton initially', () => {
    tasksApi.list.mockReturnValue(new Promise(() => {}));
    tasksApi.commandCenterSummary.mockReturnValue(new Promise(() => {}));
    statsApi.overview.mockReturnValue(new Promise(() => {}));
    statsApi.stuck.mockReturnValue(new Promise(() => {}));
    statsApi.quality.mockReturnValue(new Promise(() => {}));
    statsApi.timeseries.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<CommandCenter />, { route: '/' });
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('renders compact metrics after loading', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      const metrics = screen.getByRole('region', { name: 'Command Center metrics' });
      expect(within(metrics).getByText('Today')).toBeInTheDocument();
      expect(within(metrics).getByText('Success')).toBeInTheDocument();
      expect(within(metrics).getByText('Gates')).toBeInTheDocument();
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows today task count from overview', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('15')).toBeInTheDocument();
    });
  });

  it('renders Needs Attention from the v2 snake_case stuck payload', async () => {
    statsApi.stuck.mockResolvedValue(createStuckTasks({
      total_needs_attention: 3,
      long_running: { tasks: [runningTask] },
      pending_approval: { tasks: [pendingApprovalTask] },
      pending_switch: { tasks: [pendingSwitchTask] },
    }));

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Needs Attention')).toBeInTheDocument();
      expect(screen.getByText('Running >30m')).toBeInTheDocument();
      expect(screen.getByText('Pending approval')).toBeInTheDocument();
      expect(screen.getByText('Pending switch')).toBeInTheDocument();
      expect(screen.getByText(/Pending approval test task/)).toBeInTheDocument();
      expect(screen.getByText(/Pending provider switch task/)).toBeInTheDocument();
    });
  });

  it('renders board column labels', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getAllByText('Pending Approval').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders empty state when no tasks', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Welcome to TORQUE')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
    });
  });

  it('renders project filter dropdown', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by project')).toBeInTheDocument();
    });
  });

  it('renders density toggle button', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Comfortable')).toBeInTheDocument();
    });
  });

  it('renders columns visibility button', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Columns')).toBeInTheDocument();
    });
  });

  it('renders refresh button', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByLabelText('Refresh dashboard data')).toBeInTheDocument();
    });
  });

  it('persists the task activity daily/hourly preference', async () => {
    statsApi.timeseries.mockResolvedValue([
      { date: '2026-01-15T10:00:00Z', completed: 1, failed: 0 },
    ]);

    renderWithProviders(<CommandCenter />, { route: '/' });

    const dailyButton = await screen.findByRole('button', { name: 'Daily' });
    fireEvent.click(dailyButton);

    expect(localStorage.getItem('torque-command-center-activity-view')).toBe('daily');
  });

  it('renders an operator brief with next action and clickable live signals', async () => {
    const onOpenDrawer = vi.fn();
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'failed') return Promise.resolve({ tasks: [failedTask], total: 1 });
      if (status === 'running') return Promise.resolve({ tasks: [runningTask], total: 1 });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter onOpenDrawer={onOpenDrawer} />, { route: '/' });

    await screen.findByRole('option', { name: 'alpha (3 tasks)' });
    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'alpha' } });

    const brief = await screen.findByRole('region', { name: 'Command Center briefing' });
    await waitFor(() => {
      expect(within(brief).getByText('Attention needed')).toBeInTheDocument();
      expect(within(brief).getByText('Next: Retry failed tasks')).toBeInTheDocument();
      expect(within(brief).getByText(/Q:42/)).toBeInTheDocument();
    });

    const signal = within(brief).getByRole('button', { name: /Failed deploy verification task/ });
    fireEvent.click(signal);
    expect(onOpenDrawer).toHaveBeenCalledWith('task-fail-1');
  });

  it('renders running log rows with concise operational context', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'alpha');
    const onOpenDrawer = vi.fn();
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'failed') return Promise.resolve({ tasks: [failedTask], total: 1 });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter onOpenDrawer={onOpenDrawer} />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    expect(within(log).getByText('Failed')).toBeInTheDocument();
    expect(within(log).getByText('Failed deploy verification task')).toBeInTheDocument();
    expect(within(log).getByText(/Q:42/)).toBeInTheDocument();
    expect(within(log).getByText(/exit 1/)).toBeInTheDocument();
    expect(within(log).getByText('Retryable failure')).toBeInTheDocument();

    fireEvent.click(within(log).getByRole('button', { name: /Failed deploy verification task/ }));
    expect(onOpenDrawer).toHaveBeenCalledWith('task-fail-1');
  });

  it('constrains the running log to a ten-row scrollbox', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'alpha');
    const logTasks = Array.from({ length: 11 }, (_, index) => ({
      ...runningTask,
      id: `task-run-${index + 1}`,
      task_description: `Alpha running task ${index + 1}`,
      project: 'alpha',
      created_at: `2026-01-15T10:${String(index).padStart(2, '0')}:00Z`,
      started_at: `2026-01-15T10:${String(index).padStart(2, '0')}:30Z`,
    }));
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') return Promise.resolve({ tasks: logTasks, total: logTasks.length });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    const scrollbox = screen.getByRole('region', { name: 'Running Log tasks' });
    expect(scrollbox).toHaveClass('overflow-y-auto');
    expect(scrollbox).toHaveStyle({ maxHeight: '409px' });
    expect(within(log).getAllByRole('listitem')).toHaveLength(11);
    expect(within(log).getAllByRole('button')[0]).toHaveClass('h-10');
  });

  it('renders short informative descriptions for factory-generated running log rows', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'factory-architect');
    const onOpenDrawer = vi.fn();
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'completed') return Promise.resolve({ tasks: [factoryArchitectTask], total: 1 });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter onOpenDrawer={onOpenDrawer} />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    expect(within(log).getByText('Architect cycle for DLPhone')).toBeInTheDocument();
    expect(within(log).getByText('to DLPhone')).toBeInTheDocument();
    expect(within(log).queryByText(/You are the Architect/)).toBeNull();
    expect(log).not.toHaveTextContent('factory-arch-1');

    fireEvent.click(within(log).getByRole('button', { name: /Architect cycle for DLPhone/ }));
    expect(onOpenDrawer).toHaveBeenCalledWith('factory-arch-1');
  });

  it('uses factory plan task titles instead of raw generated prompts', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'StateTrace');
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'queued') return Promise.resolve({ tasks: [factoryPlanTask], total: 1 });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    expect(within(log).getByText('Task 2: Add focused Pester coverage for the new-user startup decision')).toBeInTheDocument();
    expect(within(log).getByText('batch factory-659')).toBeInTheDocument();
    expect(within(log).queryByText(/Plan: Run and document/)).toBeNull();
    expect(log).not.toHaveTextContent('factory-plan-task-2');
  });

  it('renders a concise project-scoped running log with clickable rows', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'alpha');
    const onOpenDrawer = vi.fn();
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            { ...runningTask, id: 'task-run-1', task_description: 'Alpha running task', project: 'alpha' },
            { ...runningTask, id: 'task-run-2', task_description: 'Beta running task', project: 'beta' },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter onOpenDrawer={onOpenDrawer} />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    expect(within(log).getByText('Alpha running task')).toBeInTheDocument();
    expect(within(log).queryByText('Beta running task')).toBeNull();

    fireEvent.click(within(log).getByRole('button', { name: /Alpha running task/ }));
    expect(onOpenDrawer).toHaveBeenCalledWith('task-run-1');
  });

  it('defaults the running log to the active factory project', async () => {
    setStorageValue('torque-command-center-view', 'log');
    factoryApi.projects.mockResolvedValue([{
      id: 'factory-1',
      name: 'alpha',
      path: 'C:\\Users\\<os-user>\\Projects\\alpha',
      status: 'running',
      trust_level: 'guided',
      loop_state: 'EXECUTE',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:00Z',
    }]);
    factoryApi.loopStatus.mockResolvedValue({
      loop_state: 'EXECUTE',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:05Z',
    });
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'queued') return Promise.resolve({ tasks: [{ ...queuedTask, project: 'alpha' }] });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    const logPanel = log.closest('section');
    expect(logPanel).not.toBeNull();
    expect(within(logPanel).getByText('alpha')).toBeInTheDocument();
    expect(within(log).getByText('Queued test task')).toBeInTheDocument();
  });

  it('updates the running log when the selected factory loop project changes', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'DLPhone');
    factoryApi.projects.mockResolvedValue([
      {
        id: 'factory-dlphone',
        name: 'DLPhone',
        path: 'C:\\Users\\<os-user>\\Projects\\DLPhone',
        status: 'running',
        trust_level: 'guided',
        loop_state: 'EXECUTE',
        loop_paused_at_stage: null,
        loop_last_action_at: '2026-04-13T12:10:00Z',
      },
      {
        id: 'factory-netsim',
        name: 'NetSim',
        path: 'C:\\Users\\<os-user>\\Projects\\NetSim',
        status: 'running',
        trust_level: 'guided',
        loop_state: 'EXECUTE',
        loop_paused_at_stage: null,
        loop_last_action_at: '2026-04-13T12:00:00Z',
      },
    ]);
    factoryApi.loopStatus.mockResolvedValue({
      loop_state: 'EXECUTE',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:10:05Z',
    });
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            { ...runningTask, id: 'task-dlphone-1', task_description: 'DLPhone running task', project: 'DLPhone' },
            { ...runningTask, id: 'task-netsim-1', task_description: 'NetSim running task', project: 'NetSim' },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      const log = screen.getByRole('list', { name: 'Running Log' });
      expect(within(log).getByText('DLPhone running task')).toBeInTheDocument();
      expect(within(log).queryByText('NetSim running task')).toBeNull();
    });

    fireEvent.change(screen.getByLabelText('Factory project'), { target: { value: 'factory-netsim' } });

    await waitFor(() => {
      const log = screen.getByRole('list', { name: 'Running Log' });
      const logPanel = log.closest('section');
      expect(logPanel).not.toBeNull();
      expect(within(logPanel).getByText('NetSim')).toBeInTheDocument();
      expect(within(log).getByText('NetSim running task')).toBeInTheDocument();
      expect(within(log).queryByText('DLPhone running task')).toBeNull();
    });
  });

  it('renders the factory loop bar when factory projects exist', async () => {
    factoryApi.listLoopInstances.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111',
      project_id: 'factory-1',
      work_item_id: 41,
      batch_id: 'batch-plan-001',
      loop_state: 'PLAN',
      paused_at_stage: null,
      last_action_at: '2026-04-13T12:00:05Z',
    }]);
    factoryApi.projects.mockResolvedValue([{
      id: 'factory-1',
      name: 'torque-public',
      path: 'C:\\Users\\<os-user>\\Projects\\torque-public',
      status: 'running',
      trust_level: 'guided',
      loop_state: 'PLAN',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:00Z',
    }]);
    factoryApi.loopStatus.mockResolvedValue({
      loop_state: 'PLAN',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:05Z',
    });
    tasksApi.list.mockImplementation(({ status, project }) => {
      if (status === 'pending_approval' && project === 'torque-public') {
        return Promise.resolve({ total: 2, tasks: [pendingApprovalTask] });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    expect(await screen.findByText('Factory Loop')).toBeInTheDocument();
    expect(screen.getByLabelText('Factory project')).toHaveValue('factory-1');
    expect(screen.getAllByText('PLAN').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Advance' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /2 tasks awaiting approval/i })).toBeInTheDocument();
  });

  it('advances the factory loop from Command Center', async () => {
    factoryApi.listLoopInstances.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111',
      project_id: 'factory-1',
      work_item_id: 41,
      batch_id: 'batch-plan-001',
      loop_state: 'PLAN',
      paused_at_stage: null,
      last_action_at: '2026-04-13T12:00:05Z',
    }]);
    factoryApi.projects.mockResolvedValue([{
      id: 'factory-1',
      name: 'torque-public',
      path: 'C:\\Users\\<os-user>\\Projects\\torque-public',
      status: 'running',
      trust_level: 'guided',
      loop_state: 'PLAN',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:00Z',
    }]);
    factoryApi.loopStatus.mockResolvedValue({
      loop_state: 'PLAN',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:00:05Z',
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    // LoopControlBar mounts with empty instances, renders a legacy placeholder
    // from projects' loop_state, then re-renders once listLoopInstances resolves.
    // Wait until the real non-legacy instance card is present (its work-item
    // link to #41 only appears on the real instance, not the legacy placeholder)
    // before clicking Advance. Otherwise the click can land on the legacy button.
    await screen.findByText('Factory Loop');
    const workItemLink = await screen.findByRole('link', { name: '#41' });
    const instanceCard = workItemLink.closest('[data-testid="loop-instance-card"]');
    expect(instanceCard).not.toBeNull();
    const advanceBtn = within(instanceCard).getByRole('button', { name: 'Advance' });

    fireEvent.click(advanceBtn);

    await vi.waitFor(() => {
      expect(factoryApi.advanceLoopInstance).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111');
    });
  });

  it('keeps the refresh spinner active until manual refresh finishes', async () => {
    const timeseriesRefresh = createDeferred();

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    const refreshButton = screen.getByLabelText('Refresh dashboard data');
    statsApi.timeseries.mockClear();
    statsApi.timeseries.mockImplementation(() => timeseriesRefresh.promise);
    fireEvent.click(refreshButton);

    await waitFor(() => {
      expect(statsApi.timeseries).toHaveBeenCalled();
      expect(refreshButton.disabled).toBe(true);
      expect(refreshButton.querySelector('svg')?.classList.contains('animate-spin')).toBe(true);
    });

    timeseriesRefresh.resolve([]);

    await waitFor(() => {
      expect(refreshButton.disabled).toBe(false);
      expect(refreshButton.querySelector('svg')?.classList.contains('animate-spin')).toBe(false);
    });
  });

  it('shows task cards when tasks exist', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            id: 'task-run-1',
            status: 'running',
            task_description: 'Running test task',
            provider: 'codex',
            started_at: new Date().toISOString(),
            created_at: '2026-01-15T10:00:00Z',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
    });
  });

  it('defaults the board to all projects even when a log project was stored', async () => {
    setStorageValue('torque-command-center-view', 'board');
    setStorageValue('torque-command-center-project', 'DLPhone');
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            { ...runningTask, id: 'task-dlphone-1', task_description: 'DLPhone board task', project: 'DLPhone' },
            { ...runningTask, id: 'task-netsim-1', task_description: 'NetSim board task', project: 'NetSim' },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('DLPhone board task')).toBeInTheDocument();
      expect(screen.getByText('NetSim board task')).toBeInTheDocument();
      expect(screen.getByLabelText('Filter by project')).toHaveValue('');
    });
  });

  it('clears the factory loop scope when switching from running log to board', async () => {
    setStorageValue('torque-command-center-view', 'log');
    setStorageValue('torque-command-center-project', 'DLPhone');
    factoryApi.projects.mockResolvedValue([{
      id: 'factory-dlphone',
      name: 'DLPhone',
      path: 'C:\\Users\\<os-user>\\Projects\\DLPhone',
      status: 'running',
      trust_level: 'guided',
      loop_state: 'EXECUTE',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:10:00Z',
    }]);
    factoryApi.loopStatus.mockResolvedValue({
      loop_state: 'EXECUTE',
      loop_paused_at_stage: null,
      loop_last_action_at: '2026-04-13T12:10:05Z',
    });
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            { ...runningTask, id: 'task-dlphone-1', task_description: 'DLPhone board task', project: 'DLPhone' },
            { ...runningTask, id: 'task-netsim-1', task_description: 'NetSim board task', project: 'NetSim' },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const log = await screen.findByRole('list', { name: 'Running Log' });
    expect(within(log).getByText('DLPhone board task')).toBeInTheDocument();
    expect(within(log).queryByText('NetSim board task')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Board' }));

    await waitFor(() => {
      expect(screen.getByText('DLPhone board task')).toBeInTheDocument();
      expect(screen.getByText('NetSim board task')).toBeInTheDocument();
      expect(screen.getByLabelText('Filter by project')).toHaveValue('');
    });
  });

  it('filters displayed cards by selected project', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            { ...runningTask, id: 'task-run-1', task_description: 'Alpha running task', project: 'alpha' },
            { ...runningTask, id: 'task-run-2', task_description: 'Beta running task', project: 'beta' },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Alpha running task')).toBeInTheDocument();
      expect(screen.getByText('Beta running task')).toBeInTheDocument();
    });
    await screen.findByRole('option', { name: 'alpha (3 tasks)' });

    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'alpha' } });

    await waitFor(() => {
      expect(screen.getByText('Alpha running task')).toBeInTheDocument();
      expect(screen.queryByText('Beta running task')).toBeNull();
    });
  });

  it('shows factory kind badge for scout/architect/plan-gen tasks', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            {
              ...runningTask,
              id: 'task-scout-1',
              task_description: 'Starvation recovery scout for example-project',
              project: null,
              tags: [
                'factory:scout',
                'factory:reason=factory_starvation_recovery',
                'factory:starvation_recovery',
                'factory:target_project=example-project',
              ],
            },
            {
              ...runningTask,
              id: 'task-arch-2',
              task_description: 'Architect cycle',
              project: 'factory-architect',
              tags: ['factory:internal', 'factory:architect_cycle', 'factory:target_project=example-project'],
            },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Starvation recovery scout for example-project')).toBeInTheDocument();
      expect(screen.getByText('Architect cycle')).toBeInTheDocument();
    });
    expect(screen.getByText('scout')).toBeInTheDocument();
    expect(screen.getByText('architect')).toBeInTheDocument();
    // Both factory tasks point at the same downstream project, so the board
    // should show the target badge on each task.
    expect(screen.getAllByText('→ example-project')).toHaveLength(2);
  });

  it('shows target-project badge on factory-internal tasks (architect/plan)', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            {
              ...runningTask,
              id: 'task-arch-1',
              task_description: 'Architect cycle for example-project',
              project: 'factory-architect',
              tags: ['factory:internal', 'factory:architect_cycle', 'factory:target_project=example-project'],
            },
            {
              ...runningTask,
              id: 'task-plan-1',
              task_description: 'Plan generation for torque-public',
              project: 'factory-plan',
              tags: ['factory:internal', 'factory:plan_generation', 'factory:target_project=torque-public'],
            },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Architect cycle for example-project')).toBeInTheDocument();
      expect(screen.getByText('Plan generation for torque-public')).toBeInTheDocument();
    });
    expect(screen.getByText('→ example-project')).toBeInTheDocument();
    expect(screen.getByText('→ torque-public')).toBeInTheDocument();
  });

  it('does NOT show target-project badge when target equals task.project', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [
            {
              ...runningTask,
              id: 'task-direct-1',
              task_description: 'Direct task in example-project',
              project: 'example-project',
              tags: ['factory:target_project=example-project'],
            },
          ],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Direct task in example-project')).toBeInTheDocument();
    });
    expect(screen.queryByText('→ example-project')).toBeNull();
  });

  it('routes Reject for pending provider switch tasks', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'pending_provider_switch') {
        return Promise.resolve({ tasks: [pendingSwitchTask] });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const rejectButton = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(tasksApi.rejectSwitch).toHaveBeenCalledWith('task-switch-1');
    });
  });

  it('renders the pending approval column and approves held tasks', async () => {
    const approveDeferred = createDeferred();
    tasksApi.approve.mockReturnValueOnce(approveDeferred.promise);
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'pending_approval') {
        return Promise.resolve({
          tasks: [{
            ...pendingApprovalTask,
            tags: ['factory:batch_id=batch-42'],
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const pendingApprovalColumn = await screen.findByRole('list', { name: 'Pending Approval' });
    expect(within(pendingApprovalColumn).getByText('Pending approval test task')).toBeInTheDocument();
    expect(within(pendingApprovalColumn).getByText('Batch batch-42')).toBeInTheDocument();

    fireEvent.click(within(pendingApprovalColumn).getByRole('button', { name: 'Approve' }));

    await waitFor(() => {
      expect(tasksApi.approve).toHaveBeenCalledWith('task-approval-1');
      const queuedColumn = screen.getByRole('list', { name: 'Queued' });
      expect(within(queuedColumn).getByText('Pending approval test task')).toBeInTheDocument();
      expect(within(pendingApprovalColumn).queryByText('Pending approval test task')).toBeNull();
    });

    approveDeferred.resolve({});
  });

  it('reverts pending approval tasks when reject fails', async () => {
    const rejectDeferred = createDeferred();
    tasksApi.reject.mockReturnValueOnce(rejectDeferred.promise);
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'pending_approval') {
        return Promise.resolve({ tasks: [pendingApprovalTask] });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const pendingApprovalColumn = await screen.findByRole('list', { name: 'Pending Approval' });
    fireEvent.click(within(pendingApprovalColumn).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(tasksApi.reject).toHaveBeenCalledWith('task-approval-1');
      const cancelledColumn = screen.getByRole('list', { name: 'Cancelled' });
      expect(within(cancelledColumn).getByText('Pending approval test task')).toBeInTheDocument();
    });

    rejectDeferred.reject(new Error('Approval backend unavailable'));

    await waitFor(() => {
      const restoredPendingColumn = screen.getByRole('list', { name: 'Pending Approval' });
      const cancelledColumn = screen.getByRole('list', { name: 'Cancelled' });
      expect(within(restoredPendingColumn).getByText('Pending approval test task')).toBeInTheDocument();
      expect(within(cancelledColumn).queryByText('Pending approval test task')).toBeNull();
    });
  });

  it('reassigns queued tasks to a different provider', async () => {
    providersApi.list.mockResolvedValue([
      { provider: 'codex', enabled: true },
      { provider: 'groq', enabled: true },
    ]);
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'queued') {
        return Promise.resolve({ tasks: [queuedTask] });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    const providerSelect = await screen.findByLabelText('Reassign provider for task task-que');
    fireEvent.change(providerSelect, { target: { value: 'groq' } });
    fireEvent.click(screen.getByLabelText('Apply provider reassignment for task task-que'));

    await waitFor(() => {
      expect(tasksApi.reassignProvider).toHaveBeenCalledWith('task-queue-1', 'groq');
    });
  });

  it('displays provider without model when model is null', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            ...runningTask,
            provider: 'codex',
            model: null,
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.queryByText(/codex ·/)).toBeFalsy();
    });
  });

  it('displays provider with matching model', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            ...runningTask,
            provider: 'ollama',
            model: 'qwen2.5-coder:32b',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('ollama · qwen2.5-coder:32b')).toBeInTheDocument();
    });
  });

  it('hides stale model after provider failover', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            ...runningTask,
            provider: 'ollama',
            model: 'gpt-5.3-codex-spark',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('ollama')).toBeInTheDocument();
      expect(screen.queryByText('ollama · gpt-5.3-codex-spark')).toBeFalsy();
    });
  });

  it('hides model when it equals provider name', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            ...runningTask,
            provider: 'codex',
            model: 'codex',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.queryByText('codex · codex')).toBeFalsy();
    });
  });

  it('displays No tasks in empty columns', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      const noTasksTexts = screen.getAllByText('No tasks');
      expect(noTasksTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders total count text', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/0 total/)).toBeInTheDocument();
    });
  });

  it('marks task containers as lists', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByRole('list', { name: 'Queued' })).toBeInTheDocument();
    });
  });

  it('marks task cards as listitems', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            id: 'task-run-1',
            status: 'running',
            task_description: 'Running test task',
            provider: 'codex',
            started_at: new Date().toISOString(),
            created_at: '2026-01-15T10:00:00Z',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByRole('listitem')).toBeInTheDocument();
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
    });
  });

  it('exposes aria-expanded on collapse toggle', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByLabelText('Collapse Queued').getAttribute('aria-expanded')).toBe('true');
    });
  });

  it('activates task card with Enter key', async () => {
    const onOpenDrawer = vi.fn();
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            id: 'task-run-1',
            status: 'running',
            task_description: 'Running test task',
            provider: 'codex',
            started_at: new Date().toISOString(),
            created_at: '2026-01-15T10:00:00Z',
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter onOpenDrawer={onOpenDrawer} />, { route: '/' });

    const card = await screen.findByRole('listitem');
    fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });
    expect(onOpenDrawer).toHaveBeenCalledWith('task-run-1');
  });

  it('falls back to defaults when torque-col-sorts localStorage JSON is malformed', async () => {
    setStorageValue('torque-col-sorts', '{bad json');
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Welcome to TORQUE')).toBeInTheDocument();
    });
  });

  it('falls back to defaults when torque-collapsed-cols localStorage JSON is malformed', async () => {
    setStorageValue('torque-collapsed-cols', '{bad json');
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('falls back to defaults when torque-pinned localStorage JSON is malformed', async () => {
    setStorageValue('torque-pinned', '{bad json');
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') return Promise.resolve({ tasks: [runningTask] });
      return Promise.resolve(emptyTasks);
    });
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Pin to top' })).toBeInTheDocument();
    });
  });

  it('falls back to defaults when torque-hidden-cols localStorage JSON is malformed', async () => {
    setStorageValue('torque-hidden-cols', '{bad json');
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('uses default UI settings when expected localStorage keys are missing', async () => {
    renderWithProviders(<CommandCenter />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Comfortable')).toBeInTheDocument();
      expect(screen.getByText('Columns')).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Queued' })).toBeInTheDocument();
      expect(screen.getByRole('list', { name: 'Running' })).toBeInTheDocument();
    });
  });

  it('round-trips pinned Set and hidden column Array through localStorage serialization', async () => {
    setStorageValue('torque-hidden-cols', JSON.stringify(['queued']));
    setStorageValue('torque-pinned', JSON.stringify([]));
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') return Promise.resolve({ tasks: [runningTask] });
      if (status === 'queued') return Promise.resolve({ tasks: [queuedTask] });
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<CommandCenter />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Queued' })).toBeFalsy();
      expect(screen.getByRole('list', { name: 'Running' })).toBeInTheDocument();
    });

    const pinButton = screen.getByRole('button', { name: 'Pin to top' });
    fireEvent.click(pinButton);
    const pinnedFromStorage = JSON.parse(localStorage.getItem('torque-pinned') || '[]');
    const hiddenColsFromStorage = JSON.parse(localStorage.getItem('torque-hidden-cols') || '[]');
    expect(pinnedFromStorage).toEqual(['task-run-1']);
    expect(new Set(hiddenColsFromStorage)).toEqual(new Set(['queued']));
  });

  // Regression: WS deltas from `tasks:batch-updated` only carry a subset of fields
  // (see DELTA_FIELDS in server/dashboard-server.js). Before the merge fix, the board
  // replaced the full API-fetched row with the sparse delta, wiping `project`/`tags`
  // and making the project + factory batch badges flash and disappear on refresh.
  it('preserves project and factory tag badges when a sparse WS delta arrives', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'running') {
        return Promise.resolve({
          tasks: [{
            ...runningTask,
            project: 'alpha',
            tags: ['factory:batch_id=batch-42'],
          }],
        });
      }
      return Promise.resolve(emptyTasks);
    });

    const { rerender } = renderWithProviders(
      <CommandCenter tasks={[]} />,
      { route: '/' }
    );

    const runningColumn = await screen.findByRole('list', { name: 'Running' });
    await waitFor(() => {
      expect(within(runningColumn).getByText('alpha')).toBeInTheDocument();
      expect(within(runningColumn).getByText('Batch batch-42')).toBeInTheDocument();
    });

    // App.jsx receives `tasks:batch-updated` and propagates a delta-only payload
    // (no `project`, no `tags`) as the `tasks` prop. The badges must survive.
    rerender(
      <CommandCenter tasks={[{
        id: 'task-run-1',
        status: 'running',
        provider: 'codex',
        progress_percent: 50,
      }]} />
    );

    await waitFor(() => {
      expect(within(runningColumn).getByText('alpha')).toBeInTheDocument();
      expect(within(runningColumn).getByText('Batch batch-42')).toBeInTheDocument();
    });
  });
});
