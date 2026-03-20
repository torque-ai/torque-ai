import { fireEvent, screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Workstations from './Workstations';

vi.mock('../api', () => ({
  concurrency: {
    get: vi.fn(),
  },
  workstations: {
    list: vi.fn(),
    probe: vi.fn(),
    remove: vi.fn(),
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

import { concurrency, workstations as workstationsApi } from '../api';

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
      ui_capture: { detected: true },
    },
    models: ['qwen3:8b', 'codellama:13b'],
    last_health_check: '2026-03-17T10:00:00Z',
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

describe('Workstations', () => {
  beforeEach(() => {
    concurrency.get.mockResolvedValue(mockConcurrency);
    workstationsApi.list.mockResolvedValue(mockWorkstations);
    workstationsApi.probe.mockResolvedValue({});
    workstationsApi.remove.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders heading and workstation details', async () => {
    renderWithProviders(<Workstations />, { route: '/workstations' });

    await waitFor(() => {
      expect(screen.getByText('Workstations')).toBeInTheDocument();
      expect(screen.getByText('builder-01')).toBeInTheDocument();
      expect(screen.getByText('10.0.0.12:3460')).toBeInTheDocument();
      expect(screen.getByText('Healthy')).toBeInTheDocument();
      expect(screen.getAllByText('RTX 4090').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('command exec')).toBeInTheDocument();
      expect(screen.getByText('ui capture')).toBeInTheDocument();
    });
  });

  it('probes a workstation from the card action', async () => {
    renderWithProviders(<Workstations />, { route: '/workstations' });

    await waitFor(() => {
      expect(screen.getByText('builder-01')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Probe'));

    await waitFor(() => {
      expect(workstationsApi.probe).toHaveBeenCalledWith('builder-01');
    });
  });

  it('confirms removal before deleting a workstation', async () => {
    renderWithProviders(<Workstations />, { route: '/workstations' });

    await waitFor(() => {
      expect(screen.getByText('builder-01')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText('Remove')[0]);

    await waitFor(() => {
      expect(screen.getByText('Remove Workstation')).toBeInTheDocument();
    });

    fireEvent.click(screen.getAllByText('Remove')[1]);

    await waitFor(() => {
      expect(workstationsApi.remove).toHaveBeenCalledWith('builder-01');
    });
  });
});
