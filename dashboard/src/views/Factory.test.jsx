import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Factory from './Factory';
import Overview from './factory/Overview';
import { ToastProvider } from '../components/Toast';

vi.mock('./factory/useFactoryShell', () => ({
  useFactoryShell: vi.fn(),
}));

vi.mock('../api', () => ({
  factory: {
    cycleHistory: vi.fn(),
    listLoopInstances: vi.fn(),
    startLoopInstance: vi.fn(),
    loopInstanceStatus: vi.fn(),
    advanceLoopInstance: vi.fn(),
    loopInstanceJobStatus: vi.fn(),
    approveGateInstance: vi.fn(),
    rejectGateInstance: vi.fn(),
    retryVerifyInstance: vi.fn(),
  },
}));

import { useFactoryShell } from './factory/useFactoryShell';
import { factory as factoryApi } from '../api';

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
    <ToastProvider>
      <MemoryRouter initialEntries={['/factory']}>
        <Routes>
          <Route path="/factory" element={<Factory />}>
            <Route index element={<Overview />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </ToastProvider>
  );
}

describe('Factory overview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryApi.cycleHistory.mockResolvedValue([{
      instance_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
      work_item_id: 42,
      work_item_title: 'Stabilize verify handoff',
      started_at: '2026-04-13T11:00:00Z',
      duration_ms: 420000,
      stage_progression: ['sense', 'prioritize', 'plan', 'execute', 'verify', 'learn'],
      status: 'completed',
    }]);
    factoryApi.listLoopInstances.mockResolvedValue([{
      id: '11111111-1111-4111-8111-111111111111',
      project_id: 'factory-1',
      work_item_id: 42,
      batch_id: 'batch-verify-001',
      loop_state: 'VERIFY',
      paused_at_stage: 'VERIFY',
      last_action_at: '2026-04-13T12:00:00Z',
    }]);
    factoryApi.startLoopInstance.mockResolvedValue({});
    factoryApi.loopInstanceStatus.mockResolvedValue({});
    factoryApi.advanceLoopInstance.mockResolvedValue({ job_id: 'job-1', status: 'running' });
    factoryApi.loopInstanceJobStatus.mockResolvedValue({ status: 'running' });
    factoryApi.approveGateInstance.mockResolvedValue({});
    factoryApi.rejectGateInstance.mockResolvedValue({});
    factoryApi.retryVerifyInstance.mockResolvedValue({});
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

  it('renders the shared loop control bar on the factory overview', async () => {
    const { findByRole, findByText } = renderFactory();

    // LoopControlBar loads instances via an async effect; wait for render.
    await findByText('Factory Loop');
    await vi.waitFor(() => {
      expect(factoryApi.cycleHistory).toHaveBeenCalledWith('factory-1');
    });
    expect(screen.getByLabelText('Factory project')).toHaveValue('factory-1');
    // VERIFY appears both as a state badge and a dt/dd row in the instance card.
    await vi.waitFor(() => {
      expect(screen.getAllByText('VERIFY').length).toBeGreaterThan(0);
    });
    expect(screen.getByText('Cycle History')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 tasks awaiting approval/i })).toBeInTheDocument();
    const approveBtn = await findByRole('button', { name: 'Approve Gate' });

    fireEvent.click(approveBtn);

    // Handler is async; wait for the API call to land.
    await vi.waitFor(() => {
      expect(factoryApi.approveGateInstance).toHaveBeenCalledWith('11111111-1111-4111-8111-111111111111', 'VERIFY');
    });
    expect(screen.getAllByRole('button', { name: 'Pause' }).length).toBeGreaterThanOrEqual(1);
  });

  it('renders keyed factory alert badges and ignores unkeyed alert payloads', () => {
    const baseShell = useFactoryShell();
    const alertProjects = [
      {
        ...factoryProject,
        id: 'verify-alert',
        name: 'Verify Alert',
        alert_badge: {
          alert_type: 'VERIFY_FAIL_STREAK',
          alert_key: 'VERIFY_FAIL_STREAK|project:verify-alert',
          active: true,
        },
      },
      {
        ...factoryProject,
        id: 'stalled-alert',
        name: 'Stalled Alert',
        alert_badge: {
          alert_type: 'FACTORY_STALLED',
          alert_key: 'FACTORY_STALLED|project:stalled-alert',
          active: true,
        },
      },
      {
        ...factoryProject,
        id: 'idle-alert',
        name: 'Idle Alert',
        alert_badge: {
          alert_type: 'FACTORY_IDLE',
          alert_key: 'FACTORY_IDLE|project:idle-alert',
          active: true,
        },
      },
      {
        ...factoryProject,
        id: 'unkeyed-alert',
        name: 'Unkeyed Alert',
        alert_badge: {
          alert_type: 'FACTORY_IDLE',
          active: true,
        },
      },
    ];

    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        detail: {
          ...baseShell.outletContext.detail,
          project: alertProjects[0],
        },
        projects: alertProjects,
        selectedProject: alertProjects[0],
        selectedProjectId: alertProjects[0].id,
      },
      projects: alertProjects,
      runningProjects: alertProjects.length,
      totalProjects: alertProjects.length,
    });

    renderFactory();

    expect(screen.getByLabelText('Factory alert: Verify failures')).toBeInTheDocument();
    expect(screen.getByLabelText('Factory alert: Factory stalled')).toBeInTheDocument();
    expect(screen.getByLabelText('Factory alert: Factory idle')).toBeInTheDocument();
    // Each project name renders twice — once in the ProjectCard title, once
    // in the Active-loops summary list (Overview.jsx:269). Assert the project
    // card exists without caring which list rendered it.
    expect(screen.getAllByText('Unkeyed Alert').length).toBeGreaterThan(0);
    // 'Factory idle' should only appear once: as the badge label on the
    // keyed idle-alert project. The unkeyed-alert project (alert_type
    // 'FACTORY_IDLE' with no alert_key) must render no badge, so its
    // FACTORY_IDLE label does not leak into the document.
    expect(screen.getAllByText('Factory idle')).toHaveLength(1);
  });

  it('surfaces STARVED projects in the project grid', () => {
    const baseShell = useFactoryShell();
    const starvedProject = {
      ...factoryProject,
      id: 'starved-project',
      name: 'Starved Project',
      loop_state: 'STARVED',
      loop_paused_at_stage: null,
      consecutive_empty_cycles: 4,
    };

    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        detail: {
          ...baseShell.outletContext.detail,
          project: starvedProject,
        },
        projects: [starvedProject],
        selectedProject: starvedProject,
        selectedProjectId: starvedProject.id,
      },
      projects: [starvedProject],
      totalProjects: 1,
    });

    renderFactory();

    expect(screen.getByRole('status', { name: /starved project factory loop starved/i })).toBeInTheDocument();
    expect(screen.getByText(/4 empty cycles/i)).toBeInTheDocument();
  });
});
