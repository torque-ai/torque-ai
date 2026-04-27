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

  it('soft-fails parked items list when the endpoint errors', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    factoryApi.projects.mockResolvedValue({ items: [{ id: 'proj-1', name: 'Demo' }] });
    factoryApi.intake.mockRejectedValue(new Error('not supported'));
    renderWithProviders(<CodexBreaker />);
    await waitFor(() => {
      expect(screen.getByText(/Parked items unavailable/i)).toBeInTheDocument();
    });
    consoleSpy.mockRestore();
  });
});
