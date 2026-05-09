import { renderHook, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../../components/Toast';
import { factory as factoryApi, getDecisionLog, getFactoryDigest } from '../../api';
import { useFactoryLoopControl } from './useFactoryLoopControl';
import { useFactoryShell } from './useFactoryShell';

vi.mock('../../api', () => ({
  factory: {
    backlog: vi.fn(),
    factoryCosts: vi.fn(),
    health: vi.fn(),
    intake: vi.fn(),
    pause: vi.fn(),
    pauseAll: vi.fn(),
    rejectWorkItem: vi.fn(),
    resume: vi.fn(),
    triggerArchitect: vi.fn(),
  },
  getDecisionLog: vi.fn(),
  getFactoryDigest: vi.fn(),
}));

vi.mock('./useFactoryLoopControl', () => ({
  useFactoryLoopControl: vi.fn(),
}));

const project = {
  id: 'project-1',
  name: 'SpudgetBooks',
  path: 'C:/Projects/SpudgetBooks',
  status: 'running',
  trust_level: 'dark',
  loop_state: 'EXECUTE',
};

function wrapperForRoute(route) {
  return function Wrapper({ children }) {
    return (
      <ToastProvider>
        <MemoryRouter initialEntries={[route]}>
          {children}
        </MemoryRouter>
      </ToastProvider>
    );
  };
}

describe('useFactoryShell route-gated loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFactoryLoopControl.mockReturnValue({
      activeProjectAction: null,
      approvalsHref: null,
      approveGate: vi.fn(),
      advanceLoop: vi.fn(),
      handleToggleProject: vi.fn(),
      loadProjects: vi.fn(),
      loading: false,
      loopActionBusy: null,
      loopAdvanceJob: null,
      loopRefreshAgeSeconds: 0,
      loopStatus: { loop_state: 'EXECUTE' },
      pendingApprovalCount: 0,
      projects: [project],
      projectsError: null,
      refreshSelectedProject: vi.fn(),
      selectedProject: project,
      selectedProjectId: project.id,
      setSelectedProjectId: vi.fn(),
      startLoop: vi.fn(),
    });
    factoryApi.backlog.mockResolvedValue({ items: [] });
    factoryApi.factoryCosts.mockResolvedValue({
      cost_per_cycle: 0,
      cost_per_health_point: 0,
      provider_efficiency: [],
    });
    factoryApi.health.mockResolvedValue({ project, scores: {}, balance: 0 });
    factoryApi.intake.mockResolvedValue({ items: [] });
    getDecisionLog.mockResolvedValue({ decisions: [], stats: { total: 0 } });
    getFactoryDigest.mockResolvedValue({ events: [] });
  });

  it('keeps overview decision polling lightweight and skips policy cost metrics', async () => {
    renderHook(() => useFactoryShell(), { wrapper: wrapperForRoute('/factory') });

    await waitFor(() => expect(factoryApi.health).toHaveBeenCalledWith(project.id));
    await waitFor(() => expect(getDecisionLog).toHaveBeenCalledTimes(3));

    expect(factoryApi.factoryCosts).not.toHaveBeenCalled();
    expect(getDecisionLog.mock.calls.every(([, params]) => params.include_stats === false)).toBe(true);
  });

  it('loads audit decisions with stats only on the Activity route', async () => {
    renderHook(() => useFactoryShell(), { wrapper: wrapperForRoute('/factory/activity') });

    await waitFor(() => expect(getDecisionLog).toHaveBeenCalledWith(project.id, { limit: 100 }));
  });

  it('loads cost metrics only on the Policy route', async () => {
    renderHook(() => useFactoryShell(), { wrapper: wrapperForRoute('/factory/policy') });

    await waitFor(() => expect(factoryApi.factoryCosts).toHaveBeenCalledWith(project.id));
  });
});
