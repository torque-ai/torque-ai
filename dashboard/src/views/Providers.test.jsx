import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Providers from './Providers';

// Mock the api module
vi.mock('../api', () => ({
  providers: {
    list: vi.fn(),
    trends: vi.fn(),
    toggle: vi.fn(),
  },
  stats: {
    timeseries: vi.fn(),
  },
  hosts: {
    list: vi.fn(),
  },
  quota: {
    status: vi.fn(),
    history: vi.fn(),
  },
  requestV2: vi.fn(),
}));

import { providers as providersApi, stats as statsApi, hosts as hostsApi, quota as quotaApi, requestV2 } from '../api';

const mockProvidersList = [
  {
    provider: 'ollama',
    enabled: true,
    stats: {
      total_tasks: 50,
      completed_tasks: 45,
      failed_tasks: 5,
      success_rate: 90,
      avg_duration_seconds: 120,
      total_cost: 0,
    },
  },
  {
    provider: 'codex',
    enabled: true,
    stats: {
      total_tasks: 20,
      completed_tasks: 18,
      failed_tasks: 2,
      success_rate: 90,
      avg_duration_seconds: 60,
      total_cost: 2.50,
    },
  },
];

describe('Providers', () => {
  beforeEach(() => {
    providersApi.list.mockResolvedValue(mockProvidersList);
    statsApi.timeseries.mockResolvedValue([
      { date: '2026-03-10', total: 10, completed: 9, failed: 1, success_rate: 90, ollama: 7, codex: 3 },
    ]);
    hostsApi.list.mockResolvedValue([]);
    providersApi.trends.mockResolvedValue({
      providers: ['ollama', 'codex'],
      series: [
        { date: '2026-03-10', ollama_total: 7, codex_total: 3, ollama_success_rate: 86, codex_success_rate: 100 },
      ],
    });
    requestV2.mockResolvedValue(null);
    quotaApi.status.mockResolvedValue({});
    quotaApi.history.mockResolvedValue({
      history: [
        { date: '2026-03-09', provider: 'ollama', total_requests: 7, total_tokens: 7000 },
        { date: '2026-03-09', provider: 'codex', total_requests: 3, total_tokens: 9000 },
      ],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders provider statistics heading', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Provider Statistics')).toBeInTheDocument();
    });
  });

  it('renders provider cards after loading', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('ollama')).toBeInTheDocument();
      expect(screen.getByText('codex')).toBeInTheDocument();
    });
  });

  it('shows summary stat cards', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      // "Total Tasks" appears multiple times (summary card + each provider card) — use getAllByText
      const totalTasksElements = screen.getAllByText('Total Tasks');
      expect(totalTasksElements.length).toBeGreaterThanOrEqual(1);
      // "Providers" as summary label — only in summary StatCard
      expect(screen.getByText('Providers')).toBeInTheDocument();
    });
  });

  it('shows success rate for each provider', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getAllByText('90%').length).toBeGreaterThan(0);
    });
  });

  it('shows day range selector options', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      // "Last 7 days" appears in both select option and StatCard subtext — use getAllByText
      const dayElements = screen.getAllByText('Last 7 days');
      expect(dayElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders charts section', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Usage Over Time')).toBeInTheDocument();
      expect(screen.getByText('Provider Breakdown')).toBeInTheDocument();
    });
  });

  it('shows toggle switches for providers', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      // Each provider card has a toggle button with title "Disable provider" or "Enable provider"
      const toggles = screen.getAllByTitle(/able provider/);
      expect(toggles.length).toBe(2);
    });
  });

  it('shows empty state when no providers', async () => {
    providersApi.list.mockResolvedValue([]);
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('No providers configured')).toBeInTheDocument();
    });
  });

  it('renders duration comparison chart', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Average Duration by Provider')).toBeInTheDocument();
    });
  });

  it('renders overall success rate trend', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Overall Success Rate Trend')).toBeInTheDocument();
    });
  });

  it('renders 7-day provider usage chart when history is available', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('7-Day Provider Usage')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Requests' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Tokens' })).toBeInTheDocument();
    });
  });

  it('shows total tasks count in summary', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      // 50 + 20 = 70 total tasks
      expect(screen.getByText('70')).toBeInTheDocument();
    });
  });

  it('shows hosts label in summary', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Hosts')).toBeInTheDocument();
    });
  });

  it('shows view mode toggle between Overview and Compare', async () => {
    renderWithProviders(<Providers />);
    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
      expect(screen.getByText('Compare')).toBeInTheDocument();
    });
  });
});
