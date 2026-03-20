import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import BatchHistory from './BatchHistory';

// Mock recharts to avoid rendering issues in jsdom
vi.mock('recharts', () => ({
  LineChart: ({ children }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  BarChart: ({ children }) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  AreaChart: ({ children }) => <div data-testid="area-chart">{children}</div>,
  Area: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
}));

// Mock the api module
vi.mock('../api', () => ({
  workflows: {
    list: vi.fn(),
    get: vi.fn(),
  },
}));

// Mock date-fns to avoid locale issues
vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

import { workflows as workflowsApi } from '../api';

const mockWorkflows = [
  {
    id: 'wf-1',
    name: 'Feature build',
    status: 'completed',
    created_at: '2026-01-01T00:00:00Z',
    started_at: '2026-01-01T00:00:00Z',
    completed_at: '2026-01-01T00:10:00Z',
    context: JSON.stringify({ total_tasks: 5, completed_tasks: 5, failed_tasks: 0 }),
  },
  {
    id: 'wf-2',
    name: 'Test run',
    status: 'failed',
    created_at: '2026-01-02T00:00:00Z',
    started_at: '2026-01-02T00:00:00Z',
    context: JSON.stringify({ total_tasks: 3, completed_tasks: 1, failed_tasks: 2 }),
  },
];

const mockWorkflowDetailV2 = {
  id: 'wf-1',
  name: 'Feature build',
  status: 'completed',
  tasks: [
    {
      id: 'task-compile',
      description: 'Compile generated types',
      provider: 'codex',
      model: 'gpt-5.1',
      progress: 100,
      depends_on: [],
      started_at: '2026-01-01T00:00:00Z',
      completed_at: '2026-01-01T00:02:30Z',
    },
    {
      id: 'task-verify',
      description: 'Run integration verification',
      provider: 'claude-cli',
      model: 'claude-3.7-sonnet',
      progress: 100,
      depends_on: ['task-compile'],
      started_at: '2026-01-01T00:02:30Z',
      completed_at: '2026-01-01T00:05:00Z',
    },
  ],
  cost: { total_cost_usd: 0.0075 },
};
const localStorageState = {};

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

describe('BatchHistory', () => {
  beforeEach(() => {
    workflowsApi.list.mockResolvedValue(mockWorkflows);
    installStorageMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders batch history heading', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    expect(screen.getByText('Batches')).toBeInTheDocument();
  });

  it('shows loading skeleton initially', () => {
    workflowsApi.list.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    // Should show skeleton rows (animate-pulse elements)
    const container = document.querySelector('.animate-pulse');
    expect(container).toBeInTheDocument();
  });

  it('renders workflow names after loading', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Feature build')).toBeInTheDocument();
      expect(screen.getByText('Test run')).toBeInTheDocument();
    });
  });

  it('shows status badges', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeInTheDocument();
      expect(screen.getByText('failed')).toBeInTheDocument();
    });
  });

  it('shows summary cards', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Total Workflows')).toBeInTheDocument();
      expect(screen.getByText('Success Rate')).toBeInTheDocument();
    });
  });

  it('renders status filter dropdown', () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    expect(screen.getByText('All Statuses')).toBeInTheDocument();
  });

  it('shows task counts', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      // completed workflow: 5/5 tasks
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  it('shows empty state with no workflows', async () => {
    workflowsApi.list.mockResolvedValue([]);
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('No workflows found')).toBeInTheDocument();
    });
  });

  it('renders refresh button', () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    // Refresh button has title="Refresh"
    expect(screen.getByTitle('Refresh')).toBeInTheDocument();
  });

  it('shows sort headers', () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();
    expect(screen.getByText('Duration')).toBeInTheDocument();
  });

  it('shows Avg Duration summary card', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Avg Duration')).toBeInTheDocument();
    });
  });

  it('shows Created column header', () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    expect(screen.getByText('Created')).toBeInTheDocument();
  });

  it('shows Tasks column header', () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    expect(screen.getByText('Tasks')).toBeInTheDocument();
  });

  it('falls back when localStorage getItem returns malformed JSON values', async () => {
    setStorageValue('torque-col-sorts', '{bad');
    setStorageValue('torque-hidden-cols', '{bad');
    setStorageValue('torque-pinned', '{bad');
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Batches')).toBeInTheDocument();
      expect(screen.getByText('Feature build')).toBeInTheDocument();
      expect(screen.getByText('Test run')).toBeInTheDocument();
    });
  });

  it('uses missing localStorage keys without affecting default rendering', async () => {
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Batches')).toBeInTheDocument();
      expect(screen.getByText('Total Workflows')).toBeInTheDocument();
      expect(screen.getByText('Success Rate')).toBeInTheDocument();
      expect(screen.getByText('Feature build')).toBeInTheDocument();
    });
  });

  // Smoke test: verifies component doesn't corrupt persisted localStorage
  it('supports Array localStorage round-trip serialization', async () => {
    localStorage.setItem('torque-hidden-cols', JSON.stringify(['completed', 'failed']));
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Batches')).toBeInTheDocument();
    });

    const persisted = JSON.parse(localStorage.getItem('torque-hidden-cols') || '[]');
    expect(persisted).toEqual(['completed', 'failed']);
    expect(Array.isArray(persisted)).toBe(true);
  });

  // Smoke test: verifies component doesn't corrupt persisted localStorage
  it('supports Set-style data persisted as JSON arrays', async () => {
    localStorage.setItem('torque-pinned', JSON.stringify(['wf-1', 'wf-2']));
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.getByText('Feature build')).toBeInTheDocument();
      expect(screen.getByText('Test run')).toBeInTheDocument();
    });

    const pinned = new Set(JSON.parse(localStorage.getItem('torque-pinned') || '[]'));
    expect(pinned.has('wf-1')).toBe(true);
    expect(pinned.has('wf-2')).toBe(true);
  });

  it('survives malformed localStorage entries while preserving defaults', async () => {
    setStorageValue('torque-history-columns', '{"bad');
    renderWithProviders(<BatchHistory />, { route: '/batches' });
    await waitFor(() => {
      expect(screen.queryByText('No workflows found')).toBeFalsy();
      expect(screen.getByText('Batches')).toBeInTheDocument();
    });
  });

  it('renders expanded batch details from the v2 workflow response shape', async () => {
    workflowsApi.get.mockResolvedValue(mockWorkflowDetailV2);
    renderWithProviders(<BatchHistory />, { route: '/batches' });

    await waitFor(() => {
      expect(screen.getByText('Feature build')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Feature build'));

    await waitFor(() => {
      expect(workflowsApi.get).toHaveBeenCalledWith('wf-1');
      expect(screen.getByText('Task Breakdown')).toBeInTheDocument();
      expect(screen.getByText('Total cost: $0.0075')).toBeInTheDocument();
      expect(screen.getByText('Compile generated types')).toBeInTheDocument();
      expect(screen.getByText('Run integration verification')).toBeInTheDocument();
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.getByText('claude-cli')).toBeInTheDocument();
      expect(screen.getByText('gpt-5.1')).toBeInTheDocument();
      expect(screen.getByText('claude-3.7-sonnet')).toBeInTheDocument();
    });
  });
});
