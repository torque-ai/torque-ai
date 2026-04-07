import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Kanban from './Kanban';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  tasks: {
    list: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    approveSwitch: vi.fn(),
    rejectSwitch: vi.fn(),
    reassignProvider: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
  stats: {
    overview: vi.fn(),
    stuck: vi.fn(),
    quality: vi.fn(),
    timeseries: vi.fn(),
  },
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { tasks as tasksApi, stats as statsApi, providers as providersApi } from '../api';
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
}

function createDeferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('Kanban', () => {
  beforeEach(() => {
    requestV2.mockReset();
    requestV2.mockResolvedValue([
      { name: 'alpha', task_count: 3 },
      { name: 'beta', task_count: 2 },
    ]);
    // All list calls return empty by default
    tasksApi.list.mockResolvedValue(emptyTasks);
    tasksApi.rejectSwitch.mockResolvedValue({});
    tasksApi.reassignProvider.mockResolvedValue({});
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
    statsApi.overview.mockReturnValue(new Promise(() => {}));
    statsApi.stuck.mockReturnValue(new Promise(() => {}));
    statsApi.quality.mockReturnValue(new Promise(() => {}));
    statsApi.timeseries.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Kanban />, { route: '/' });
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeInTheDocument();
  });

  it('renders stat cards after loading', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
      // Running/Queued/Completed appear in both stat cards and kanban columns
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows today task count from overview', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
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

    renderWithProviders(<Kanban />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('Needs Attention')).toBeInTheDocument();
      expect(screen.getByText('Running >30m')).toBeInTheDocument();
      expect(screen.getByText('Pending approval')).toBeInTheDocument();
      expect(screen.getByText('Pending switch')).toBeInTheDocument();
      expect(screen.getByText(/Pending approval test task/)).toBeInTheDocument();
      expect(screen.getByText(/Pending provider switch task/)).toBeInTheDocument();
    });
  });

  it('renders kanban column labels', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Completed').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Failed')).toBeInTheDocument();
    });
  });

  it('renders empty state when no tasks', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    });
  });

  it('renders search input', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
    });
  });

  it('renders project filter dropdown', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByLabelText('Filter by project')).toBeInTheDocument();
    });
  });

  it('renders density toggle button', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Comfortable')).toBeInTheDocument();
    });
  });

  it('renders columns visibility button', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('Columns')).toBeInTheDocument();
    });
  });

  it('renders refresh button', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByLabelText('Refresh dashboard data')).toBeInTheDocument();
    });
  });

  it('keeps the refresh spinner active until manual refresh finishes', async () => {
    const timeseriesRefresh = createDeferred();

    renderWithProviders(<Kanban />, { route: '/' });

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
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
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

    renderWithProviders(<Kanban />, { route: '/' });

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

  it('routes Reject for pending provider switch tasks', async () => {
    tasksApi.list.mockImplementation(({ status }) => {
      if (status === 'pending_provider_switch') {
        return Promise.resolve({ tasks: [pendingSwitchTask] });
      }
      return Promise.resolve(emptyTasks);
    });

    renderWithProviders(<Kanban />, { route: '/' });

    const rejectButton = await screen.findByRole('button', { name: 'Reject' });
    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(tasksApi.rejectSwitch).toHaveBeenCalledWith('task-switch-1');
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

    renderWithProviders(<Kanban />, { route: '/' });

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

    renderWithProviders(<Kanban />, { route: '/' });

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

    renderWithProviders(<Kanban />, { route: '/' });

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

    renderWithProviders(<Kanban />, { route: '/' });

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

    renderWithProviders(<Kanban />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.queryByText('codex · codex')).toBeFalsy();
    });
  });

  it('displays No tasks in empty columns', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      const noTasksTexts = screen.getAllByText('No tasks');
      expect(noTasksTexts.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders total count text', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/0 total/)).toBeInTheDocument();
    });
  });

  it('marks task containers as lists', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
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

    renderWithProviders(<Kanban />, { route: '/' });

    await waitFor(() => {
      expect(screen.getByRole('listitem')).toBeInTheDocument();
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
    });
  });

  it('exposes aria-expanded on collapse toggle', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
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

    renderWithProviders(<Kanban onOpenDrawer={onOpenDrawer} />, { route: '/' });

    const card = await screen.findByRole('listitem');
    fireEvent.keyDown(card, { key: 'Enter', code: 'Enter' });
    expect(onOpenDrawer).toHaveBeenCalledWith('task-run-1');
  });

  it('falls back to defaults when torque-col-sorts localStorage JSON is malformed', async () => {
    setStorageValue('torque-col-sorts', '{bad json');
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText('No tasks yet')).toBeInTheDocument();
    });
  });

  it('falls back to defaults when torque-collapsed-cols localStorage JSON is malformed', async () => {
    setStorageValue('torque-collapsed-cols', '{bad json');
    renderWithProviders(<Kanban />, { route: '/' });
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
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getByText(/Running test task/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Pin to top' })).toBeInTheDocument();
    });
  });

  it('falls back to defaults when torque-hidden-cols localStorage JSON is malformed', async () => {
    setStorageValue('torque-hidden-cols', '{bad json');
    renderWithProviders(<Kanban />, { route: '/' });
    await waitFor(() => {
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('uses default UI settings when expected localStorage keys are missing', async () => {
    renderWithProviders(<Kanban />, { route: '/' });
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

    renderWithProviders(<Kanban />, { route: '/' });

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
});
