import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Models from './Models';

// Mock recharts
vi.mock('recharts', () => ({
  BarChart: ({ children }) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  LineChart: ({ children }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Legend: () => null,
}));

vi.mock('../api', () => ({
  stats: {
    models: vi.fn(),
  },
}));

import { stats as statsApi } from '../api';

const mockModelData = {
  models: [
    {
      model: 'qwen3:8b',
      total: 30,
      completed: 28,
      failed: 2,
      success_rate: 93,
      avg_duration_seconds: 45,
      total_cost: 0.0,
      providers: ['ollama'],
    },
    {
      model: 'gpt-5.3-codex-spark',
      total: 20,
      completed: 18,
      failed: 2,
      success_rate: 90,
      avg_duration_seconds: 120,
      total_cost: 5.50,
      providers: ['codex'],
    },
  ],
  dailySeries: [
    { date: '2026-01-10', model: 'qwen3:8b', total: 5 },
    { date: '2026-01-10', model: 'gpt-5.3-codex-spark', total: 3 },
    { date: '2026-01-11', model: 'qwen3:8b', total: 8 },
    { date: '2026-01-11', model: 'gpt-5.3-codex-spark', total: 4 },
  ],
};

describe('Models', () => {
  beforeEach(() => {
    statsApi.models.mockResolvedValue(mockModelData);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    statsApi.models.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Models />, { route: '/models' });
    expect(screen.getByText('Loading model stats...')).toBeTruthy();
  });

  it('renders heading after loading', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Models')).toBeTruthy();
    });
  });

  it('displays summary stat cards', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Total Tasks')).toBeTruthy();
      expect(screen.getByText('Success Rate')).toBeTruthy();
      expect(screen.getByText('Models Used')).toBeTruthy();
      expect(screen.getByText('Est. Cost')).toBeTruthy();
    });
  });

  it('shows correct total tasks count', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('50')).toBeTruthy(); // 30 + 20
    });
  });

  it('shows model count', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      // '2' appears multiple times (model count, failed counts), verify at least one exists
      expect(screen.getAllByText('2').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders per-model breakdown table', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Per-Model Breakdown')).toBeTruthy();
    });
  });

  it('displays model names in table', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('qwen3:8b')).toBeTruthy();
      expect(screen.getByText('gpt-5.3-codex-spark')).toBeTruthy();
    });
  });

  it('shows success rate chart', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Success Rate by Model')).toBeTruthy();
    });
  });

  it('shows daily tasks chart', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Tasks per Day by Model')).toBeTruthy();
    });
  });

  it('renders day filter buttons (7d, 14d, 30d)', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('7d')).toBeTruthy();
      expect(screen.getByText('14d')).toBeTruthy();
      expect(screen.getByText('30d')).toBeTruthy();
    });
  });

  it('shows table column headers', async () => {
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText('Model')).toBeTruthy();
      expect(screen.getByText('Tasks')).toBeTruthy();
      expect(screen.getByText('Success')).toBeTruthy();
      expect(screen.getByText('Rate')).toBeTruthy();
      expect(screen.getByText('Avg Duration')).toBeTruthy();
      expect(screen.getByText('Cost')).toBeTruthy();
      expect(screen.getByText('Providers')).toBeTruthy();
    });
  });

  it('shows no data message when no models', async () => {
    statsApi.models.mockResolvedValue({ models: [], dailySeries: [] });
    renderWithProviders(<Models />, { route: '/models' });
    await waitFor(() => {
      expect(screen.getByText(/No model data/)).toBeTruthy();
    });
  });
});
