import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Coordination from './Coordination';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  coordination: {
    getDashboard: vi.fn(),
    listAgents: vi.fn(),
    listRules: vi.fn(),
    listClaims: vi.fn(),
  },
}));

import { coordination as coordinationApi } from '../api';

const mockDashboard = {
  tasks_claimed_24h: 42,
  failovers_24h: 3,
};

const mockAgents = [
  {
    id: 'agent-001-aabbccdd',
    name: 'codex-worker-1',
    status: 'active',
    last_heartbeat: '2026-02-28T12:00:00Z',
    capabilities: ['code-gen', 'test-gen', 'refactor'],
  },
  {
    id: 'agent-002-eeff0011',
    name: 'ollama-worker-1',
    status: 'idle',
    last_heartbeat: '2026-02-28T11:50:00Z',
    capabilities: 'docs,config',
  },
  {
    id: 'agent-003-22334455',
    name: 'offline-worker',
    status: 'offline',
    last_heartbeat: '2026-02-27T08:00:00Z',
    capabilities: null,
  },
];

const mockRules = [
  {
    id: 'rule-1',
    pattern: '*.test.*',
    target_provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    priority: 10,
    enabled: true,
  },
  {
    id: 'rule-2',
    pattern: '*.docs.*',
    target_provider: 'ollama',
    priority: 5,
    enabled: false,
  },
];

const mockClaims = [
  {
    id: 'claim-1',
    task_id: 'task-abc-12345678',
    agent_id: 'codex-worker-1',
    claimed_at: '2026-02-28T12:05:00Z',
    expires_at: '2026-02-28T12:35:00Z',
    status: 'active',
  },
  {
    id: 'claim-2',
    task_id: 'task-def-87654321',
    agent_name: 'ollama-worker-1',
    created_at: '2026-02-28T11:55:00Z',
    expires_at: '2026-02-28T12:25:00Z',
    status: 'expired',
  },
];

describe('Coordination', () => {
  beforeEach(() => {
    coordinationApi.getDashboard.mockResolvedValue(mockDashboard);
    coordinationApi.listAgents.mockResolvedValue({ agents: mockAgents });
    coordinationApi.listRules.mockResolvedValue({ rules: mockRules });
    coordinationApi.listClaims.mockResolvedValue({ claims: mockClaims });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    coordinationApi.getDashboard.mockReturnValue(new Promise(() => {}));
    coordinationApi.listAgents.mockReturnValue(new Promise(() => {}));
    coordinationApi.listRules.mockReturnValue(new Promise(() => {}));
    coordinationApi.listClaims.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Coordination />, { route: '/coordination' });
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders heading after data loads', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
  });

  it('renders subtitle text', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Multi-agent coordination, routing rules, and active claims')).toBeInTheDocument();
    });
  });

  it('displays Active Agents stat card', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Active Agents')).toBeInTheDocument();
    });
  });

  it('displays Tasks Claimed (24h) stat card', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Tasks Claimed (24h)')).toBeInTheDocument();
    });
  });

  it('displays Failovers (24h) stat card', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Failovers (24h)')).toBeInTheDocument();
    });
  });

  it('displays Routing Rules stat card', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Routing Rules')).toBeInTheDocument();
    });
  });

  // --- Agents tab (default) ---

  it('renders agents tab as active by default', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('codex-worker-1')).toBeInTheDocument();
    });
  });

  it('renders agent table headers', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Last Heartbeat')).toBeInTheDocument();
      expect(screen.getByText('Capabilities')).toBeInTheDocument();
    });
  });

  it('displays all agent names', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('codex-worker-1')).toBeInTheDocument();
      expect(screen.getByText('ollama-worker-1')).toBeInTheDocument();
      expect(screen.getByText('offline-worker')).toBeInTheDocument();
    });
  });

  it('displays agent status badges', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('active')).toBeInTheDocument();
      expect(screen.getByText('idle')).toBeInTheDocument();
      expect(screen.getByText('offline')).toBeInTheDocument();
    });
  });

  it('displays capabilities as tags for agents with array capabilities', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('code-gen')).toBeInTheDocument();
      expect(screen.getByText('test-gen')).toBeInTheDocument();
      expect(screen.getByText('refactor')).toBeInTheDocument();
    });
  });

  it('displays capabilities from comma-separated string', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('docs')).toBeInTheDocument();
      expect(screen.getByText('config')).toBeInTheDocument();
    });
  });

  it('shows empty agents state when no agents', async () => {
    coordinationApi.listAgents.mockResolvedValue({ agents: [] });
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('No agents registered')).toBeInTheDocument();
    });
  });

  // --- Tab switching ---

  it('renders all three tab buttons', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('agents')).toBeInTheDocument();
      expect(screen.getByText('rules')).toBeInTheDocument();
      expect(screen.getByText('claims')).toBeInTheDocument();
    });
  });

  // --- Rules tab ---

  it('switches to rules tab on click', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      expect(screen.getByText('Pattern')).toBeInTheDocument();
      expect(screen.getByText('Target Provider')).toBeInTheDocument();
      expect(screen.getByText('Priority')).toBeInTheDocument();
      // "Enabled" appears as both a table header and a badge; use getAllByText
      const enabledElements = screen.getAllByText('Enabled');
      expect(enabledElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays rule patterns in rules tab', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      expect(screen.getByText('*.test.*')).toBeInTheDocument();
      expect(screen.getByText('*.docs.*')).toBeInTheDocument();
    });
  });

  it('displays rule target providers', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.getByText('ollama')).toBeInTheDocument();
    });
  });

  it('shows model name alongside provider when present', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      expect(screen.getByText('(gpt-5.3-codex-spark)')).toBeInTheDocument();
    });
  });

  it('shows Enabled/Disabled badges for rules', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      // "Enabled" appears as both header and badge; check that both exist
      const enabledElements = screen.getAllByText('Enabled');
      expect(enabledElements.length).toBe(2); // header + badge
      expect(screen.getByText('Disabled')).toBeInTheDocument();
    });
  });

  it('shows empty rules state when no rules', async () => {
    coordinationApi.listRules.mockResolvedValue({ rules: [] });
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('rules'));
    await waitFor(() => {
      expect(screen.getByText('No routing rules configured')).toBeInTheDocument();
    });
  });

  // --- Claims tab ---

  it('switches to claims tab on click', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('claims'));
    await waitFor(() => {
      expect(screen.getByText('Task ID')).toBeInTheDocument();
      expect(screen.getByText('Agent')).toBeInTheDocument();
      expect(screen.getByText('Claimed At')).toBeInTheDocument();
      expect(screen.getByText('Expires At')).toBeInTheDocument();
    });
  });

  it('displays claim data in claims tab', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('claims'));
    await waitFor(() => {
      expect(screen.getByText('codex-worker-1')).toBeInTheDocument();
      expect(screen.getByText('ollama-worker-1')).toBeInTheDocument();
    });
  });

  it('shows claim status badges', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('claims'));
    await waitFor(() => {
      // 'active' appears for agent status AND claim status - look for both
      const activeElements = screen.getAllByText('active');
      expect(activeElements.length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('expired')).toBeInTheDocument();
    });
  });

  it('shows truncated task IDs in claims', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('claims'));
    await waitFor(() => {
      // task_id is truncated to first 8 chars: "task-abc" from "task-abc-12345678"
      expect(screen.getByText('task-abc')).toBeInTheDocument();
      expect(screen.getByText('task-def')).toBeInTheDocument();
    });
  });

  it('shows empty claims state when no claims', async () => {
    coordinationApi.listClaims.mockResolvedValue({ claims: [] });
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('Coordination')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('claims'));
    await waitFor(() => {
      expect(screen.getByText('No active claims')).toBeInTheDocument();
    });
  });

  // --- Dashboard data ---

  it('uses dashboard data for tasks claimed count', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      // 42 from mockDashboard.tasks_claimed_24h
      expect(screen.getByText('42')).toBeInTheDocument();
    });
  });

  it('uses dashboard data for failovers count', async () => {
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      // 3 from mockDashboard.failovers_24h
      expect(screen.getByText('3')).toBeInTheDocument();
    });
  });

  it('shows N/A when dashboard has no tasks_claimed_24h', async () => {
    coordinationApi.getDashboard.mockResolvedValue({});
    renderWithProviders(<Coordination />, { route: '/coordination' });
    await waitFor(() => {
      expect(screen.getByText('N/A')).toBeInTheDocument();
    });
  });
});
