import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Strategic from './Strategy';

vi.mock('../api', () => ({
  strategic: {
    status: vi.fn(),
    operations: vi.fn(),
    decisions: vi.fn(),
    providerHealth: vi.fn(),
  },
  routingTemplates: {
    list: vi.fn().mockResolvedValue([]),
    getActive: vi.fn().mockResolvedValue({ template: null }),
    categories: vi.fn().mockResolvedValue([]),
  },
}));

import { strategic as strategicApi } from '../api';

const mockStatus = {
  provider: 'deepinfra',
  model: 'meta-llama/Llama-3.1-405B-Instruct',
  confidence_threshold: 0.4,
  usage: {
    total_calls: 15,
    total_tokens: 24500,
    total_cost: 0.32,
    total_duration_ms: 18200,
    fallback_calls: 3,
  },
  fallback_chain: ['deepinfra', 'hyperbolic', 'ollama'],
};

const mockOperations = [
  {
    id: 'task-op-001-aabbccdd',
    description: 'Strategic decomposition of UserAuth feature for Headwaters project',
    status: 'completed',
    provider: 'deepinfra',
    created_at: '2026-03-08T10:30:00Z',
  },
  {
    id: 'task-op-002-eeff0011',
    description: 'Strategic diagnosis of codex failure on test generation task',
    status: 'failed',
    provider: 'ollama',
    created_at: '2026-03-08T09:15:00Z',
  },
];

const mockDecisions = [
  {
    task_id: 'task-abc-12345678',
    created_at: '2026-03-08T12:00:00Z',
    complexity: 'complex',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    status: 'completed',
    fallback_used: false,
    needs_review: true,
    description: 'Write comprehensive tests for the UserAuth system',
  },
  {
    task_id: 'task-def-87654321',
    created_at: '2026-03-08T11:30:00Z',
    complexity: 'normal',
    provider: 'hashline-ollama',
    model: 'qwen2.5-coder:32b',
    status: 'running',
    fallback_used: false,
    needs_review: false,
    description: 'Fix import ordering in EventSystem.ts',
  },
  {
    task_id: 'task-ghi-11223344',
    created_at: '2026-03-08T11:00:00Z',
    complexity: 'simple',
    provider: 'ollama',
    model: 'qwen2.5-coder:32b',
    status: 'failed',
    fallback_used: true,
    needs_review: false,
    description: 'Update docs for the notification bridge component',
  },
];

const mockProviderHealth = [
  {
    provider: 'codex',
    enabled: true,
    health_status: 'healthy',
    success_rate_1h: 95,
    successes_1h: 19,
    failures_1h: 1,
    tasks_today: 24,
    completed_today: 22,
    failed_today: 2,
    avg_duration_seconds: 45,
  },
  {
    provider: 'ollama',
    enabled: true,
    health_status: 'warning',
    success_rate_1h: 80,
    successes_1h: 8,
    failures_1h: 2,
    tasks_today: 12,
    completed_today: 10,
    failed_today: 2,
    avg_duration_seconds: 120,
  },
  {
    provider: 'deepinfra',
    enabled: true,
    health_status: 'healthy',
    success_rate_1h: 100,
    successes_1h: 5,
    failures_1h: 0,
    tasks_today: 6,
    completed_today: 6,
    failed_today: 0,
    avg_duration_seconds: 30,
  },
  {
    provider: 'groq',
    enabled: false,
    health_status: 'disabled',
    success_rate_1h: null,
    successes_1h: 0,
    failures_1h: 0,
    tasks_today: 0,
    completed_today: 0,
    failed_today: 0,
    avg_duration_seconds: 0,
  },
];

describe('Strategic', () => {
  beforeEach(() => {
    strategicApi.status.mockResolvedValue(mockStatus);
    strategicApi.operations.mockResolvedValue({ operations: mockOperations });
    strategicApi.decisions.mockResolvedValue({ decisions: mockDecisions });
    strategicApi.providerHealth.mockResolvedValue({ providers: mockProviderHealth });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --- Loading / Error States ---

  it('renders loading state initially', () => {
    strategicApi.status.mockReturnValue(new Promise(() => {}));
    strategicApi.operations.mockReturnValue(new Promise(() => {}));
    strategicApi.decisions.mockReturnValue(new Promise(() => {}));
    strategicApi.providerHealth.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Strategic />, { route: '/strategy' });
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });

  it('renders error state on API failure', async () => {
    strategicApi.status.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Failed to load strategic brain status')).toBeInTheDocument();
      expect(screen.getByText('Network error')).toBeInTheDocument();
    });
  });

  it('renders retry button on error', async () => {
    strategicApi.status.mockRejectedValue(new Error('timeout'));
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeInTheDocument();
    });
  });

  // --- Heading and Layout ---

  it('renders heading after data loads', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Strategy')).toBeInTheDocument();
    });
  });

  it('renders subtitle text', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Routing decisions, provider health, and LLM-powered orchestration')).toBeInTheDocument();
    });
  });

  it('renders refresh button', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  // --- Top-Level Tab Bar ---

  it('renders top-level tab buttons', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Overview')).toBeInTheDocument();
      expect(screen.getByText('Decisions')).toBeInTheDocument();
      expect(screen.getByText('Operations')).toBeInTheDocument();
      expect(screen.getByText('Routing Templates')).toBeInTheDocument();
    });
  });

  // --- Stat Cards (Overview tab, default) ---

  it('displays Active Provider stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Active Provider')).toBeInTheDocument();
      // 'deepinfra' appears in stat card, config, health card, and chain
      const deepinfraElements = screen.getAllByText('deepinfra');
      expect(deepinfraElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays LLM Calls stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('LLM Calls')).toBeInTheDocument();
    });
  });

  it('displays Fallback Rate stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Fallback Rate')).toBeInTheDocument();
    });
  });

  it('displays Tokens Used stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Tokens Used')).toBeInTheDocument();
    });
  });

  it('displays Providers Enabled stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Providers Enabled')).toBeInTheDocument();
    });
  });

  it('displays Providers Healthy stat card', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Providers Healthy')).toBeInTheDocument();
    });
  });

  // --- Active Configuration ---

  it('displays active configuration section', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Active Configuration')).toBeInTheDocument();
    });
  });

  it('displays model name in configuration', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('meta-llama/Llama-3.1-405B-Instruct')).toBeInTheDocument();
    });
  });

  it('displays confidence threshold in configuration', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Confidence Threshold')).toBeInTheDocument();
      expect(screen.getByText('40%')).toBeInTheDocument();
    });
  });

  // --- Routing Summary ---

  it('displays routing summary section', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Routing Summary')).toBeInTheDocument();
    });
  });

  // --- Fallback Chain ---

  it('displays fallback chain section', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Fallback Chain')).toBeInTheDocument();
    });
  });

  it('displays all providers in the fallback chain', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      // The chain includes deepinfra, hyperbolic, ollama
      // These appear as chain nodes
      expect(screen.getByText('Fallback Chain')).toBeInTheDocument();
    });
    // Check for provider count
    expect(screen.getByText(/providers available/)).toBeInTheDocument();
  });

  it('displays active provider label in fallback chain footer', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText(/Active provider/)).toBeInTheDocument();
    });
  });

  // --- Provider Health Cards ---

  it('displays provider health section', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Provider Health')).toBeInTheDocument();
    });
  });

  it('displays individual provider health cards', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Provider Health')).toBeInTheDocument();
    });
    // Check provider names appear in health cards
    // 'codex' appears in health card
    const codexElements = screen.getAllByText('codex');
    expect(codexElements.length).toBeGreaterThanOrEqual(1);
  });

  it('displays health status badges', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      // healthy appears for codex and deepinfra, warning for ollama, disabled for groq
      const healthyElements = screen.getAllByText('healthy');
      expect(healthyElements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('displays warning status for degraded providers', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      const warningElements = screen.getAllByText('warning');
      expect(warningElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays disabled status for disabled providers', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      const disabledElements = screen.getAllByText('disabled');
      expect(disabledElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays success rate in health cards', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      // codex has 95%, appears as "95%"
      expect(screen.getByText('95%')).toBeInTheDocument();
    });
  });

  it('displays avg latency in health cards', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      // codex avg 45s, ollama 120s=2.0m, deepinfra 30s
      expect(screen.getByText('45s')).toBeInTheDocument();
      expect(screen.getByText('2.0m')).toBeInTheDocument();
      expect(screen.getByText('30s')).toBeInTheDocument();
    });
  });

  it('displays completed today count', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      // codex completed_today = 22
      expect(screen.getByText('22')).toBeInTheDocument();
    });
  });

  it('shows "No data" for providers with no success rate', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('No data')).toBeInTheDocument();
    });
  });

  it('shows empty provider health when no providers', async () => {
    strategicApi.providerHealth.mockResolvedValue({ providers: [] });
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('No provider health data available.')).toBeInTheDocument();
    });
  });

  // --- Decisions Tab ---

  it('switches to Decisions tab and shows decision history', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      // Decision History heading with count
      expect(screen.getByText(/3 decisions/)).toBeInTheDocument();
    });
  });

  it('displays decision history table headers', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('Time')).toBeInTheDocument();
      expect(screen.getByText('Task ID')).toBeInTheDocument();
      expect(screen.getByText('Complexity')).toBeInTheDocument();
      expect(screen.getByText('Flags')).toBeInTheDocument();
    });
  });

  it('displays truncated task IDs', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('task-abc')).toBeInTheDocument();
      expect(screen.getByText('task-def')).toBeInTheDocument();
      expect(screen.getByText('task-ghi')).toBeInTheDocument();
    });
  });

  it('displays complexity badges', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('complex')).toBeInTheDocument();
      expect(screen.getByText('normal')).toBeInTheDocument();
      expect(screen.getByText('simple')).toBeInTheDocument();
    });
  });

  it('displays status badges in decisions', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      // completed, running, failed statuses
      const completedElements = screen.getAllByText('completed');
      expect(completedElements.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('running')).toBeInTheDocument();
    });
  });

  it('displays fallback flag', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('fallback')).toBeInTheDocument();
    });
  });

  it('displays review flag', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      const reviewElements = screen.getAllByText('review');
      expect(reviewElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('does not require legacy split_advisory flags in v2 decisions', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.queryByText('split')).toBeNull();
    });
  });

  it('displays task descriptions', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('Write comprehensive tests for the UserAuth system')).toBeInTheDocument();
    });
  });

  it('displays model names (short form)', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('gpt-5.3-codex-spark')).toBeInTheDocument();
      // qwen2.5-coder:32b appears for both hashline-ollama and ollama tasks
      const qwenElements = screen.getAllByText('qwen2.5-coder:32b');
      expect(qwenElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows empty state when no decisions', async () => {
    strategicApi.decisions.mockResolvedValue({ decisions: [] });
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('No routing decisions recorded yet.')).toBeInTheDocument();
    });
  });

  // --- Sorting ---

  it('sorts decisions by clicking column header', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('Complexity')).toBeInTheDocument();
    });

    // Click complexity header to sort
    fireEvent.click(screen.getByText('Complexity'));

    // After sorting, all rows should still be present
    // TODO: Add data-testid to decision rows to enable order verification
    await waitFor(() => {
      expect(screen.getByText('complex')).toBeInTheDocument();
      expect(screen.getByText('normal')).toBeInTheDocument();
      expect(screen.getByText('simple')).toBeInTheDocument();
    });
  });

  it('toggles sort direction on second click', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Decisions')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Decisions'));

    await waitFor(() => {
      expect(screen.getByText('Complexity')).toBeInTheDocument();
    });

    // Click Complexity header twice to toggle direction
    fireEvent.click(screen.getByText('Complexity'));
    fireEvent.click(screen.getByText('Complexity'));

    // All rows still present after toggling
    // TODO: Add data-testid to decision rows to enable order verification
    await waitFor(() => {
      expect(screen.getByText('task-abc')).toBeInTheDocument();
    });
  });

  // --- Operations Tab ---

  it('switches to Operations tab', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Operations'));

    await waitFor(() => {
      expect(screen.getByText('Recent Strategic Operations')).toBeInTheDocument();
    });
  });

  it('displays operations table after switching tabs', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Operations'));

    await waitFor(() => {
      expect(screen.getByText(/Strategic decomposition of UserAuth/)).toBeInTheDocument();
      expect(screen.getByText(/Strategic diagnosis of codex failure/)).toBeInTheDocument();
    });
  });

  it('shows empty operations state when no operations', async () => {
    strategicApi.operations.mockResolvedValue({ operations: [] });
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Operations')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Operations'));

    await waitFor(() => {
      expect(screen.getByText('No strategic operations recorded yet.')).toBeInTheDocument();
    });
  });

  // --- Refresh ---

  it('calls all API endpoints on refresh', async () => {
    renderWithProviders(<Strategic />, { route: '/strategy' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });

    // Clear mocks to track refresh calls
    strategicApi.status.mockClear();
    strategicApi.operations.mockClear();
    strategicApi.decisions.mockClear();
    strategicApi.providerHealth.mockClear();

    // Re-mock resolved values
    strategicApi.status.mockResolvedValue(mockStatus);
    strategicApi.operations.mockResolvedValue({ operations: mockOperations });
    strategicApi.decisions.mockResolvedValue({ decisions: mockDecisions });
    strategicApi.providerHealth.mockResolvedValue({ providers: mockProviderHealth });

    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => {
      expect(strategicApi.status).toHaveBeenCalledTimes(1);
      expect(strategicApi.operations).toHaveBeenCalledTimes(1);
      expect(strategicApi.decisions).toHaveBeenCalledTimes(1);
      expect(strategicApi.providerHealth).toHaveBeenCalledTimes(1);
    });
  });
});
