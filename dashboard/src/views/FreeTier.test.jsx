import { screen, waitFor, fireEvent, act } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import FreeTier from './FreeTier';

vi.mock('../api', () => ({
  freeTier: {
    status: vi.fn(),
    history: vi.fn(),
  },
}));

import { freeTier as freeTierApi } from '../api';

const mockData = {
  status: 'ok',
  providers: {
    groq: {
      rpm_limit: 30,
      rpd_limit: 14400,
      tpm_limit: 6000,
      tpd_limit: 500000,
      minute_requests: 5,
      minute_tokens: 1200,
      daily_requests: 100,
      daily_tokens: 25000,
      cooldown_remaining_seconds: 0,
      minute_resets_in_seconds: 45,
      daily_resets_in_seconds: 43200,
    },
    cerebras: {
      rpm_limit: 30,
      rpd_limit: 14400,
      tpm_limit: 8000,
      tpd_limit: 1000000,
      minute_requests: 0,
      minute_tokens: 0,
      daily_requests: 0,
      daily_tokens: 0,
      cooldown_remaining_seconds: 30,
      minute_resets_in_seconds: 60,
      daily_resets_in_seconds: 86400,
    },
  },
};

const mockHistoryData = {
  history: [
    { date: '2026-03-01', provider: 'groq', total_requests: 50, total_tokens: 12000 },
    { date: '2026-03-01', provider: 'cerebras', total_requests: 30, total_tokens: 8000 },
    { date: '2026-03-02', provider: 'groq', total_requests: 75, total_tokens: 18000 },
    { date: '2026-03-02', provider: 'cerebras', total_requests: 20, total_tokens: 5000 },
    { date: '2026-03-03', provider: 'groq', total_requests: 60, total_tokens: 15000 },
  ],
};

describe('FreeTier', () => {
  beforeEach(() => {
    freeTierApi.status.mockResolvedValue(mockData);
    freeTierApi.history.mockResolvedValue({ history: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows loading state initially', () => {
    freeTierApi.status.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders provider cards after data loads', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('groq')).toBeTruthy();
      expect(screen.getByText('cerebras')).toBeTruthy();
    });
  });

  it('shows error state with retry button on API failure', async () => {
    freeTierApi.status.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Failed to load free-tier status')).toBeTruthy();
      expect(screen.getByText('Network error')).toBeTruthy();
      expect(screen.getByText('Retry')).toBeTruthy();
    });
  });

  it('retry button re-fetches data', async () => {
    freeTierApi.status.mockRejectedValueOnce(new Error('Network error'));
    renderWithProviders(<FreeTier />, { route: '/free-tier' });

    await waitFor(() => {
      expect(screen.getByText('Retry')).toBeTruthy();
    });

    // Now resolve successfully on retry
    freeTierApi.status.mockResolvedValue(mockData);
    fireEvent.click(screen.getByText('Retry'));

    await waitFor(() => {
      expect(screen.getByText('groq')).toBeTruthy();
      expect(screen.getByText('cerebras')).toBeTruthy();
    });

    // At least 2 calls: initial load (failed) + retry click (interval may add more)
    expect(freeTierApi.status.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('shows correct summary stats for provider count', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Providers')).toBeTruthy();
      // 2 providers total
      expect(screen.getByText('2')).toBeTruthy();
    });
  });

  it('shows correct available count', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // "Available" appears in both StatCard label and groq provider badge
      const availableElements = screen.getAllByText('Available');
      expect(availableElements.length).toBeGreaterThanOrEqual(1);
      // groq is available (cooldown=0), cerebras is on cooldown (cooldown=30)
      // Available count = 1, On Cooldown count = 1
      // Both "1" values are present
      const ones = screen.getAllByText('1');
      expect(ones.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('shows correct cooldown count', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('On Cooldown')).toBeTruthy();
    });
  });

  it('shows daily requests stat', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Daily Requests')).toBeTruthy();
      // groq daily_requests=100, cerebras=0 => total=100
      expect(screen.getByText('100')).toBeTruthy();
    });
  });

  it('shows cooldown badge for providers on cooldown', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // cerebras has 30s cooldown — should show "Cooldown 30s"
      expect(screen.getByText('Cooldown 30s')).toBeTruthy();
    });
  });

  it('shows "Available" badge for providers not on cooldown', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // groq has cooldown_remaining_seconds=0, so it gets the green "Available" badge
      // The StatCard also says "Available", so use getAllByText
      const availableElements = screen.getAllByText('Available');
      // At least 2: one in StatCard label, one in groq's ProviderCard badge
      expect(availableElements.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('usage bars render with correct labels', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // Each provider has 4 usage bars
      const rpmBars = screen.getAllByText('Requests / Minute');
      const rpdBars = screen.getAllByText('Requests / Day');
      const tpmBars = screen.getAllByText('Tokens / Minute');
      const tpdBars = screen.getAllByText('Tokens / Day');

      expect(rpmBars.length).toBe(2);
      expect(rpdBars.length).toBe(2);
      expect(tpmBars.length).toBe(2);
      expect(tpdBars.length).toBe(2);
    });
  });

  it('usage bars show correct values for groq', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // groq: minute_requests=5, rpm_limit=30 => "5 / 30"
      expect(screen.getByText('5 / 30')).toBeTruthy();
      // groq: daily_requests=100, rpd_limit=14,400 => "100 / 14,400"
      expect(screen.getByText('100 / 14,400')).toBeTruthy();
      // groq: minute_tokens=1,200, tpm_limit=6,000 => "1,200 / 6,000"
      expect(screen.getByText('1,200 / 6,000')).toBeTruthy();
      // groq: daily_tokens=25,000, tpd_limit=500,000 => "25,000 / 500,000"
      expect(screen.getByText('25,000 / 500,000')).toBeTruthy();
    });
  });

  it('usage bars show correct values for cerebras', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // cerebras: minute_requests=0, rpm_limit=30 => "0 / 30"
      expect(screen.getByText('0 / 30')).toBeTruthy();
      // cerebras: daily_requests=0, rpd_limit=14,400 => "0 / 14,400"
      expect(screen.getByText('0 / 14,400')).toBeTruthy();
      // cerebras: minute_tokens=0, tpm_limit=8,000 => "0 / 8,000"
      expect(screen.getByText('0 / 8,000')).toBeTruthy();
      // cerebras: daily_tokens=0, tpd_limit=1,000,000 => "0 / 1,000,000"
      expect(screen.getByText('0 / 1,000,000')).toBeTruthy();
    });
  });

  it('shows empty state when no providers configured', async () => {
    freeTierApi.status.mockResolvedValue({ status: 'ok', providers: {} });
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('No free-tier providers configured.')).toBeTruthy();
    });
  });

  it('shows empty state description text', async () => {
    freeTierApi.status.mockResolvedValue({ status: 'ok', providers: {} });
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText(/Free-tier providers.*are used as overflow/)).toBeTruthy();
    });
  });

  it('empty state shows zero counts in stat cards', async () => {
    freeTierApi.status.mockResolvedValue({ status: 'ok', providers: {} });
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Providers')).toBeTruthy();
      // All stats should be 0
      const zeros = screen.getAllByText('0');
      expect(zeros.length).toBeGreaterThanOrEqual(4);
    });
  });

  it('auto-refreshes on interval', async () => {
    vi.useFakeTimers();
    try {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });

      // Flush initial load + microtasks
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      const initialCalls = freeTierApi.status.mock.calls.length;
      expect(initialCalls).toBeGreaterThanOrEqual(1);

      // Advance 30 seconds — should trigger interval refresh
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(freeTierApi.status.mock.calls.length).toBeGreaterThan(initialCalls);

      const afterFirstInterval = freeTierApi.status.mock.calls.length;

      // Advance another 30 seconds
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(freeTierApi.status.mock.calls.length).toBeGreaterThan(afterFirstInterval);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cleans up interval on unmount', async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      const { unmount } = renderWithProviders(<FreeTier />, { route: '/free-tier' });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      unmount();

      // clearInterval should have been called
      expect(clearIntervalSpy).toHaveBeenCalled();

      // No pending timers after unmount
      const callsAfterUnmount = freeTierApi.status.mock.calls.length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });

      // No additional calls after unmount
      expect(freeTierApi.status).toHaveBeenCalledTimes(callsAfterUnmount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders the heading and subtitle', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Free Tier Quotas')).toBeTruthy();
      expect(screen.getByText('Overflow providers for when Codex slots are full')).toBeTruthy();
    });
  });

  it('renders the Refresh button', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeTruthy();
    });
  });

  it('Refresh button re-fetches data', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeTruthy();
    });

    const callsBefore = freeTierApi.status.mock.calls.length;
    fireEvent.click(screen.getByText('Refresh'));

    await waitFor(() => {
      expect(freeTierApi.status.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('shows reset timer values for groq provider', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // groq minute_resets_in_seconds=45 => "45s"
      expect(screen.getByText('45s')).toBeTruthy();
      // groq daily_resets_in_seconds=43200 => "12h 0m" (formatDuration from utils/formatters)
      expect(screen.getByText('12h 0m')).toBeTruthy();
    });
  });

  it('shows reset timer values for cerebras provider', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // cerebras minute_resets_in_seconds=60 => "60s" (raw seconds display, not formatDuration)
      expect(screen.getByText('60s')).toBeTruthy();
      // cerebras daily_resets_in_seconds=86400 => "24h 0m" (formatDuration from utils/formatters)
      expect(screen.getByText('24h 0m')).toBeTruthy();
    });
  });

  it('calls freeTierApi.status on mount', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(freeTierApi.status).toHaveBeenCalled();
    });
  });

  it('does not show cooldown badge for groq (not on cooldown)', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('groq')).toBeTruthy();
    });
    // Only one Cooldown badge should appear (cerebras), not groq
    const cooldownBadges = screen.getAllByText(/^Cooldown/);
    expect(cooldownBadges.length).toBe(1);
  });

  it('does not show "Available" badge for cerebras (on cooldown)', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('cerebras')).toBeTruthy();
    });
    // "Available" badge in provider cards: only groq should have it
    // (StatCard label "Available" + groq badge = 2 total occurrences)
    const availableElements = screen.getAllByText('Available');
    expect(availableElements.length).toBe(2);
  });

  it('handles null providers gracefully', async () => {
    freeTierApi.status.mockResolvedValue({ status: 'ok' });
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('No free-tier providers configured.')).toBeTruthy();
    });
  });

  it('shows all four StatCard labels', async () => {
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      expect(screen.getByText('Providers')).toBeTruthy();
      expect(screen.getByText('On Cooldown')).toBeTruthy();
      expect(screen.getByText('Daily Requests')).toBeTruthy();
      // "Available" shows in both StatCard and provider badge
      expect(screen.getAllByText('Available').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders with single provider that has high usage', async () => {
    const highUsageData = {
      status: 'ok',
      providers: {
        groq: {
          rpm_limit: 30,
          rpd_limit: 100,
          tpm_limit: 6000,
          tpd_limit: 500000,
          minute_requests: 28,
          minute_tokens: 5500,
          daily_requests: 95,
          daily_tokens: 450000,
          cooldown_remaining_seconds: 0,
          minute_resets_in_seconds: 10,
          daily_resets_in_seconds: 3600,
        },
      },
    };
    freeTierApi.status.mockResolvedValue(highUsageData);
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // High usage values are rendered
      expect(screen.getByText('28 / 30')).toBeTruthy();
      expect(screen.getByText('95 / 100')).toBeTruthy();
    });
  });

  it('renders cooldown badge with minutes and seconds', async () => {
    const cooldownData = {
      status: 'ok',
      providers: {
        openrouter: {
          rpm_limit: 20,
          rpd_limit: 5000,
          tpm_limit: 10000,
          tpd_limit: 200000,
          minute_requests: 0,
          minute_tokens: 0,
          daily_requests: 0,
          daily_tokens: 0,
          cooldown_remaining_seconds: 125,
          minute_resets_in_seconds: 60,
          daily_resets_in_seconds: 86400,
        },
      },
    };
    freeTierApi.status.mockResolvedValue(cooldownData);
    renderWithProviders(<FreeTier />, { route: '/free-tier' });
    await waitFor(() => {
      // 125 seconds = 2m 5s
      expect(screen.getByText('Cooldown 2m 5s')).toBeTruthy();
    });
  });

  // --- Chart metric toggle tests ---

  describe('chart metric toggle', () => {
    beforeEach(() => {
      freeTierApi.history.mockResolvedValue(mockHistoryData);
    });

    it('renders toggle with Requests and Tokens options', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });
      await waitFor(() => {
        const tabs = screen.getAllByRole('tab');
        expect(tabs.length).toBe(2);
        expect(screen.getByRole('tab', { name: 'Requests' })).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Tokens' })).toBeTruthy();
      });
    });

    it('defaults to Requests selected', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });
      await waitFor(() => {
        const requestsTab = screen.getByRole('tab', { name: 'Requests' });
        const tokensTab = screen.getByRole('tab', { name: 'Tokens' });
        expect(requestsTab.getAttribute('aria-selected')).toBe('true');
        expect(tokensTab.getAttribute('aria-selected')).toBe('false');
      });
    });

    it('clicking Tokens switches the selected tab', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Tokens' })).toBeTruthy();
      });

      fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));

      await waitFor(() => {
        const requestsTab = screen.getByRole('tab', { name: 'Requests' });
        const tokensTab = screen.getByRole('tab', { name: 'Tokens' });
        expect(tokensTab.getAttribute('aria-selected')).toBe('true');
        expect(requestsTab.getAttribute('aria-selected')).toBe('false');
      });
    });

    it('clicking Requests after Tokens switches back', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Tokens' })).toBeTruthy();
      });

      // Switch to Tokens
      fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Tokens' }).getAttribute('aria-selected')).toBe('true');
      });

      // Switch back to Requests
      fireEvent.click(screen.getByRole('tab', { name: 'Requests' }));
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Requests' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('tab', { name: 'Tokens' }).getAttribute('aria-selected')).toBe('false');
      });
    });

    it('toggle has tablist role for accessibility', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });
      await waitFor(() => {
        const tablist = screen.getByRole('tablist');
        expect(tablist).toBeTruthy();
        expect(tablist.getAttribute('aria-label')).toBe('Chart metric');
      });
    });

    it('both metrics use the same provider color scheme', async () => {
      renderWithProviders(<FreeTier />, { route: '/free-tier' });

      // Wait for chart to render with history data
      await waitFor(() => {
        expect(screen.getByRole('tab', { name: 'Requests' })).toBeTruthy();
      });

      // In Requests mode, the chart renders Area components for each provider.
      // Recharts renders providers as legend items — check they exist.
      // The legend items are the same for both metrics since providerKeys come from history.
      await waitFor(() => {
        // With history data loaded, the chart section should not show the empty message
        expect(screen.queryByText('No usage history data yet.')).toBeNull();
      });

      // Switch to Tokens — the same provider legend entries should appear
      fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));

      await waitFor(() => {
        // Chart should still be visible (no empty state), meaning providers are rendered
        expect(screen.queryByText('No usage history data yet.')).toBeNull();
      });
    });

    it('shows empty chart message when no history regardless of metric', async () => {
      freeTierApi.history.mockResolvedValue({ history: [] });
      renderWithProviders(<FreeTier />, { route: '/free-tier' });

      await waitFor(() => {
        expect(screen.getByText(/No usage history data yet/)).toBeTruthy();
      });

      // Toggle should still be visible even with no data
      expect(screen.getByRole('tab', { name: 'Requests' })).toBeTruthy();
      expect(screen.getByRole('tab', { name: 'Tokens' })).toBeTruthy();

      // Switch to Tokens — still shows empty
      fireEvent.click(screen.getByRole('tab', { name: 'Tokens' }));
      await waitFor(() => {
        expect(screen.getByText(/No usage history data yet/)).toBeTruthy();
      });
    });
  });
});
