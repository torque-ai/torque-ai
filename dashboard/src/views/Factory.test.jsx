import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Factory from './Factory';
import Activity from './factory/Activity';
import Health from './factory/Health';
import Intake from './factory/Intake';
import Overview from './factory/Overview';
import Policy from './factory/Policy';
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
    driftStatus: vi.fn(),
    getPolicy: vi.fn(),
    setPolicy: vi.fn(),
    guardrailStatus: vi.fn(),
    guardrailEvents: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
}));

import { useFactoryShell } from './factory/useFactoryShell';
import { factory as factoryApi, providers as providersApi } from '../api';

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

function renderFactory(initialEntry = '/factory') {
  return render(
    <ToastProvider>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/factory" element={<Factory />}>
            <Route index element={<Overview />} />
            <Route path="intake" element={<Intake />} />
            <Route path="health" element={<Health />} />
            <Route path="activity" element={<Activity />} />
            <Route path="policy" element={<Policy />} />
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
    factoryApi.driftStatus.mockResolvedValue({ drift_detected: false, message: 'No drift detected.' });
    factoryApi.getPolicy.mockResolvedValue({
      policy: {
        budget_ceiling: null,
        blast_radius_percent: 25,
        scope_ceiling: { max_tasks: 20, max_files_per_task: 10 },
        restricted_paths: [],
        required_checks: [],
        escalation_rules: {
          security_findings: true,
          breaking_changes: true,
          health_drop_threshold: 10,
          budget_warning_percent: 80,
        },
        provider_restrictions: [],
        work_hours: null,
      },
    });
    factoryApi.setPolicy.mockResolvedValue({});
    factoryApi.guardrailStatus.mockResolvedValue({ status_map: {} });
    factoryApi.guardrailEvents.mockResolvedValue({ events: [] });
    providersApi.list.mockResolvedValue([]);
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
        backlogError: '',
        backlogLoading: false,
        costMetrics: null,
        costMetricsError: '',
        costMetricsLoading: false,
        decisionFilters: { stage: '', actor: '', batchId: '', since: '' },
        decisionLogError: '',
        decisionLoading: false,
        decisionLog: [],
        decisionStats: null,
        detail: {
          project: factoryProject,
          scores: factoryProject.scores,
          balance: factoryProject.balance,
          weakest_dimension: factoryProject.weakest_dimension,
        },
        detailError: '',
        detailLoading: false,
        digest: null,
        handleRejectWorkItem: vi.fn(),
        handleRerunArchitect: vi.fn(),
        handleToggleProject,
        intakeItems: [],
        intakeError: '',
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

  it('shows a retryable project health error on the overview', () => {
    const baseShell = useFactoryShell();
    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        detailError: 'Health endpoint timed out',
      },
    });

    renderFactory();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Project health failed to refresh');
    expect(alert).toHaveTextContent('Health endpoint timed out');

    fireEvent.click(screen.getByRole('button', { name: /retry project health/i }));

    expect(refreshSelectedProject).toHaveBeenCalledTimes(1);
  });

  it('shows intake and backlog errors without hiding stale rows', () => {
    const baseShell = useFactoryShell();
    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        architectBacklog: {
          cycleId: 'cycle-stale',
          reasoningSummary: null,
          items: [{
            priority_rank: 1,
            title: 'Stale backlog candidate',
            why: 'Existing architect output remains useful.',
            scope_budget: 'small',
            expected_impact: { structural: 2 },
          }],
        },
        backlogError: 'Backlog service unavailable',
        intakeError: 'Intake queue unavailable',
        intakeItems: [{
          id: 77,
          title: 'Stale intake item',
          description: 'Previously loaded work item',
          displaySource: 'manual',
          displayStatus: 'pending',
          priority: 'high',
          created_at: '2026-04-13T12:00:00Z',
        }],
      },
    });

    renderFactory('/factory/intake');

    const alerts = screen.getAllByRole('alert');
    expect(alerts[0]).toHaveTextContent('Intake queue failed to refresh');
    expect(alerts[1]).toHaveTextContent('Architect backlog failed to refresh');
    expect(screen.getByText('Stale intake item')).toBeInTheDocument();
    expect(screen.getByText('Stale backlog candidate')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry intake/i }));

    expect(refreshSelectedProject).toHaveBeenCalledTimes(1);
  });

  it('shows audit trail errors without hiding stale decisions', () => {
    const baseShell = useFactoryShell();
    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        decisionLog: [{
          id: 'decision-stale',
          stage: 'verify',
          actor: 'factory',
          action: 'Approved stale result',
          confidence: 0.83,
          reasoning: 'Decision loaded before the failing refresh.',
          created_at: '2026-04-13T12:00:00Z',
        }],
        decisionLogError: 'Decision log service unavailable',
      },
    });

    renderFactory('/factory/activity');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Audit trail failed to refresh');
    expect(alert).toHaveTextContent('Decision log service unavailable');
    expect(screen.getByText('Approved stale result')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry audit trail/i }));

    expect(refreshSelectedProject).toHaveBeenCalledTimes(1);
  });

  it('shows cost metric errors without hiding stale provider metrics', () => {
    const baseShell = useFactoryShell();
    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        costMetrics: {
          cost_per_cycle: 1.23,
          cost_per_health_point: 0.45,
          provider_efficiency: [{
            provider: 'codex',
            cost_per_task: 0.42,
            task_count: 2,
            total_cost: 0.84,
          }],
        },
        costMetricsError: 'Cost metrics service unavailable',
      },
    });

    renderFactory('/factory/policy');

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Cost metrics failed to refresh');
    expect(alert).toHaveTextContent('Cost metrics service unavailable');
    expect(screen.getByText(/2 tasks/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /retry cost metrics/i }));

    expect(refreshSelectedProject).toHaveBeenCalledTimes(1);
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

    // Selected project's full badge renders inside the right-pane
    // ProjectCard. verify-alert is alertProjects[0] = the selected one.
    expect(screen.getByLabelText('Factory alert: Verify failures')).toBeInTheDocument();

    // Other keyed alerts surface as small dot indicators in their
    // ProjectListRow with the alert label as aria-label.
    expect(screen.getByLabelText('Factory stalled')).toBeInTheDocument();
    expect(screen.getByLabelText('Factory idle')).toBeInTheDocument();

    // Project name renders in the list row (always) and the detail card
    // (selected only). Unkeyed-alert is in the list at minimum.
    expect(screen.getAllByText('Unkeyed Alert').length).toBeGreaterThan(0);

    // The unkeyed FACTORY_IDLE alert (no alert_key) renders neither a
    // badge nor a dot, so 'Factory idle' appears exactly once: as the
    // dot aria-label on the keyed idle-alert project.
    expect(screen.getAllByLabelText('Factory idle')).toHaveLength(1);
  });

  it('shows a placeholder on subtabs when no project is selected', async () => {
    const baseShell = useFactoryShell();

    useFactoryShell.mockReturnValue({
      ...baseShell,
      outletContext: {
        ...baseShell.outletContext,
        detail: null,
        projects: [factoryProject],
        selectedProject: null,
        selectedProjectId: null,
      },
    });

    const IntakeMod = await import('./factory/Intake');
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/factory/intake']}>
          <Routes>
            <Route path="/factory" element={<Factory />}>
              <Route path="intake" element={<IntakeMod.default />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    );

    expect(screen.getByText(/select a project above to view its intake/i)).toBeInTheDocument();
  });

  it('redirects /factory/decisions to /factory/activity', async () => {
    const ActivityMod = await import('./factory/Activity');
    const { Navigate } = await import('react-router-dom');
    render(
      <ToastProvider>
        <MemoryRouter initialEntries={['/factory/decisions']}>
          <Routes>
            <Route path="/factory" element={<Factory />}>
              <Route path="activity" element={<ActivityMod.default />} />
              <Route path="decisions" element={<Navigate to="/factory/activity" replace />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    );

    // Activity renders audit trail heading when a project is selected.
    expect(screen.getByText(/audit trail/i)).toBeInTheDocument();
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
