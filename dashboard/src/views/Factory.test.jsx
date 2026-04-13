import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Factory from './Factory';
import Overview from './factory/Overview';

vi.mock('./factory/useFactoryShell', () => ({
  useFactoryShell: vi.fn(),
}));

import { useFactoryShell } from './factory/useFactoryShell';

const approveGate = vi.fn();
const handlePauseAll = vi.fn();
const handleToggleProject = vi.fn();
const loadProjects = vi.fn();
const refreshSelectedProject = vi.fn();
const setSelectedProjectId = vi.fn();
const startLoop = vi.fn();
const advanceLoop = vi.fn();

const factoryProject = {
  id: 'factory-1',
  name: 'torque-public',
  path: 'C:\\Users\\<os-user>\\Projects\\torque-public',
  status: 'running',
  trust_level: 'guided',
  scores: { structural: 82, documentation: 64 },
  balance: 3.8,
  weakest_dimension: { dimension: 'documentation', score: 64 },
  loop_state: 'PAUSED',
  loop_paused_at_stage: 'VERIFY',
  loop_last_action_at: '2026-04-13T12:00:00Z',
};

function renderFactory() {
  return render(
    <MemoryRouter initialEntries={['/factory']}>
      <Routes>
        <Route path="/factory" element={<Factory />}>
          <Route index element={<Overview />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

describe('Factory overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useFactoryShell.mockReturnValue({
      activeProjectAction: null,
      handlePauseAll,
      handleToggleProject,
      loadProjects,
      loading: false,
      outletContext: {
        activeProjectAction: null,
        approvalsHref: '/approvals?project=torque-public&source=factory',
        architectBacklog: { items: [], cycleId: null, reasoningSummary: null },
        architectLoading: false,
        backlogLoading: false,
        costMetrics: null,
        costMetricsLoading: false,
        decisionFilters: { stage: '', actor: '', batchId: '', since: '' },
        decisionLoading: false,
        decisionLog: [],
        decisionStats: null,
        detail: {
          project: factoryProject,
          scores: factoryProject.scores,
          balance: factoryProject.balance,
          weakest_dimension: factoryProject.weakest_dimension,
        },
        detailLoading: false,
        digest: null,
        handleRejectWorkItem: vi.fn(),
        handleRerunArchitect: vi.fn(),
        handleToggleProject,
        intakeItems: [],
        intakeLoading: false,
        loopAdvanceJob: null,
        loopActionBusy: null,
        loopRefreshAgeSeconds: 0,
        loopStatus: {
          loop_state: 'PAUSED',
          loop_paused_at_stage: 'VERIFY',
          loop_last_action_at: '2026-04-13T12:00:00Z',
        },
        pendingApprovalCount: 2,
        recentActivity: [],
        recentActivityHydrated: true,
        refreshSelectedProject,
        rejectingItemId: null,
        selectedHealth: null,
        selectedProject: factoryProject,
        selectedProjectId: factoryProject.id,
        setDecisionFilters: vi.fn(),
        setSelectedProjectId,
        startLoop,
        approveGate,
        advanceLoop,
        projects: [factoryProject],
      },
      pauseAllBusy: false,
      pausedProjects: 0,
      projectActivity: {},
      projects: [factoryProject],
      projectsError: null,
      runningProjects: 1,
      setSelectedProjectId,
      totalProjects: 1,
    });
  });

  it('renders the shared loop control bar on the factory overview', () => {
    renderFactory();

    expect(screen.getByText('Factory Loop')).toBeInTheDocument();
    expect(screen.getByLabelText('Factory project')).toHaveValue('factory-1');
    expect(screen.getByText('PAUSED · VERIFY')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 tasks awaiting approval/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve Gate' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Approve Gate' }));

    expect(approveGate).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole('button', { name: 'Pause' }).length).toBeGreaterThanOrEqual(1);
  });
});