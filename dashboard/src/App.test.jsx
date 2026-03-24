import { screen, waitFor, act } from '@testing-library/react';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from './components/Toast';
import { hosts as hostsApi } from './api';

// Mock recharts (used by Kanban)
vi.mock('recharts', () => ({
  LineChart: ({ children }) => <div data-testid="line-chart">{children}</div>,
  Line: () => null,
  XAxis: () => null,
  YAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  ResponsiveContainer: ({ children }) => <div>{children}</div>,
  Legend: () => null,
}));

// Mock the api module
vi.mock('./api', () => ({
  request: vi.fn().mockResolvedValue({}),
  requestV2: vi.fn().mockResolvedValue({}),
  tasks: {
    list: vi.fn().mockResolvedValue({ tasks: [] }),
    get: vi.fn().mockResolvedValue(null),
    diff: vi.fn().mockResolvedValue(null),
    retry: vi.fn().mockResolvedValue({}),
    cancel: vi.fn().mockResolvedValue({}),
    approveSwitch: vi.fn().mockResolvedValue({}),
  },
  stats: {
    overview: vi.fn().mockResolvedValue({
      today: { total: 5, completed: 3, failed: 1, successRate: 75 },
      yesterday: { total: 4 },
      active: { running: 1, queued: 2 },
    }),
    stuck: vi.fn().mockResolvedValue({ totalNeedsAttention: 0 }),
    quality: vi.fn().mockResolvedValue({ overall: { avgScore: 85 } }),
    timeseries: vi.fn().mockResolvedValue([]),
    models: vi.fn().mockResolvedValue([]),
  },
  hosts: {
    list: vi.fn().mockResolvedValue([]),
    activity: vi.fn().mockResolvedValue(null),
    toggle: vi.fn().mockResolvedValue({}),
    scan: vi.fn().mockResolvedValue({}),
  },
  providers: {
    list: vi.fn().mockResolvedValue([]),
    stats: vi.fn().mockResolvedValue({}),
    trends: vi.fn().mockResolvedValue([]),
    percentiles: vi.fn().mockResolvedValue({}),
    toggle: vi.fn().mockResolvedValue({}),
  },
  budget: {
    summary: vi.fn().mockResolvedValue({}),
    status: vi.fn().mockResolvedValue({}),
  },
  taskLogs: {
    get: vi.fn().mockResolvedValue([]),
  },
  planProjects: {
    list: vi.fn().mockResolvedValue({ projects: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
  },
  workflows: {
    list: vi.fn().mockResolvedValue({ workflows: [], pagination: { page: 1, totalPages: 1, total: 0 } }),
  },
  routingTemplates: {
    list: vi.fn().mockResolvedValue([]),
    getActive: vi.fn().mockResolvedValue(null),
    setActive: vi.fn().mockResolvedValue({}),
  },
  default: {},
}));

// Mock useAbortableRequest (used by Kanban, History, etc.)
// Stable reference outside the mock factory prevents useEffect re-runs on every render
vi.mock('./hooks/useAbortableRequest', () => {
  const stableExecute = (fn) => fn(() => true);
  const stableReturn = { execute: stableExecute };
  return {
    useAbortableRequest: () => stableReturn,
  };
});

// Mock date-fns (used by History)
vi.mock('date-fns', () => ({
  format: vi.fn((_date, _fmt) => '2026-01-15'),
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

// Create a mock WebSocket class
let mockWsInstance = null;
class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;

  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    mockWsInstance = this;
    // Simulate connection open (transition CONNECTING → OPEN like real WebSocket)
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen({});
    }, 0);
  }
  send() {}
  close() {
    this.readyState = MockWebSocket.CLOSED;
  }
}

// Apply WebSocket mock using vi.stubGlobal for reliable override
beforeAll(() => {
  vi.stubGlobal('WebSocket', MockWebSocket);
});
afterAll(() => {
  vi.unstubAllGlobals();
});

// Mock canvas for favicon tests
beforeEach(() => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue(null);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {});
  hostsApi.activity.mockClear();
  hostsApi.activity.mockResolvedValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
  mockWsInstance = null;
  document.title = 'TORQUE';
});

// Lazy import of App to ensure mocks are set up first
let App;
beforeAll(async () => {
  const mod = await import('./App');
  App = mod.default;
});

function renderApp(_route = '/') {
  return render(<App />, {
    wrapper: ({ children }) => children,
  });
}

function emitWsMessage(message) {
  act(() => {
    mockWsInstance?.onmessage?.({ data: JSON.stringify(message) });
  });
}

function getLatestIntervalId(setIntervalSpy, delayMs) {
  for (let i = setIntervalSpy.mock.calls.length - 1; i >= 0; i--) {
    if (setIntervalSpy.mock.calls[i][1] === delayMs) {
      return setIntervalSpy.mock.results[i].value;
    }
  }
  return undefined;
}

describe('App', () => {
  it('renders without crashing', async () => {
    renderApp();
    await waitFor(() => {
      expect(document.querySelector('.flex')).toBeInTheDocument();
    });
  });

  it('shows Layout component with TORQUE branding', async () => {
    renderApp();
    await waitFor(() => {
      // TORQUE appears in sidebar h1 and breadcrumb span
      const elements = screen.getAllByText('TORQUE');
      expect(elements.length).toBeGreaterThanOrEqual(1);
      // The h1 branding element specifically
      const h1 = elements.find(el => el.tagName === 'H1');
      expect(h1).toBeInTheDocument();
    });
  });

  it('shows sidebar navigation links', async () => {
    renderApp();
    await waitFor(() => {
      // Some labels appear in both sidebar and breadcrumb — use getAllByText
      expect(screen.getAllByText('Kanban').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('History').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Providers').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Workflows').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Infrastructure').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Operations').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Project Settings').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('Hosts')).toBeNull();
      expect(screen.queryByText('Budget')).toBeNull();
      expect(screen.queryByText('Projects')).toBeNull();
      expect(screen.queryByText('Batches')).toBeNull();
      expect(screen.queryByText('Models')).toBeNull();
    });
  });

  it('renders the project settings route', async () => {
    window.history.replaceState({}, '', '/settings');
    renderApp();
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Project Settings' })).toBeInTheDocument();
    });
  });

  it('default route renders Kanban view', async () => {
    renderApp('/');
    await waitFor(() => {
      // Kanban shows "Today" stat card
      expect(screen.getByText('Today')).toBeInTheDocument();
    });
  });

  it('renders notification bell button', async () => {
    renderApp();
    await waitFor(() => {
      const bellButton = screen.getByLabelText(/Notifications:\s*no alerts/);
      expect(bellButton).toBeInTheDocument();
    });
  });

  it('initializes WebSocket connection', async () => {
    renderApp();
    await waitFor(() => {
      expect(mockWsInstance).toBeTruthy();
      expect(mockWsInstance.url).toContain('ws');
    });
  });

  it('shows connection status indicator', async () => {
    renderApp();
    await waitFor(() => {
      // After WebSocket connects, should show "Connected"
      expect(screen.getByText('Connected')).toBeInTheDocument();
    });
  });

  it('sets dynamic page title to TORQUE by default', async () => {
    renderApp();
    await waitFor(() => {
      expect(document.title).toBe('TORQUE');
    });
  });

  it('creates dynamic favicon', async () => {
    renderApp();
    await waitFor(() => {
      const link = document.querySelector("link[rel~='icon']");
      expect(link).toBeInTheDocument();
    });
  });

  it('renders ErrorBoundary wrapper', async () => {
    renderApp();
    // ErrorBoundary is structural; verify the app renders its content without error
    await waitFor(() => {
      const elements = screen.getAllByText('TORQUE');
      expect(elements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders keyboard shortcut hint', async () => {
    renderApp();
    await waitFor(() => {
      // The shortcut hint contains a kbd with "?" — search by the kbd content
      const kbds = document.querySelectorAll('kbd');
      const questionMark = Array.from(kbds).find(el => el.textContent === '?');
      expect(questionMark).toBeInTheDocument();
    });
  });

  it('renders sidebar collapse toggle button', async () => {
    renderApp();
    await waitFor(() => {
      const collapseBtn = screen.getByLabelText(/sidebar/i);
      expect(collapseBtn).toBeInTheDocument();
    });
  });

  it('renders Task Orchestration subtitle', async () => {
    renderApp();
    await waitFor(() => {
      expect(screen.getByText('Task Orchestration')).toBeInTheDocument();
    });
  });

  it('does not show TaskDetailDrawer when no task is selected', async () => {
    renderApp();
    await waitFor(() => {
      // The drawer has role="dialog" -- it should not be present
      const dialog = document.querySelector('[role="dialog"]');
      expect(dialog).toBeFalsy();
    });
  });

  it('renders Kanban stat cards on default route', async () => {
    renderApp('/');
    await waitFor(() => {
      expect(screen.getByText('Today')).toBeInTheDocument();
      // Kanban columns
      expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Running').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('applies live task deltas from tasks:batch-updated', async () => {
    const { unmount } = renderApp('/');

    await waitFor(() => {
      expect(screen.getByLabelText('Notifications: no alerts')).toBeInTheDocument();
    });

    emitWsMessage({
      event: 'task:created',
      data: {
        id: 'task-1',
        status: 'running',
        task_description: 'Live task',
        created_at: '2026-01-15T00:00:00Z',
        started_at: '2026-01-15T00:01:00Z',
      },
    });

    await waitFor(() => {
      expect(document.title).toBe('TORQUE (1 running)');
    });

    emitWsMessage({
      event: 'tasks:batch-updated',
      data: [{ id: 'task-1', status: 'failed' }],
    });

    await waitFor(() => {
      expect(document.title).toBe('TORQUE (1 failed)');
      expect(screen.getByLabelText('Notifications: 1 alert (1 failed, 0 stuck)')).toBeInTheDocument();
    });

    unmount();
  });

  it('handles task:event lifecycle messages from the live server contract', async () => {
    const { unmount } = renderApp('/');

    await waitFor(() => {
      expect(screen.getByLabelText('Notifications: no alerts')).toBeInTheDocument();
    });

    emitWsMessage({
      event: 'task:created',
      data: {
        id: 'task-2',
        status: 'running',
        task_description: 'Lifecycle task',
        created_at: '2026-01-15T00:00:00Z',
        started_at: '2026-01-15T00:01:00Z',
      },
    });

    await waitFor(() => {
      expect(document.title).toBe('TORQUE (1 running)');
    });

    emitWsMessage({
      event: 'task:event',
      data: {
        taskId: 'task-2',
        status: 'failed',
        exitCode: 1,
        provider: 'codex',
      },
    });

    await waitFor(() => {
      expect(document.title).toBe('TORQUE (1 failed)');
      expect(screen.getByLabelText('Notifications: 1 alert (1 failed, 0 stuck)')).toBeInTheDocument();
    });

    unmount();
  });

  it('creates and clears one host activity polling interval for each mount cycle', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      const intervalIds = [];
      for (let cycle = 0; cycle < 3; cycle += 1) {
        const { unmount } = renderApp('/');

        act(() => {
          vi.advanceTimersByTime(0);
        });

        const intervalId = getLatestIntervalId(setIntervalSpy, 60000);
        expect(intervalId).toBeTruthy();

        intervalIds.push(intervalId);

        unmount();

        expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      }

      expect(new Set(intervalIds).size).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not create an additional polling interval on rerender', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    try {
      const { rerender, unmount } = renderApp('/');

      act(() => {
        vi.advanceTimersByTime(0);
      });

      const initialPollingCalls = setIntervalSpy.mock.calls.filter((call) => call[1] === 60000).length;
      rerender(<App />);

      expect(setIntervalSpy.mock.calls.filter((call) => call[1] === 60000).length).toBe(initialPollingCalls);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('continues host activity polling after errors and still clears interval on unmount', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    hostsApi.activity.mockRejectedValue(new Error('network down'));

    try {
      const { unmount } = renderApp('/');
      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(hostsApi.activity).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(120000);
      });

      expect(hostsApi.activity).toHaveBeenCalledTimes(3);

      const intervalId = getLatestIntervalId(setIntervalSpy, 60000);
      expect(intervalId).toBeTruthy();

      unmount();

      expect(clearIntervalSpy).toHaveBeenCalledWith(intervalId);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a pending host activity request when App unmounts', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    let requestSignal;
    hostsApi.activity.mockImplementation((options = {}) => {
      requestSignal = options.signal;
      return new Promise(() => {});
    });

    try {
      const { unmount } = renderApp('/');
      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(requestSignal).toBeInstanceOf(AbortSignal);

      unmount();

      expect(requestSignal?.aborted).toBe(true);
      expect(clearIntervalSpy).toHaveBeenCalledWith(getLatestIntervalId(setIntervalSpy, 60000));
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops host activity polling immediately after unmount', async () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(global, 'setInterval');
    const clearIntervalSpy = vi.spyOn(global, 'clearInterval');

    try {
      const { unmount } = renderApp('/');
      act(() => {
        vi.advanceTimersByTime(0);
      });

      expect(hostsApi.activity).toHaveBeenCalledTimes(1);

      act(() => {
        vi.advanceTimersByTime(60000);
      });
      expect(hostsApi.activity).toHaveBeenCalledTimes(2);

      unmount();

      const callsAfterUnmount = hostsApi.activity.mock.calls.length;
      expect(clearIntervalSpy).toHaveBeenCalledWith(getLatestIntervalId(setIntervalSpy, 60000));
      act(() => {
        vi.advanceTimersByTime(120000);
      });

      expect(hostsApi.activity).toHaveBeenCalledTimes(callsAfterUnmount);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
