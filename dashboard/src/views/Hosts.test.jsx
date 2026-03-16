import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Hosts from './Hosts';

vi.mock('../api', () => ({
  hosts: {
    list: vi.fn(),
    scan: vi.fn(),
    toggle: vi.fn(),
  },
  peekHosts: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    toggle: vi.fn(),
    remove: vi.fn(),
    test: vi.fn().mockResolvedValue({ reachable: true, latency_ms: 42 }),
    credentials: vi.fn().mockResolvedValue([]),
    saveCredential: vi.fn(),
    deleteCredential: vi.fn(),
  },
}));

vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '2 minutes ago'),
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { hosts as hostsApi } from '../api';

const mockHosts = [
  {
    id: 'host-1',
    name: 'local-gpu',
    url: 'http://localhost:11434',
    status: 'healthy',
    enabled: true,
    running_tasks: 1,
    max_concurrent: 3,
    response_time_ms: 45,
    models: JSON.stringify(['gemma3:4b', 'qwen3:8b', 'llama3:8b']),
    last_health_check: '2026-01-15T10:00:00Z',
    created_at: '2025-12-01T00:00:00Z',
  },
  {
    id: 'host-2',
    name: 'remote-gpu-host',
    url: 'http://192.168.1.100:11434',
    status: 'down',
    enabled: true,
    running_tasks: 0,
    max_concurrent: 2,
    response_time_ms: null,
    models: JSON.stringify(['qwen2.5-coder:32b', 'codestral:22b']),
    last_health_check: '2026-01-15T09:50:00Z',
    created_at: '2025-12-01T00:00:00Z',
  },
];

describe('Hosts', () => {
  beforeEach(() => {
    hostsApi.list.mockResolvedValue(mockHosts);
    hostsApi.scan.mockResolvedValue({ hosts_found: 2 });
    hostsApi.toggle.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    hostsApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Hosts />, { route: '/hosts' });
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders hosts heading after loading', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Hosts')).toBeTruthy();
    });
  });

  it('displays host names', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('local-gpu')).toBeTruthy();
      expect(screen.getByText('remote-gpu-host')).toBeTruthy();
    });
  });

  it('shows healthy/down status badges', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Healthy')).toBeTruthy();
      expect(screen.getByText('Down')).toBeTruthy();
    });
  });

  it('shows healthy count in subtitle', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText(/1 healthy/)).toBeTruthy();
    });
  });

  it('displays host URLs', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('http://localhost:11434')).toBeTruthy();
      expect(screen.getByText('http://192.168.1.100:11434')).toBeTruthy();
    });
  });

  it('shows model count in stats', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      // Models label appears for each host
      const modelsLabels = screen.getAllByText('Models');
      expect(modelsLabels.length).toBe(2);
    });
  });

  it('shows running tasks count', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      const runningLabels = screen.getAllByText('Running');
      expect(runningLabels.length).toBe(2);
    });
  });

  it('renders Scan Network button', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Scan Network')).toBeTruthy();
    });
  });

  it('renders Refresh button', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeTruthy();
    });
  });

  it('shows empty state when no hosts', async () => {
    hostsApi.list.mockResolvedValue([]);
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('No hosts configured')).toBeTruthy();
    });
  });

  it('displays available models section', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      const sections = screen.getAllByText('Available Models');
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });
  });
});
