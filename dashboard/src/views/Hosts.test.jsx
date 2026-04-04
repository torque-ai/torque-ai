import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Hosts from './Hosts';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  concurrency: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue({}),
  },
  hosts: {
    list: vi.fn(),
    scan: vi.fn(),
    toggle: vi.fn(),
    remove: vi.fn(),
  },
  workstations: {
    list: vi.fn(),
    add: vi.fn().mockResolvedValue({}),
    toggle: vi.fn().mockResolvedValue({}),
    probe: vi.fn(),
    remove: vi.fn(),
  },
  models: {
    list: vi.fn().mockResolvedValue({ items: [] }),
    pending: vi.fn().mockResolvedValue([]),
    approve: vi.fn(),
    deny: vi.fn(),
    bulkApprove: vi.fn(),
  },
  peekHosts: {
    list: vi.fn().mockResolvedValue([]),
    create: vi.fn(),
    update: vi.fn(),
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
  format: vi.fn(() => 'Jan 15, 2026 10:00:00'),
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { concurrency, hosts as hostsApi, peekHosts as peekHostsApi, workstations as workstationsApi } from '../api';

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
    url: 'http://192.0.2.100:11434',
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

const mockWorkstations = [
  {
    id: 'ws-1',
    name: 'builder-01',
    host: '10.0.0.12',
    agent_port: 3460,
    status: 'healthy',
    gpu_name: 'RTX 4090',
    gpu_vram_mb: 24576,
    _capabilities: {
      command_exec: { detected: true },
      ollama: { detected: true },
      gpu: { detected: true, name: 'RTX 4090', vram_mb: 24576 },
      ui_capture: { detected: true, peek_server: 'running' },
    },
    models: ['qwen3:8b', 'codellama:13b'],
    last_health_check: '2026-03-17T10:00:00Z',
    enabled: 1,
  },
];

const mockConcurrency = {
  vram_overhead_factor: 0.95,
  workstations: [
    {
      name: 'builder-01',
      host: '10.0.0.12',
      running_tasks: 2,
      max_concurrent: 4,
      gpu_vram_mb: 24576,
      effective_vram_budget_mb: 23347,
    },
  ],
};

describe('Hosts', () => {
  beforeEach(() => {
    concurrency.get.mockResolvedValue(mockConcurrency);
    hostsApi.list.mockResolvedValue(mockHosts);
    hostsApi.scan.mockResolvedValue({ hosts_found: 2 });
    hostsApi.toggle.mockResolvedValue({});
    hostsApi.remove.mockResolvedValue({});
    workstationsApi.list.mockResolvedValue(mockWorkstations);
    workstationsApi.toggle.mockResolvedValue({});
    workstationsApi.probe.mockResolvedValue({});
    workstationsApi.remove.mockResolvedValue({});
    peekHostsApi.list.mockResolvedValue([]);
    peekHostsApi.create.mockResolvedValue({});
    peekHostsApi.update.mockResolvedValue({});
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      headers: {
        get: vi.fn(() => 'application/json'),
      },
      json: vi.fn().mockResolvedValue({ data: { name: 'builder-02' } }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    hostsApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Hosts />, { route: '/hosts' });
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders hosts heading after loading', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Hosts')).toBeInTheDocument();
    });
  });

  it('displays host names', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('builder-01')).toBeInTheDocument();
      expect(screen.getByText('local-gpu')).toBeInTheDocument();
      expect(screen.getByText('remote-gpu-host')).toBeInTheDocument();
    });
  });

  it('shows healthy/down status badges', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getAllByText('Healthy').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Down').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows healthy count in subtitle', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('1 healthy ollama hosts, 1 healthy workstations')).toBeInTheDocument();
    });
  });

  it('displays host URLs', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('http://localhost:11434')).toBeInTheDocument();
      expect(screen.getByText('http://192.0.2.100:11434')).toBeInTheDocument();
    });
  });

  it('shows model count in stats', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      const modelsLabels = screen.getAllByText('Models');
      expect(modelsLabels.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('shows running tasks count', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      const runningLabels = screen.getAllByText('Running');
      expect(runningLabels.length).toBeGreaterThanOrEqual(3);
    });
  });

  it('renders Scan Network button', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Scan Network')).toBeInTheDocument();
    });
  });

  it('renders Refresh button', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('Refresh')).toBeInTheDocument();
    });
  });

  it('shows empty state when no hosts', async () => {
    hostsApi.list.mockResolvedValue([]);
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      expect(screen.getByText('No hosts configured')).toBeInTheDocument();
    });
  });

  it('displays available models section', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });
    await waitFor(() => {
      const sections = screen.getAllByText('Available Models');
      expect(sections.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('probes a workstation from the unified hosts page', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });

    await waitFor(() => {
      expect(screen.getByText('builder-01')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Probe'));

    await waitFor(() => {
      expect(workstationsApi.probe).toHaveBeenCalledWith('builder-01');
    });
  });

  it('toggles a workstation from the unified hosts page', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });

    await waitFor(() => {
      expect(screen.getByText('builder-01')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTitle('Disable workstation'));

    await waitFor(() => {
      expect(workstationsApi.toggle).toHaveBeenCalledWith('builder-01', false);
    });
  });

  it('renders workstation peek controls and connects peek with the generated url', async () => {
    renderWithProviders(<Hosts />, { route: '/hosts' });

    await waitFor(() => {
      expect(screen.getByText('Peek Server')).toBeInTheDocument();
    });

    expect(screen.getByText('Not connected')).toBeInTheDocument();
    expect(screen.queryByText('Remote Testing Hosts')).toBeNull();

    fireEvent.click(screen.getByText('Connect Peek'));

    await waitFor(() => {
      expect(peekHostsApi.create).toHaveBeenCalledWith(expect.objectContaining({
        name: 'builder-01',
        url: 'http://10.0.0.12:9876',
      }));
    });
  });

  it('adds a workstation from the inline form', async () => {
    workstationsApi.list.mockResolvedValue([]);
    renderWithProviders(<Hosts />, { route: '/hosts' });

    await waitFor(() => {
      expect(screen.getByText('Add Workstation')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Add Workstation'));
    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    fireEvent.change(screen.getByLabelText('Name *'), { target: { value: 'builder-02' } });
    fireEvent.change(screen.getByLabelText('Host *'), { target: { value: '10.0.0.22' } });
    fireEvent.change(screen.getByLabelText('Port *'), { target: { value: '3461' } });
    fireEvent.change(screen.getByLabelText('Secret *'), { target: { value: 'super-secret' } });

    fireEvent.click(screen.getByRole('button', { name: 'Add Workstation' }));

    await waitFor(() => {
      expect(workstationsApi.add).toHaveBeenCalledWith({
        name: 'builder-02',
        host: '10.0.0.22',
        agent_port: 3461,
        secret: 'super-secret',
      });
    });

    expect(workstationsApi.list.mock.calls.length).toBeGreaterThan(1);
    expect(workstationsApi.probe).toHaveBeenCalledWith('builder-02');
  });
});