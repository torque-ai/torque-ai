import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Budget from './Budget';

vi.mock('../api', () => ({
  request: vi.fn().mockResolvedValue({}),
  requestV2: vi.fn().mockResolvedValue({}),
  budget: {
    summary: vi.fn(),
    status: vi.fn(),
    forecast: vi.fn(),
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
    budgetApi.forecast.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    budgetApi.summary.mockReturnValue(new Promise(() => {}));
    budgetApi.status.mockReturnValue(new Promise(() => {}));
    budgetApi.forecast.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Budget />, { route: '/budget' });
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders heading after data loads', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget & Costs')).toBeInTheDocument();
    });
  });

  it('displays total cost stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Total Cost')).toBeInTheDocument();
      // $12.50 appears in both stat card and budget progress section
      expect(screen.getAllByText('$12.50').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays budget used stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget Used')).toBeInTheDocument();
    });
  });

  it('displays projected monthly stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Projected Monthly')).toBeInTheDocument();
    });
  });

  it('displays cost per task stat card', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Cost per Task')).toBeInTheDocument();
    });
  });

  it('shows cost over time chart section', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Cost Over Time')).toBeInTheDocument();
    });
  });

  it('shows provider breakdown chart section', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Provider Breakdown')).toBeInTheDocument();
    });
  });

  it('renders bar/line chart toggle buttons', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Bar')).toBeInTheDocument();
      expect(screen.getByText('Line')).toBeInTheDocument();
    });
  });

  it('renders days dropdown with options', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Last 7 days')).toBeInTheDocument();
      expect(screen.getByText('Last 14 days')).toBeInTheDocument();
      // Last 30 days appears in both dropdown and stat subtext
      expect(screen.getAllByText('Last 30 days').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows no daily cost data message when empty', async () => {
    budgetApi.summary.mockResolvedValue({ ...mockSummary, daily: [] });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('No daily cost data available')).toBeInTheDocument();
    });
  });

  it('shows no provider cost data message when empty', async () => {
    budgetApi.summary.mockResolvedValue({ ...mockSummary, by_provider: {} });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('No provider cost data')).toBeInTheDocument();
    });
  });

  it('shows budget progress section when budget limit set', async () => {
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget Progress')).toBeInTheDocument();
      expect(screen.getByText('Spent')).toBeInTheDocument();
      expect(screen.getByText('Budget')).toBeInTheDocument();
      expect(screen.getByText('Remaining')).toBeInTheDocument();
    });
  });

  it('does not show budget progress when no limit set', async () => {
    budgetApi.status.mockResolvedValue({ limit: 0, used: 0 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText('Budget & Costs')).toBeInTheDocument();
    });
    expect(screen.queryByText('Budget Progress')).toBeFalsy();
  });

  it('shows budget warning alert when usage >= 80%', async () => {
    budgetApi.status.mockResolvedValue({ limit: 100, used: 85 });
    budgetApi.summary.mockResolvedValue({ ...mockSummary, total_cost: 85 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText(/Budget warning/)).toBeInTheDocument();
    });
  });

  it('shows budget exceeded alert when usage >= 100%', async () => {
    budgetApi.status.mockResolvedValue({ limit: 100, used: 110 });
    budgetApi.summary.mockResolvedValue({ ...mockSummary, total_cost: 110 });
    renderWithProviders(<Budget />, { route: '/budget' });
    await waitFor(() => {
      expect(screen.getByText(/Budget exceeded/)).toBeInTheDocument();
    });
  });
});
