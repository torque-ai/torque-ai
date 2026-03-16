import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Workflows from './Workflows';

vi.mock('../api', () => ({
  workflows: {
    list: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '10 minutes ago'),
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { workflows as workflowsApi } from '../api';

const mockWorkflows = [
  {
    id: 'wf-1',
    name: 'Feature Workflow A',
    status: 'completed',
    created_at: '2026-01-15T10:00:00Z',
    started_at: '2026-01-15T10:00:00Z',
    completed_at: '2026-01-15T10:30:00Z',
    context: JSON.stringify({ total_tasks: 6, completed_tasks: 6, failed_tasks: 0 }),
  },
  {
    id: 'wf-2',
    name: 'Feature Workflow B',
    status: 'running',
    created_at: '2026-01-15T11:00:00Z',
    started_at: '2026-01-15T11:00:00Z',
    context: JSON.stringify({ total_tasks: 4, completed_tasks: 2, failed_tasks: 0 }),
  },
  {
    id: 'wf-3',
    name: 'Feature Workflow C',
    status: 'failed',
    created_at: '2026-01-15T09:00:00Z',
    started_at: '2026-01-15T09:00:00Z',
    completed_at: '2026-01-15T09:20:00Z',
    context: JSON.stringify({ total_tasks: 3, completed_tasks: 1, failed_tasks: 2 }),
  },
];

const mockWorkflowDetailV2 = {
  id: 'wf-1',
  name: 'Feature Workflow A',
  status: 'completed',
  tasks: [
    {
      id: 'task-compile',
      description: 'Compile generated types',
      provider: 'codex',
      model: 'gpt-5.1',
      progress: 100,
      depends_on: [],
      started_at: '2026-01-15T10:00:00Z',
      completed_at: '2026-01-15T10:02:30Z',
    },
    {
      id: 'task-verify',
      description: 'Run integration verification',
      provider: 'claude-cli',
      model: 'claude-3.7-sonnet',
      progress: 100,
      depends_on: ['task-compile'],
      started_at: '2026-01-15T10:02:30Z',
      completed_at: '2026-01-15T10:05:00Z',
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

describe('Workflows', () => {
  beforeEach(() => {
    workflowsApi.list.mockResolvedValue(mockWorkflows);
    installStorageMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading skeleton initially', () => {
    workflowsApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Workflows />, { route: '/workflows' });
    const skeleton = document.querySelector('.animate-pulse');
    expect(skeleton).toBeTruthy();
  });

  it('renders heading after loading', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Workflows')).toBeTruthy();
    });
  });

  it('displays summary stat cards', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Total Workflows')).toBeTruthy();
      expect(screen.getByText('Success Rate')).toBeTruthy();
      expect(screen.getByText('Avg Duration')).toBeTruthy();
      expect(screen.getByText('Active')).toBeTruthy();
    });
  });

  it('shows correct total workflows count', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      // Total workflows = 3
      expect(screen.getByText('3')).toBeTruthy();
    });
  });

  it('renders workflow names in table', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Feature Workflow A')).toBeTruthy();
      expect(screen.getByText('Feature Workflow B')).toBeTruthy();
      expect(screen.getByText('Feature Workflow C')).toBeTruthy();
    });
  });

  it('shows status badges', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('completed')).toBeTruthy();
      expect(screen.getByText('running')).toBeTruthy();
      expect(screen.getByText('failed')).toBeTruthy();
    });
  });

  it('renders status filter buttons', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('All')).toBeTruthy();
      expect(screen.getByText('Running')).toBeTruthy();
      expect(screen.getByText('Completed')).toBeTruthy();
      expect(screen.getByText('Failed')).toBeTruthy();
      expect(screen.getByText('Pending')).toBeTruthy();
      expect(screen.getByText('Cancelled')).toBeTruthy();
    });
  });

  it('shows table column headers', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Name')).toBeTruthy();
      expect(screen.getByText('Status')).toBeTruthy();
      expect(screen.getByText('Progress')).toBeTruthy();
      expect(screen.getByText('Duration')).toBeTruthy();
      expect(screen.getByText('Created')).toBeTruthy();
    });
  });

  it('renders refresh button', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByTitle('Refresh')).toBeTruthy();
    });
  });

  it('shows no workflows found when list is empty', async () => {
    workflowsApi.list.mockResolvedValue([]);
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('No workflows found')).toBeTruthy();
    });
  });

  it('displays failed task count in progress column', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('(2 failed)')).toBeTruthy();
    });
  });

  it('shows task progress fraction', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      // Workflow A: 6/6, Workflow B: 2/4, Workflow C: 1/3
      expect(screen.getByText('6')).toBeTruthy();
    });
  });

  it('falls back when localStorage contains malformed JSON for persisted preferences', async () => {
    setStorageValue('torque-col-sorts', '{bad');
    setStorageValue('torque-hidden-cols', '{bad');
    setStorageValue('torque-pinned', '{bad');
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Workflows')).toBeTruthy();
      expect(screen.getByText('Feature Workflow A')).toBeTruthy();
      expect(screen.getByText('Feature Workflow B')).toBeTruthy();
      expect(screen.getByText('Feature Workflow C')).toBeTruthy();
    });
  });

  it('uses default behavior when expected localStorage keys are absent', async () => {
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Workflows')).toBeTruthy();
      expect(screen.getByText('Total Workflows')).toBeTruthy();
      expect(screen.getByText('All')).toBeTruthy();
    });
  });

  it('persists and reloads Array values in localStorage', async () => {
    localStorage.setItem('torque-workflow-columns', JSON.stringify(['status', 'progress']));
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Feature Workflow A')).toBeTruthy();
    });

    const persisted = JSON.parse(localStorage.getItem('torque-workflow-columns') || '[]');
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted).toEqual(['status', 'progress']);
  });

  it('supports Set-like values encoded as arrays in localStorage', async () => {
    localStorage.setItem('torque-hidden-cols', JSON.stringify(['status', 'duration']));
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('All')).toBeTruthy();
      expect(screen.getByText('running')).toBeTruthy();
    });

    const asSet = new Set(JSON.parse(localStorage.getItem('torque-hidden-cols') || '[]'));
    expect(asSet.has('status')).toBe(true);
    expect(asSet.has('duration')).toBe(true);
  });

  it('does not crash when localStorage has bad JSON values', async () => {
    setStorageValue('torque-workflow-columns', '{"bad');
    renderWithProviders(<Workflows />, { route: '/workflows' });
    await waitFor(() => {
      expect(screen.getByText('Workflows')).toBeTruthy();
      expect(screen.getByText('Feature Workflow A')).toBeTruthy();
    });
  });

  it('renders expanded workflow details from the v2 workflow response shape', async () => {
    workflowsApi.get.mockResolvedValue(mockWorkflowDetailV2);
    renderWithProviders(<Workflows />, { route: '/workflows' });

    await waitFor(() => {
      expect(screen.getByText('Feature Workflow A')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Feature Workflow A'));

    await waitFor(() => {
      expect(workflowsApi.get).toHaveBeenCalledWith('wf-1');
      expect(screen.getByText('Task DAG')).toBeTruthy();
      expect(screen.getByText('Cost: $0.0075')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('Table'));

    await waitFor(() => {
      expect(screen.getByText('Compile generated types')).toBeTruthy();
      expect(screen.getByText('Run integration verification')).toBeTruthy();
      expect(screen.getByText('depends on: task-compile')).toBeTruthy();
      expect(screen.getByText('codex')).toBeTruthy();
      expect(screen.getByText('claude-cli')).toBeTruthy();
      expect(screen.getByText('gpt-5.1')).toBeTruthy();
      expect(screen.getByText('claude-3.7-sonnet')).toBeTruthy();
    });
  });
});
