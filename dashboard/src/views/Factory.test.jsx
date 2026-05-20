import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    applyAutomationPlan: vi.fn(),
    applyProjectAutomationPlan: vi.fn(),
  },
}));

import { useFactoryShell } from './factory/useFactoryShell';
import { factory as factoryApi } from '../api';

const approveGate = vi.fn();
const handlePauseAll = vi.fn();
const handleSetProjectWorkEnabled = vi.fn();
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('confirm', vi.fn(() => true));
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
    factoryApi.applyAutomationPlan.mockResolvedValue({
      completed: true,
      dry_run: true,
      planned_steps: 0,
      applied_steps: [],
      processes_project_work: false,
    });
    factoryApi.applyProjectAutomationPlan.mockResolvedValue({
      completed: true,
      dry_run: true,
      planned_steps: 0,
      applied_steps: [],
      processes_project_work: false,
    });
    useFactoryShell.mockReturnValue({
      activeProjectAction: null,
      automationReadiness: {
        project_work_enabled: false,
      },
      handlePauseAll,
      handleSetProjectWorkEnabled,
      handleToggleProject,
      idleDiagnosis: null,
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
        idleDiagnosis: null,
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
      projectWorkBusy: false,
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

  it('surfaces global factory idle diagnosis above the project grid', () => {
    const baseShell = useFactoryShell();
    const pausedProject = {
      ...factoryProject,
      status: 'paused',
      loop_state: 'IDLE',
    };

    useFactoryShell.mockReturnValue({
      ...baseShell,
      idleDiagnosis: {
        idle: true,
        reason_code: 'all_projects_paused',
        message: 'All registered factory projects are paused.',
        counts: {
          running_projects: 0,
          paused_projects: 1,
          open_work_items: 0,
          task_queue: {
            total_non_terminal: 0,
          },
        },
      },
      outletContext: {
        ...baseShell.outletContext,
        detail: {
          ...baseShell.outletContext.detail,
          project: pausedProject,
        },
        idleDiagnosis: {
          idle: true,
          reason_code: 'all_projects_paused',
          message: 'All registered factory projects are paused.',
        },
        projects: [pausedProject],
        selectedProject: pausedProject,
        selectedProjectId: pausedProject.id,
      },
      pausedProjects: 1,
      projects: [pausedProject],
      runningProjects: 0,
      totalProjects: 1,
    });

    renderFactory();

    expect(screen.getByRole('status', { name: /factory idle diagnosis/i })).toBeInTheDocument();
    expect(screen.getByText('All projects paused')).toBeInTheDocument();
    expect(screen.getByText('All registered factory projects are paused.')).toBeInTheDocument();
    expect(screen.getByText(/0 running .* 1 paused .* 0 open items .* 0 queued/i)).toBeInTheDocument();
  });

  it('labels the global project-work disabled idle state explicitly', () => {
    const baseShell = useFactoryShell();
    const diagnosis = {
      idle: true,
      reason_code: 'factory_project_work_disabled',
      message: 'Factory project work is globally disabled; armed scheduler ticks will skip registered project work.',
      counts: {
        running_projects: 1,
        paused_projects: 0,
        open_work_items: 3,
        factory_project_work_enabled: 0,
        task_queue: {
          total_non_terminal: 0,
        },
      },
    };

    useFactoryShell.mockReturnValue({
      ...baseShell,
      idleDiagnosis: diagnosis,
      outletContext: {
        ...baseShell.outletContext,
        idleDiagnosis: diagnosis,
      },
    });

    renderFactory();

    expect(screen.getByRole('status', { name: /factory idle diagnosis/i })).toBeInTheDocument();
    expect(screen.getByText('Project work disabled')).toBeInTheDocument();
    expect(screen.getByText(/armed scheduler ticks will skip registered project work/i)).toBeInTheDocument();
    expect(screen.getByText(/1 running .* 0 paused .* 3 open items .* 0 queued/i)).toBeInTheDocument();
  });

  it('exposes a global project-work enable control when parked', () => {
    renderFactory();

    const button = screen.getByRole('button', { name: 'Enable Project Work' });
    fireEvent.click(button);

    expect(handleSetProjectWorkEnabled).toHaveBeenCalledWith(true);
  });

  it('surfaces automation readiness blockers above the project grid', () => {
    const baseShell = useFactoryShell();
    const blockedProject = {
      ...factoryProject,
      automation_readiness: {
        ready: false,
        blocker_codes: ['approval_gates_enabled'],
        next_control_plane_action: 'set_factory_trust_level trust_level=dark',
        control_plane_actions: [
          'set_factory_trust_level trust_level=dark',
          'resume_project',
        ],
      },
      work_item_status_counts: {
        needs_review: 2,
        needs_replan: 5,
      },
    };

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness: {
        ready: false,
        hands_off_ready: false,
        total_projects: 1,
        ready_projects: 0,
        blocked_projects: 1,
        auto_continue_enabled_projects: 0,
        dark_trust_projects: 0,
        blockers: {
          approval_gates_enabled: 1,
        },
        project_ids: {
          ready: [],
          blocked: ['factory-1'],
        },
        control_plane_plan: [
          {
            action: 'set_factory_trust_level trust_level=dark',
            tool: 'set_factory_trust_level',
            args: { project: 'factory-1', trust_level: 'dark' },
            description: 'Remove approval gates by switching to dark trust.',
          },
          {
            action: 'resume_project',
            tool: 'resume_project',
            args: { project: 'factory-1' },
            description: 'Resume the project.',
          },
        ],
      },
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness: {
          ready: false,
          hands_off_ready: false,
          total_projects: 1,
          ready_projects: 0,
          blocked_projects: 1,
          auto_continue_enabled_projects: 0,
          dark_trust_projects: 0,
          blockers: {
            approval_gates_enabled: 1,
          },
          project_ids: {
            ready: [],
            blocked: ['factory-1'],
          },
          control_plane_plan: [
            {
              action: 'set_factory_trust_level trust_level=dark',
              tool: 'set_factory_trust_level',
              args: { project: 'factory-1', trust_level: 'dark' },
              description: 'Remove approval gates by switching to dark trust.',
            },
            {
              action: 'resume_project',
              tool: 'resume_project',
              args: { project: 'factory-1' },
              description: 'Resume the project.',
            },
          ],
        },
        detail: {
          ...baseShell.outletContext.detail,
          project: blockedProject,
        },
        projects: [blockedProject],
        selectedProject: blockedProject,
        selectedProjectId: blockedProject.id,
      },
      projects: [blockedProject],
      totalProjects: 1,
    });

    renderFactory();

    expect(screen.getByRole('status', { name: /factory automation readiness/i })).toBeInTheDocument();
    expect(screen.getByText('1 project blocked')).toBeInTheDocument();
    expect(screen.getByText(/0 control-ready .* 0 auto-continue .* 0 dark trust/i)).toBeInTheDocument();
    expect(screen.getByText('0 tick unarmed · 0 approvals · 2 needs review · 5 needs replan · 0 exhausted')).toBeInTheDocument();
    expect(screen.getByText('Blocked: torque-public')).toBeInTheDocument();
    expect(screen.getByText('approval gates enabled: 1')).toBeInTheDocument();
    expect(screen.getByText(/Remove approval gates by switching to dark trust/i)).toBeInTheDocument();
    expect(screen.getByText(/Resume the project/i)).toBeInTheDocument();
    expect(screen.getByText(/set_factory_trust_level trust_level=dark/i)).toBeInTheDocument();
    expect(screen.getByText(/resume_project/i)).toBeInTheDocument();
  });

  it('runs the bounded automation readiness dry run from the banner', async () => {
    const baseShell = useFactoryShell();
    const blockedProject = {
      ...factoryProject,
      automation_readiness: {
        ready: false,
        blocker_codes: ['approval_gates_enabled'],
        control_plane_actions: ['set_factory_trust_level trust_level=dark'],
      },
    };
    const automationReadiness = {
      ready: false,
      hands_off_ready: false,
      total_projects: 1,
      ready_projects: 0,
      blocked_projects: 1,
      auto_continue_enabled_projects: 0,
      dark_trust_projects: 0,
      blockers: { approval_gates_enabled: 1 },
      project_ids: {
        ready: [],
        blocked: ['factory-1'],
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark',
          tool: 'set_factory_trust_level',
          args: { project: 'factory-1', trust_level: 'dark' },
          description: 'Remove approval gates by switching to dark trust.',
          processes_project_work: false,
        },
      ],
    };
    factoryApi.applyAutomationPlan.mockResolvedValueOnce({
      completed: true,
      dry_run: true,
      planned_steps: 1,
      applied_steps: [],
      processes_project_work: false,
    });

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness,
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness,
        detail: {
          ...baseShell.outletContext.detail,
          project: blockedProject,
        },
        projects: [blockedProject],
        selectedProject: blockedProject,
        selectedProjectId: blockedProject.id,
      },
      projects: [blockedProject],
      totalProjects: 1,
    });

    renderFactory();

    fireEvent.click(screen.getByRole('button', { name: /dry run/i }));

    await vi.waitFor(() => {
      expect(factoryApi.applyProjectAutomationPlan).toHaveBeenCalledWith('factory-1', {
        dry_run: true,
      });
    });
    expect(factoryApi.applyAutomationPlan).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
    await vi.waitFor(() => {
      expect(refreshSelectedProject).toHaveBeenCalled();
    });
  });

  it('applies automation readiness control-plane steps from the banner without project work args', async () => {
    const baseShell = useFactoryShell();
    const automationReadiness = {
      ready: false,
      hands_off_ready: false,
      total_projects: 1,
      ready_projects: 0,
      blocked_projects: 1,
      auto_continue_enabled_projects: 0,
      dark_trust_projects: 0,
      blockers: { auto_continue_disabled: 1 },
      project_ids: {
        ready: [],
        blocked: ['factory-1'],
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark config.loop.auto_continue=true',
          tool: 'set_factory_trust_level',
          args: {
            project: 'factory-1',
            trust_level: 'dark',
            config: { loop: { auto_continue: true } },
          },
          description: 'Enable dark trust and continuous cycling.',
          processes_project_work: false,
        },
      ],
    };
    factoryApi.applyAutomationPlan.mockResolvedValueOnce({
      completed: true,
      dry_run: false,
      planned_steps: 1,
      applied_steps: [{ tool: 'set_factory_trust_level', processes_project_work: false }],
      processes_project_work: false,
    });

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness,
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness,
      },
    });

    renderFactory();

    fireEvent.click(screen.getByRole('button', { name: /apply controls/i }));

    await vi.waitFor(() => {
      expect(factoryApi.applyProjectAutomationPlan).toHaveBeenCalledWith('factory-1', {
        dry_run: false,
      });
    });
    expect(factoryApi.applyAutomationPlan).not.toHaveBeenCalled();
    expect(loadProjects).toHaveBeenCalledWith({ silent: true });
  });

  it('uses confirmed all-project apply only when readiness steps span multiple projects', async () => {
    const baseShell = useFactoryShell();
    const automationReadiness = {
      ready: false,
      hands_off_ready: false,
      total_projects: 2,
      ready_projects: 0,
      blocked_projects: 2,
      auto_continue_enabled_projects: 0,
      dark_trust_projects: 0,
      blockers: { auto_continue_disabled: 2 },
      project_ids: {
        ready: [],
        blocked: ['factory-1', 'factory-2'],
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark',
          tool: 'set_factory_trust_level',
          args: { project: 'factory-1', trust_level: 'dark' },
          description: 'Switch factory-1 to dark trust.',
          processes_project_work: false,
        },
        {
          action: 'set_factory_trust_level trust_level=dark',
          tool: 'set_factory_trust_level',
          args: { project: 'factory-2', trust_level: 'dark' },
          description: 'Switch factory-2 to dark trust.',
          processes_project_work: false,
        },
      ],
    };
    factoryApi.applyAutomationPlan.mockResolvedValueOnce({
      completed: true,
      dry_run: false,
      planned_steps: 2,
      applied_steps: [
        { tool: 'set_factory_trust_level', processes_project_work: false },
        { tool: 'set_factory_trust_level', processes_project_work: false },
      ],
      processes_project_work: false,
    });

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness,
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness,
      },
    });

    renderFactory();

    fireEvent.click(screen.getByRole('button', { name: /apply controls/i }));

    await vi.waitFor(() => {
      expect(globalThis.confirm).toHaveBeenCalledWith(expect.stringContaining('2 projects'));
      expect(factoryApi.applyAutomationPlan).toHaveBeenCalledWith({
        all_projects: true,
        dry_run: false,
        confirm_all_projects: true,
      });
    });
    expect(factoryApi.applyProjectAutomationPlan).not.toHaveBeenCalled();
  });

  it('does not submit multi-project automation apply when confirmation is cancelled', () => {
    const baseShell = useFactoryShell();
    const automationReadiness = {
      ready: false,
      hands_off_ready: false,
      total_projects: 2,
      ready_projects: 0,
      blocked_projects: 2,
      auto_continue_enabled_projects: 0,
      dark_trust_projects: 0,
      blockers: { auto_continue_disabled: 2 },
      project_ids: {
        ready: [],
        blocked: ['factory-1', 'factory-2'],
      },
      control_plane_plan: [
        {
          action: 'set_factory_trust_level trust_level=dark',
          tool: 'set_factory_trust_level',
          args: { project: 'factory-1', trust_level: 'dark' },
          description: 'Switch factory-1 to dark trust.',
          processes_project_work: false,
        },
        {
          action: 'set_factory_trust_level trust_level=dark',
          tool: 'set_factory_trust_level',
          args: { project: 'factory-2', trust_level: 'dark' },
          description: 'Switch factory-2 to dark trust.',
          processes_project_work: false,
        },
      ],
    };
    globalThis.confirm.mockReturnValueOnce(false);

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness,
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness,
      },
    });

    renderFactory();

    fireEvent.click(screen.getByRole('button', { name: /apply controls/i }));

    expect(globalThis.confirm).toHaveBeenCalledWith(expect.stringContaining('2 projects'));
    expect(factoryApi.applyAutomationPlan).not.toHaveBeenCalled();
    expect(factoryApi.applyProjectAutomationPlan).not.toHaveBeenCalled();
  });

  it('shows manual intervention when automation controls are ready but queues are operator-owned', () => {
    const baseShell = useFactoryShell();
    const readyProject = {
      ...factoryProject,
      automation_readiness: {
        ready: true,
        blocker_codes: [],
        control_plane_actions: [],
      },
      work_item_status_counts: {
        needs_review: 1,
      },
    };

    useFactoryShell.mockReturnValue({
      ...baseShell,
      automationReadiness: {
        ready: true,
        hands_off_ready: false,
        total_projects: 1,
        ready_projects: 1,
        blocked_projects: 0,
        auto_continue_enabled_projects: 1,
        dark_trust_projects: 1,
        blockers: {},
        project_ids: {
          ready: ['factory-1'],
          blocked: [],
        },
        manual_intervention: {
          required: true,
          reason_codes: ['task_approval_pending', 'work_items_need_review'],
          counts: {
            pending_approval_tasks: 2,
            needs_review_work_items: 1,
            escalation_exhausted_work_items: 0,
            scheduler_unarmed_projects: 1,
          },
        },
        control_plane_plan: [],
      },
      outletContext: {
        ...baseShell.outletContext,
        automationReadiness: {
          ready: true,
          hands_off_ready: false,
          total_projects: 1,
          ready_projects: 1,
          blocked_projects: 0,
          auto_continue_enabled_projects: 1,
          dark_trust_projects: 1,
          blockers: {},
          project_ids: {
            ready: ['factory-1'],
            blocked: [],
          },
          manual_intervention: {
            required: true,
            reason_codes: ['task_approval_pending', 'work_items_need_review'],
            counts: {
              pending_approval_tasks: 2,
              needs_review_work_items: 1,
              escalation_exhausted_work_items: 0,
              scheduler_unarmed_projects: 1,
            },
          },
          control_plane_plan: [],
        },
        detail: {
          ...baseShell.outletContext.detail,
          project: readyProject,
        },
        projects: [readyProject],
        selectedProject: readyProject,
        selectedProjectId: readyProject.id,
      },
      projects: [readyProject],
      totalProjects: 1,
    });

    renderFactory();

    expect(screen.getByText('Automation controls ready; manual intervention queued')).toBeInTheDocument();
    expect(screen.getByText(/1 control-ready .* 1 auto-continue .* 1 dark trust/i)).toBeInTheDocument();
    expect(screen.getByText('1 tick unarmed · 2 approvals · 1 needs review · 0 needs replan · 0 exhausted')).toBeInTheDocument();
    expect(screen.queryByText('Blocked: torque-public')).not.toBeInTheDocument();
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
