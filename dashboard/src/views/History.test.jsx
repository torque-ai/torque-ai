import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import History from './History';

const { setSearchParamsMock } = vi.hoisted(() => ({
  setSearchParamsMock: vi.fn(),
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useSearchParams: () => [new URLSearchParams(), setSearchParamsMock],
  };
});

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  tasks: {
    list: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    reassignProvider: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
}));

vi.mock('date-fns', () => ({
  format: vi.fn((_date, _fmt) => '2026-01-15'),
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { tasks as tasksApi, providers as providersApi } from '../api';
import { requestV2 } from '../api';

const mockTasks = [
  {
    id: 'task-1',
    status: 'completed',
    task_description: 'Build feature A with tests',
    project: 'alpha',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    ollama_host_name: null,
    created_at: '2026-01-15T10:00:00Z',
    started_at: '2026-01-15T10:00:00Z',
    completed_at: '2026-01-15T10:05:00Z',
  },
  {
    id: 'task-2',
    status: 'failed',
    task_description: 'Fix broken tests',
    project: 'beta',
    provider: 'claude-cli',
    model: null,
    ollama_host_name: null,
    created_at: '2026-01-15T09:00:00Z',
    started_at: '2026-01-15T09:00:00Z',
    completed_at: '2026-01-15T09:03:00Z',
  },
];

const mockPagination = {
  page: 1,
  totalPages: 1,
  total: 2,
};

describe('History', () => {
  beforeEach(() => {
    setSearchParamsMock.mockReset();
    requestV2.mockReset();
    requestV2.mockResolvedValue([
      { name: 'alpha', task_count: 1 },
      { name: 'beta', task_count: 1 },
    ]);
    tasksApi.list.mockResolvedValue({ tasks: mockTasks, pagination: mockPagination });
    tasksApi.retry.mockResolvedValue({});
    tasksApi.cancel.mockResolvedValue({});
    tasksApi.reassignProvider.mockResolvedValue({});
    providersApi.list.mockResolvedValue([
      { provider: 'codex', enabled: true },
      { provider: 'ollama', enabled: true },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders task history heading', async () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('Task History')).toBeInTheDocument();
  });

  it('shows loading skeleton initially', () => {
    tasksApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<History />, { route: '/history' });
    const container = document.querySelector('.animate-pulse');
    expect(container).toBeInTheDocument();
  });

  it('renders task descriptions after loading', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText(/Build feature A/)).toBeInTheDocument();
      expect(screen.getByText(/Fix broken tests/)).toBeInTheDocument();
    });
  });

  it('renders Export CSV button', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('Export CSV')).toBeInTheDocument();
  });

  it('renders search input', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByPlaceholderText('Search tasks...')).toBeInTheDocument();
  });

  it('renders status filter dropdown', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('All Statuses')).toBeInTheDocument();
  });

  it('renders provider filter dropdown', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('All Providers')).toBeInTheDocument();
  });

  it('renders project filter dropdown', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByLabelText('Filter by project')).toBeInTheDocument();
  });

  it('renders date preset buttons', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('Today')).toBeInTheDocument();
      expect(screen.getByText('Last 7 Days')).toBeInTheDocument();
      expect(screen.getByText('Last 30 Days')).toBeInTheDocument();
    });
  });

  it('renders sortable column headers', async () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.getByText('Description')).toBeInTheDocument();
    expect(screen.getByText('Provider')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('shows no tasks found when list is empty', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [], pagination: { page: 1, totalPages: 1, total: 0 } });
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('No tasks found')).toBeInTheDocument();
    });
  });

  it('renders pagination controls', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('Previous')).toBeInTheDocument();
      expect(screen.getByText('Next')).toBeInTheDocument();
    });
  });

  it('computes total pages from pagination total and limit', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: mockTasks,
      pagination: { page: 1, limit: 25, total: 51 },
    });

    renderWithProviders(<History />, { route: '/history' });

    await waitFor(() => {
      expect(screen.getByText('Page 1 of 3 (51 total)')).toBeInTheDocument();
    });
  });

  it('shows Retry button for failed tasks', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  it('shows Reassign controls for queued tasks and submits the selected provider', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: [{
        id: 'task-queue-1',
        status: 'queued',
        task_description: 'Queued task awaiting provider reassignment',
        provider: 'codex',
        model: null,
        ollama_host_name: null,
        created_at: '2026-01-15T08:00:00Z',
        started_at: null,
        completed_at: null,
      }],
      pagination: { page: 1, totalPages: 1, total: 1 },
    });

    renderWithProviders(<History />, { route: '/history' });

    const select = await screen.findByLabelText('Reassign provider for task task-queue-1');
    fireEvent.change(select, { target: { value: 'ollama' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));

    await waitFor(() => {
      expect(tasksApi.reassignProvider).toHaveBeenCalledWith('task-queue-1', 'ollama');
    });
  });

  it('marks disabled providers as unavailable in queued task reassignment options', async () => {
    providersApi.list.mockResolvedValue([
      { provider: 'codex', enabled: true },
      { provider: 'ollama', enabled: false },
    ]);
    tasksApi.list.mockResolvedValueOnce({
      tasks: [{
        id: 'task-queue-1',
        status: 'queued',
        task_description: 'Queued task awaiting provider reassignment',
        provider: 'codex',
        model: null,
        ollama_host_name: null,
        created_at: '2026-01-15T08:00:00Z',
        started_at: null,
        completed_at: null,
      }],
      pagination: { page: 1, totalPages: 1, total: 1 },
    });

    renderWithProviders(<History />, { route: '/history' });

    const select = await screen.findByLabelText('Reassign provider for task task-queue-1');
    const disabledOption = await within(select).findByRole('option', { name: 'ollama (disabled)' });
    expect(disabledOption).toBeDisabled();
    expect(disabledOption).toHaveAttribute('value', 'ollama');
  });

  it('starts all selected bulk retries even if one never resolves', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: [
        {
          id: 'task-failed-1',
          status: 'failed',
          task_description: 'First failed task',
          provider: 'codex',
          model: null,
          ollama_host_name: null,
          created_at: '2026-01-15T08:00:00Z',
          started_at: '2026-01-15T08:00:00Z',
          completed_at: '2026-01-15T08:01:00Z',
        },
        {
          id: 'task-failed-2',
          status: 'failed',
          task_description: 'Second failed task',
          provider: 'codex',
          model: null,
          ollama_host_name: null,
          created_at: '2026-01-15T08:05:00Z',
          started_at: '2026-01-15T08:05:00Z',
          completed_at: '2026-01-15T08:06:00Z',
        },
      ],
      pagination: { page: 1, limit: 25, total: 2 },
    });

    let releaseFirstRetry;
    const firstRetry = new Promise((resolve) => {
      releaseFirstRetry = resolve;
    });

    tasksApi.retry
      .mockReturnValueOnce(firstRetry)
      .mockResolvedValueOnce({});

    renderWithProviders(<History />, { route: '/history' });

    await waitFor(() => {
      expect(screen.getByText('First failed task')).toBeInTheDocument();
      expect(screen.getByText('Second failed task')).toBeInTheDocument();
    });

    const checkboxes = screen.getAllByRole('checkbox');
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    fireEvent.click(screen.getByText('Retry Selected'));

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByText('Retry'));

    await waitFor(() => {
      expect(tasksApi.retry).toHaveBeenCalledTimes(2);
      expect(tasksApi.retry).toHaveBeenCalledWith('task-failed-1');
      expect(tasksApi.retry).toHaveBeenCalledWith('task-failed-2');
    });

    releaseFirstRetry({});
  });

  it('reloads tasks when sort changes and passes orderBy/orderDir', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(tasksApi.list).toHaveBeenCalled();
    });

    const priorCallCount = tasksApi.list.mock.calls.length;
    fireEvent.click(screen.getByText('Duration'));

    await waitFor(() => {
      expect(tasksApi.list.mock.calls.length).toBeGreaterThan(priorCallCount);
      const latestParams = tasksApi.list.mock.calls.at(-1)[0];
      expect(latestParams).toMatchObject({
        orderBy: 'duration',
        orderDir: 'asc',
      });
    });
  });

  it('passes the selected project filter to the task list api', async () => {
    renderWithProviders(<History />, { route: '/history' });

    await waitFor(() => {
      expect(tasksApi.list).toHaveBeenCalled();
    });
    await screen.findByRole('option', { name: 'alpha (1 tasks)' });

    fireEvent.change(screen.getByLabelText('Filter by project'), { target: { value: 'alpha' } });

    await waitFor(() => {
      const latestParams = tasksApi.list.mock.calls.at(-1)[0];
      expect(latestParams).toMatchObject({ project: 'alpha' });
    });
  });

  it('syncs the selected date range to the URL params', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(tasksApi.list).toHaveBeenCalled();
    });

    setSearchParamsMock.mockClear();
    fireEvent.click(screen.getByText('Today'));

    await waitFor(() => {
      expect(setSearchParamsMock).toHaveBeenCalledWith(
        { range: 'today' },
        { replace: true }
      );
    });
  });
});
