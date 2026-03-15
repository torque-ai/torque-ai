import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders, mockFetch } from '../test-utils';
import Budget from './Budget';

// Mock recharts to avoid rendering issues in jsdom
vi.mock('recharts', () => ({
  LineChart: ({ children }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  BarChart: ({ children }) => <div data-testid="bar-chart">{children}</div>,
  Bar: () => null,
  PieChart: ({ children }) => <div data-testid="pie-chart">{children}</div>,
  Pie: () => null,
  Cell: () => null,
  Legend: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
}));

vi.mock('../api', () => ({
  budget: {
    summary: vi.fn(),
    status: vi.fn(),
  },
}));

import { budget as budgetApi } from '../api';

const mockSummary = {
  total_cost: 12.50,
  by_provider: {
    codex: { cost: 8.00 },
    'claude-cli': { cost: 4.50 },
  },
  daily: [
    { date: '2026-01-01', cost: 1.50 },
    { date: '2026-01-02', cost: 2.00 },
  ],
  task_count: 50,
};

const mockBudgetStatus = {
  limit: 100,
  used: 12.50,
};

describe('Budget', () => {
  beforeEach(() => {
    budgetApi.summary.mockResolvedValue(mockSummary);
    budgetApi.status.mockResolvedValue(mockBudgetStatus);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    budgetApi.summary.mockReturnValue(new Promise(() => {}));
    budgetApi.status.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Budget />, { route: '/budget' });
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders heading after data loads', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget & Costs')).toBeTruthy();
    });
  });

  it('displays total cost stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeTruthy();
      // $12.50 appears in both stat card and budget progress section
      expect(screen.getAllByText('$12.50').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays budget used stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget Used')).toBeTruthy();
    });
  });

  it('displays projected monthly stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Projected Monthly')).toBeTruthy();
    });
  });

  it('displays cost per task stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Cost per Task')).toBeTruthy();
    });
  });

  it('shows cost over time chart section', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Cost Over Time')).toBeTruthy();
    });
  });

  it('shows provider breakdown chart section', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Provider Breakdown')).toBeTruthy();
    });
  });

  it('renders bar/line chart toggle buttons', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Bar')).toBeTruthy();
      expect(screen.getByText('Line')).toBeTruthy();
    });
  });

  it('renders days dropdown with options', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Last 7 days')).toBeTruthy();
      expect(screen.getByText('Last 14 days')).toBeTruthy();
      // Last 30 days appears in both dropdown and stat subtext
      expect(screen.getAllByText('Last 30 days').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows no daily cost data message when empty', async () => {
    budgetApi.summary.mockResolvedValue({ ...mockSummary, daily: [] });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('No daily cost data available')).toBeTruthy();
    });
  });

  it('shows no provider cost data message when empty', async () => {
    budgetApi.summary.mockResolvedValue({ ...mockSummary, by_provider: {} });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('No provider cost data')).toBeTruthy();
    });
  });

  it('shows budget progress section when budget limit set', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget Progress')).toBeTruthy();
      expect(screen.getByText('Spent')).toBeTruthy();
      expect(screen.getByText('Budget')).toBeTruthy();
      expect(screen.getByText('Remaining')).toBeTruthy();
    });
  });

  it('does not show budget progress when no limit set', async () => {
    budgetApi.status.mockResolvedValue({ limit: 0, used: 0 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget & Costs')).toBeTruthy();
    });
    expect(screen.queryByText('Budget Progress')).toBeFalsy();
  });

  it('shows budget warning alert when usage >= 80%', async () => {
    budgetApi.status.mockResolvedValue({ limit: 100, used: 85 });
    budgetApi.summary.mockResolvedValue({ ...mockSummary, total_cost: 85 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText(/Budget warning/)).toBeTruthy();
    });
  });

  it('shows budget exceeded alert when usage >= 100%', async () => {
    budgetApi.status.mockResolvedValue({ limit: 100, used: 110 });
    budgetApi.summary.mockResolvedValue({ ...mockSummary, total_cost: 110 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText(/Budget exceeded/)).toBeTruthy();
    });
  });
});
