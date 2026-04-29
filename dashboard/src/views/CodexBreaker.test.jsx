import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import CodexBreaker from './CodexBreaker';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  codexBreaker: {
    getStatus: vi.fn(),
    trip: vi.fn(),
    untrip: vi.fn(),
    configurePolicy: vi.fn(),
  },
  factory: {
    projects: vi.fn(),
    intake: vi.fn(),
  },
}));

import { codexBreaker as codexBreakerApi, factory as factoryApi } from '../api';

const closedStatus = {
  provider: 'codex',
  state: { state: 'CLOSED', consecutiveFailures: 0, lastFailureCategory: null },
  persisted: { state: 'CLOSED', tripped_at: null, trip_reason: null },
};

const openStatus = {
  provider: 'codex',
  state: { state: 'OPEN', consecutiveFailures: 3, lastFailureCategory: 'sandbox_error' },
  persisted: {
    state: 'OPEN',
    tripped_at: '2026-04-26T15:30:00Z',
    trip_reason: 'manual operator trip',
  },
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('CodexBreaker view', () => {
  beforeEach(() => {
    codexBreakerApi.getStatus.mockResolvedValue(closedStatus);
    codexBreakerApi.trip.mockResolvedValue({});
    codexBreakerApi.untrip.mockResolvedValue({});
    codexBreakerApi.configurePolicy.mockResolvedValue({});
    factoryApi.projects.mockResolvedValue({ items: [] });
    factoryApi.intake.mockResolvedValue({ items: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the breaker status from get_codex_breaker_status', async () => {
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(codexBreakerApi.getStatus).toHaveBeenCalled();
    });
    const closedBadges = await screen.findAllByText('CLOSED');
    // One badge for live state, one for persisted record.
    expect(closedBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a loading skeleton before the breaker status response', async () => {
    const statusRequest = createDeferred();
    codexBreakerApi.getStatus.mockReturnValue(statusRequest.promise);

    renderWithProviders(<CodexBreaker />);

    expect(screen.getAllByTestId('loading-skeleton').length).toBeGreaterThanOrEqual(1);
    statusRequest.resolve(closedStatus);
    const closedBadges = await screen.findAllByText('CLOSED');
    expect(closedBadges.length).toBeGreaterThanOrEqual(2);
  });

  it('shows a retryable error state when breaker status fails', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    codexBreakerApi.getStatus
      .mockRejectedValueOnce(new Error('status backend offline'))
      .mockResolvedValueOnce(closedStatus);

    renderWithProviders(<CodexBreaker />);

    expect(await screen.findByText('Codex breaker status unavailable')).toBeInTheDocument();
    expect(screen.getByText(/status backend offline/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => {
      expect(codexBreakerApi.getStatus).toHaveBeenCalledTimes(2);
    });
    const closedBadges = await screen.findAllByText('CLOSED');
    expect(closedBadges.length).toBeGreaterThanOrEqual(2);
    consoleSpy.mockRestore();
  });

  it('shows OPEN state with persisted trip metadata', async () => {
    codexBreakerApi.getStatus.mockResolvedValue(openStatus);
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getAllByText('OPEN').length).toBeGreaterThanOrEqual(2);
    });
    expect(screen.getByText(/manual operator trip/)).toBeInTheDocument();
    expect(screen.getByText(/sandbox_error/)).toBeInTheDocument();
  });

  it('calls trip when the Trip button is clicked', async () => {
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getAllByText('CLOSED').length).toBeGreaterThanOrEqual(1);
    });
    const reasonInput = screen.getByPlaceholderText(/Reason/i);
    fireEvent.change(reasonInput, { target: { value: 'investigating sandbox issue' } });
    fireEvent.click(screen.getByRole('button', { name: /^Trip$/ }));
    await waitFor(() => {
      expect(codexBreakerApi.trip).toHaveBeenCalledWith('investigating sandbox issue');
    });
  });

  it('calls untrip when the Untrip button is clicked', async () => {
    codexBreakerApi.getStatus.mockResolvedValue(openStatus);
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getAllByText('OPEN').length).toBeGreaterThanOrEqual(1);
    });
    const reasonInput = screen.getByPlaceholderText(/Reason/i);
    fireEvent.change(reasonInput, { target: { value: 'codex restored' } });
    fireEvent.click(screen.getByRole('button', { name: /^Untrip$/ }));
    await waitFor(() => {
      expect(codexBreakerApi.untrip).toHaveBeenCalledWith('codex restored');
    });
  });

  it('shows a parked items loading state before factory projects resolve', async () => {
    const projectsRequest = createDeferred();
    factoryApi.projects.mockReturnValue(projectsRequest.promise);

    renderWithProviders(<CodexBreaker />);

    expect(screen.getByText(/Loading parked work items/i)).toBeInTheDocument();
    projectsRequest.resolve({ items: [] });
    expect(await screen.findByText(/No work items currently parked/i)).toBeInTheDocument();
  });

  it('renders parked work items from factory.intake', async () => {
    factoryApi.projects.mockResolvedValue({ items: [{ id: 'proj-1', name: 'Demo' }] });
    factoryApi.intake.mockResolvedValue({
      items: [
        { id: 42, title: 'Parked task A', status: 'parked_codex_unavailable', project_id: 'proj-1' },
      ],
    });
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getByText('Parked task A')).toBeInTheDocument();
    });
  });

  it('shows a global parked items failure without hiding breaker status', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factoryApi.projects.mockResolvedValue({ items: [{ id: 'proj-1', name: 'Demo' }] });
    factoryApi.intake.mockRejectedValue(new Error('not supported'));
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getByText(/Parked items unavailable/i)).toBeInTheDocument();
    });
    expect(screen.getByText(/Every project intake request failed/i)).toBeInTheDocument();
    const closedBadges = await screen.findAllByText('CLOSED');
    expect(closedBadges.length).toBeGreaterThanOrEqual(2);
    consoleSpy.mockRestore();
  });

  it('shows parked items from working projects when some fail', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factoryApi.projects.mockResolvedValue({
      items: [
        { id: 'p_ok', name: 'Working' },
        { id: 'p_fail', name: 'Failing' },
      ],
    });
    factoryApi.intake.mockImplementation((projectId) => {
      if (projectId === 'p_fail') return Promise.reject(new Error('500 error'));
      return Promise.resolve({
        items: [{ id: 1, title: 'Parked Item A', status: 'parked_codex_unavailable', project_id: 'p_ok' }],
      });
    });
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getByText('Parked Item A')).toBeInTheDocument();
    });
    expect(screen.getByText(/Some parked items could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/parked items unavailable/i)).not.toBeInTheDocument();
    consoleSpy.mockRestore();
  });

  it('shows the parked items empty state when no projects return parked work', async () => {
    factoryApi.projects.mockResolvedValue({ items: [{ id: 'proj-1', name: 'Demo' }] });
    factoryApi.intake.mockResolvedValue({ items: [] });

    renderWithProviders(<CodexBreaker />);

    expect(await screen.findByText(/No work items currently parked/i)).toBeInTheDocument();
  });
});
