import { screen, waitFor, fireEvent } from '@testing-library/react';
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

const mockTasks = [
  {
    id: 'task-1',
    status: 'completed',
    task_description: 'Build feature A with tests',
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
    expect(screen.getByText('Task History')).toBeTruthy();
  });

  it('shows loading skeleton initially', () => {
    tasksApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<History />, { route: '/history' });
    const container = document.querySelector('.animate-pulse');
    expect(container).toBeTruthy();
  });

  it('renders task descriptions after loading', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText(/Build feature A/)).toBeTruthy();
      expect(screen.getByText(/Fix broken tests/)).toBeTruthy();
    });
  });

  it('renders Export CSV button', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('Export CSV')).toBeTruthy();
  });

  it('renders search input', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByPlaceholderText('Search tasks...')).toBeTruthy();
  });

  it('renders status filter dropdown', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('All Statuses')).toBeTruthy();
  });

  it('renders provider filter dropdown', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('All Providers')).toBeTruthy();
  });

  it('renders date preset buttons', () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('All')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('This Week')).toBeTruthy();
    expect(screen.getByText('This Month')).toBeTruthy();
  });

  it('renders sortable column headers', async () => {
    renderWithProviders(<History />, { route: '/history' });
    expect(screen.getByText('Status')).toBeTruthy();
    expect(screen.getByText('Description')).toBeTruthy();
    expect(screen.getByText('Provider')).toBeTruthy();
    expect(screen.getByText('Duration')).toBeTruthy();
    expect(screen.getByText('Created')).toBeTruthy();
  });

  it('shows no tasks found when list is empty', async () => {
    tasksApi.list.mockResolvedValue({ tasks: [], pagination: { page: 1, totalPages: 1, total: 0 } });
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('No tasks found')).toBeTruthy();
    });
  });

  it('renders pagination controls', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('Previous')).toBeTruthy();
      expect(screen.getByText('Next')).toBeTruthy();
    });
  });

  it('shows Retry button for failed tasks', async () => {
    renderWithProviders(<History />, { route: '/history' });
    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('shows Reassign controls for queued tasks and submits the selected provider', async () => {
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
    const disabledOption = Array.from(select.options).find((option) => option.value === 'ollama');
    expect(disabledOption).toBeTruthy();
    expect(disabledOption.disabled).toBe(true);
    expect(disabledOption.textContent).toContain('(disabled)');
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
