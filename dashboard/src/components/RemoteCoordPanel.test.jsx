import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import RemoteCoordPanel from './RemoteCoordPanel';

const ACTIVE_PAYLOAD = {
  active: [
    {
      lock_id: 'abc12345deadbeef',
      project: 'torque-public',
      sha: 'deadbeef0123',
      suite: 'gate',
      holder: { host: 'omenhost', pid: 1234, user: 'k' },
      created_at: '2026-04-27T12:00:00.000Z',
      last_heartbeat_at: '2026-04-27T12:01:00.000Z',
    },
  ],
  reachable: true,
  cached_at: '2026-04-27T12:01:30.000Z',
};

const UNREACHABLE_PAYLOAD = {
  active: [],
  reachable: false,
  error: 'no_workstation_configured',
  cached_at: '2026-04-27T12:00:00.000Z',
};

const IDLE_PAYLOAD = {
  active: [],
  reachable: true,
  cached_at: '2026-04-27T12:00:00.000Z',
};

describe('RemoteCoordPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders one row per active workstation lock', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ACTIVE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText('torque-public')).toBeInTheDocument();
    });
    expect(screen.getByText('gate')).toBeInTheDocument();
    expect(screen.getByText(/omenhost/)).toBeInTheDocument();
    expect(screen.getByText(/1234/)).toBeInTheDocument();
    // sha rendered short (first 8 chars is the convention)
    expect(screen.getByText('deadbeef')).toBeInTheDocument();
  });

  it('shows "Workstation idle" when reachable with no active locks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => IDLE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText(/Workstation idle/i)).toBeInTheDocument();
    });
  });

  it('shows "not reachable" when daemon is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => UNREACHABLE_PAYLOAD,
    })));
    render(<RemoteCoordPanel />);
    await waitFor(() => {
      expect(screen.getByText(/not reachable/i)).toBeInTheDocument();
    });
    // Surface the error code for diagnostics
    expect(screen.getByText(/no_workstation_configured/)).toBeInTheDocument();
  });

  it('polls every 5s', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => IDLE_PAYLOAD,
    }));
    vi.stubGlobal('fetch', fetchMock);
    render(<RemoteCoordPanel />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
