import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import SessionSwitcher from './SessionSwitcher';

vi.mock('../api', () => ({
  instances: {
    list: vi.fn(),
  },
}));

import { instances as instancesApi } from '../api';

const mockInstances = {
  instances: [
    {
      instanceId: 'inst-abc123',
      shortId: 'abc123',
      isCurrent: true,
      pid: 1234,
      port: 3456,
      uptime: '2h 30m',
    },
    {
      instanceId: 'inst-def456',
      shortId: 'def456',
      isCurrent: false,
      pid: 5678,
      port: 3457,
      uptime: '1h 15m',
    },
  ],
};

describe('SessionSwitcher', () => {
  let originalLocation;

  function latestRefreshIntervalId(setIntervalSpy) {
    for (let i = setIntervalSpy.mock.calls.length - 1; i >= 0; i--) {
      if (setIntervalSpy.mock.calls[i][1] === 30000) {
        return setIntervalSpy.mock.results[i].value;
      }
    }
    return undefined;
  }

  async function flushFakeTimerEffects(ms = 0) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  }

  async function openDropdown(trigger) {
    fireEvent.click(trigger);
    expect(screen.getByText('Active Sessions')).toBeTruthy();
    await flushFakeTimerEffects(0);
  }

  async function closeDropdown(trigger) {
    fireEvent.click(trigger);
    expect(screen.queryByText('Active Sessions')).toBeFalsy();
    await flushFakeTimerEffects(0);
  }

  beforeEach(() => {
    originalLocation = window.location;
    instancesApi.list.mockClear();
    instancesApi.list.mockResolvedValue(mockInstances);
  });

  afterEach(() => {
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('renders session button with shortId', () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    expect(screen.getByText('abc123')).toBeTruthy();
  });

  it('renders green status dot', () => {
    const { container } = render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    const dot = container.querySelector('.bg-green-500');
    expect(dot).toBeTruthy();
  });

  it('shows ellipsis when shortId is not provided', () => {
    render(<SessionSwitcher instanceId="inst-abc123" />);
    expect(screen.getByText('...')).toBeTruthy();
  });

  it('opens dropdown on click', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText('Active Sessions')).toBeTruthy();
    });
  });

  it('shows session instances in dropdown', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      // abc123 appears in button + dropdown instance list
      expect(screen.getAllByText('abc123').length).toBeGreaterThanOrEqual(2);
      expect(screen.getByText('def456')).toBeTruthy();
    });
  });

  it('marks current session with badge', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText('current')).toBeTruthy();
    });
  });

  it('shows PID info for instances', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText('PID 1234')).toBeTruthy();
      expect(screen.getByText('PID 5678')).toBeTruthy();
    });
  });

  it('shows port info for instances', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText(':3456')).toBeTruthy();
      expect(screen.getByText(':3457')).toBeTruthy();
    });
  });

  it('shows empty state when no instances', async () => {
    instancesApi.list.mockResolvedValue({ instances: [] });
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText('No active sessions found')).toBeTruthy();
    });
  });

  it('closes dropdown on Escape', async () => {
    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));
    await waitFor(() => {
      expect(screen.getByText('Active Sessions')).toBeTruthy();
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByText('Active Sessions')).toBeFalsy();
    });
  });

  it('preserves search params and hash when switching sessions', async () => {
    Object.defineProperty(window, 'location', {
      value: new URL('http://dashboard.test:3456/tasks?tab=logs#stream'),
      writable: true,
      configurable: true,
    });

    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    fireEvent.click(screen.getByText('abc123'));

    await waitFor(() => {
      expect(screen.getByText('def456')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('def456'));

    expect(window.location.href).toBe('http://dashboard.test:3457/tasks?tab=logs#stream');
  });

  it('starts a refresh interval when opened and clears it when closed', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
      const trigger = screen.getByRole('button', { name: /abc123/i });

      await openDropdown(trigger);

      const intervalId = latestRefreshIntervalId(setIntervalSpy);
      expect(intervalId).toBeTruthy();

      await closeDropdown(trigger);

      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not spawn zombie intervals during rapid refresh toggles', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
      const trigger = screen.getByRole('button', { name: /abc123/i });

      await openDropdown(trigger);
      await closeDropdown(trigger);
      await openDropdown(trigger);
      await closeDropdown(trigger);

      const intervalIds = setIntervalSpy.mock.calls
        .map((call, index) => ({ interval: call[1], id: setIntervalSpy.mock.results[index]?.value }))
        .filter((entry) => entry.interval === 30000)
        .map((entry) => entry.id);
      expect(intervalIds.length).toBe(2);
      expect(new Set(intervalIds).size).toBe(2);
      intervalIds.forEach((intervalId) => {
        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps polling after network errors and does not leak timers', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    instancesApi.list.mockRejectedValue(new Error('network'));

    try {
      render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
      const trigger = screen.getByRole('button', { name: /abc123/i });

      await openDropdown(trigger);

      expect(instancesApi.list).toHaveBeenCalledTimes(1);

      await flushFakeTimerEffects(30000);

      expect(instancesApi.list).toHaveBeenCalledTimes(4);

      expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 30000).length).toBe(1);
      await closeDropdown(trigger);
      const intervalId = latestRefreshIntervalId(setIntervalSpy);
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts pending session list request when SessionSwitcher unmounts', async () => {
    vi.useFakeTimers();
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    let requestSignal;

    instancesApi.list.mockImplementation((options = {}) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    });

    try {
      const { unmount } = render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
      const trigger = screen.getByRole('button', { name: /abc123/i });

      await openDropdown(trigger);

      expect(requestSignal).toBeInstanceOf(AbortSignal);

      unmount();

      expect(requestSignal?.aborted).toBe(true);
      const intervalId = latestRefreshIntervalId(setIntervalSpy);
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores results from aborted session list requests', async () => {
    const pendingRequests = [];
    const freshInstances = {
      instances: [
        {
          instanceId: 'inst-ghi789',
          shortId: 'ghi789',
          isCurrent: false,
          pid: 9012,
          port: 3458,
          uptime: '20m',
        },
      ],
    };
    const staleInstances = {
      instances: [
        {
          instanceId: 'inst-old000',
          shortId: 'old000',
          isCurrent: false,
          pid: 3456,
          port: 3459,
          uptime: '5m',
        },
      ],
    };

    instancesApi.list.mockImplementation((options = {}) => new Promise((resolve) => {
      pendingRequests.push({ resolve, signal: options.signal });
    }));

    render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
    const trigger = screen.getByRole('button', { name: /abc123/i });

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('Active Sessions')).toBeTruthy();
    });
    expect(pendingRequests).toHaveLength(1);

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.queryByText('Active Sessions')).toBeFalsy();
    });
    expect(pendingRequests[0].signal?.aborted).toBe(true);

    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByText('Active Sessions')).toBeTruthy();
    });
    expect(pendingRequests).toHaveLength(2);

    await act(async () => {
      pendingRequests[1].resolve(freshInstances);
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByText('ghi789')).toBeTruthy();
    });

    await act(async () => {
      pendingRequests[0].resolve(staleInstances);
      await Promise.resolve();
    });

    expect(screen.queryByText('old000')).toBeFalsy();
    expect(screen.getByText('ghi789')).toBeTruthy();
  });

  it('stops refresh polling when the dropdown is closed', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      render(<SessionSwitcher shortId="abc123" instanceId="inst-abc123" />);
      const trigger = screen.getByRole('button', { name: /abc123/i });

      await openDropdown(trigger);

      expect(instancesApi.list).toHaveBeenCalledTimes(1);

      await flushFakeTimerEffects(60000);

      expect(instancesApi.list).toHaveBeenCalledTimes(3);

      const intervalId = latestRefreshIntervalId(setIntervalSpy);
      expect(intervalId).toBeTruthy();

      await closeDropdown(trigger);

      const callsAfterClose = instancesApi.list.mock.calls.length;
      await flushFakeTimerEffects(60000);

      expect(instancesApi.list).toHaveBeenCalledTimes(callsAfterClose);
      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
