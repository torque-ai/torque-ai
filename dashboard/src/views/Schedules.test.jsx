import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Schedules from './Schedules';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  schedules: {
    list: vi.fn(),
    create: vi.fn(),
    run: vi.fn(),
    toggle: vi.fn(),
    delete: vi.fn(),
    get: vi.fn(),
    getRun: vi.fn(),
    update: vi.fn(),
  },
  study: {
    preview: vi.fn(),
    bootstrap: vi.fn(),
    benchmark: vi.fn(),
    getProfileOverride: vi.fn(),
    saveProfileOverride: vi.fn(),
    deleteProfileOverride: vi.fn(),
  },
}));

import { schedules as schedulesApi, study as studyApi } from '../api';

const mockV2Schedules = [
  {
    id: 'sched-1',
    name: 'Nightly Test Run',
    cron_expression: '0 0 * * *',
    task_description: 'Run the full test suite nightly',
    provider: 'codex',
    model: 'gpt-5.3-codex-spark',
    working_directory: 'C:/Projects/MyApp',
    enabled: 1,
    next_run: '2026-02-29T00:00:00Z',
    last_run: '2026-02-28T00:00:00Z',
    task_config: {
      tool_name: 'run_codebase_study',
      tool_args: {
        working_directory: 'C:/Projects/MyApp',
        submit_proposals: false,
        proposal_limit: 2,
      },
    },
    delta_significance_level: 'moderate',
    delta_significance_score: 37,
    proposal_count: 3,
    submitted_proposal_count: 1,
    pending_count: 42,
    module_entry_count: 1450,
    last_delta_updated_at: '2026-02-28T03:30:00Z',
    last_result: 'partial_local',
    evaluation_score: 91,
    evaluation_grade: 'A',
    evaluation_readiness: 'expert_ready',
    evaluation_findings_count: 2,
    evaluation_generated_at: '2026-02-28T03:31:00Z',
    study_delta: {
      significance: {
        level: 'moderate',
        score: 37,
        reasons: ['Control-plane and scheduling files changed together.'],
      },
      changed_subsystems: [
        { id: 'control-plane-api', label: 'Control-plane API' },
        { id: 'scheduled-automation', label: 'Scheduled automation' },
      ],
      affected_flows: [
        { id: 'task-lifecycle', label: 'Task lifecycle' },
      ],
      invariant_hits: [
        { id: 'scheduled-automation:5', statement: 'Schedules should create tracked task or tool executions.' },
      ],
      failure_mode_hits: [
        { id: 'run-now-divergence', label: 'Run Now path divergence' },
      ],
      proposals: {
        suggested: [
          { key: 'study:1', title: 'Review scheduling drift' },
        ],
      },
    },
    study_evaluation: {
      generated_at: '2026-02-28T03:31:00Z',
      summary: {
        score: 91,
        grade: 'A',
        readiness: 'expert_ready',
      },
      strengths: ['Coverage is effectively complete.'],
      findings: [
        { code: 'thin_traces', message: 'Only a few traces are present.' },
      ],
    },
    benchmark_score: 88,
    benchmark_grade: 'B',
    benchmark_readiness: 'operator_ready',
    benchmark_findings_count: 1,
    benchmark_case_count: 8,
    benchmark_generated_at: '2026-02-28T03:32:00Z',
    study_impact: {
      window_days: 30,
      task_outcomes: {
        with_context: { count: 6, success_rate: 83.3, avg_retry_count: 0.5, avg_total_tokens: 3200, avg_cost_usd: 0.0123 },
        without_context: { count: 3, success_rate: 66.7, avg_retry_count: 1, avg_total_tokens: 4100, avg_cost_usd: 0.0199 },
        delta: { comparison_available: true, success_rate_points: 16.6, retry_count_delta: -0.5, total_tokens_delta: -900 },
      },
      review_outcomes: {
        with_context_source: { flag_rate: 20 },
        without_context_source: { flag_rate: 40 },
      },
    },
    study_benchmark: {
      generated_at: '2026-02-28T03:32:00Z',
      summary: {
        score: 88,
        grade: 'B',
        readiness: 'operator_ready',
        total_cases: 8,
      },
      findings: [
        { probe_id: 'task-lifecycle', message: 'Pack coverage hit 2/3 expected evidence files.' },
      ],
    },
    recent_runs: [
      {
        id: 'run-study-77',
        status: 'completed',
        trigger_source: 'manual_run_now',
        started_at: '2026-02-28T03:30:00Z',
        completed_at: '2026-02-28T03:31:00Z',
        wrapper_task_id: 'task-study-wrapper',
        summary: 'Study run completed with a high-significance delta.',
      },
    ],
  },
  {
    id: 'sched-2',
    name: 'Weekly Cleanup',
    cron_expression: '0 3 * * 0',
    task_description: 'Clean up temp files and reset cache',
    provider: 'ollama',
    model: 'qwen3:8b',
    working_directory: '',
    enabled: 0,
    next_run: null,
    last_run: null,
  },
];

describe('Schedules', () => {
  beforeEach(() => {
    schedulesApi.list.mockResolvedValue(mockV2Schedules);
    schedulesApi.create.mockResolvedValue({ id: 'sched-new' });
    schedulesApi.run.mockResolvedValue({ started: true, execution_type: 'task', task_id: 'task-1' });
    schedulesApi.toggle.mockResolvedValue({});
    schedulesApi.delete.mockResolvedValue({});
    schedulesApi.get.mockResolvedValue(mockV2Schedules[0]);
    schedulesApi.getRun.mockResolvedValue(mockV2Schedules[0].recent_runs[0]);
    schedulesApi.update.mockResolvedValue({});
    studyApi.bootstrap.mockResolvedValue({
      bootstrap_plan: {
        repo: { name: 'torque-public' },
      },
      study_profile: { id: 'torque-control-plane', label: 'TORQUE Control Plane' },
      initial_run: { task_status: 'completed' },
      study_evaluation: { summary: { grade: 'A', readiness: 'expert_ready' } },
      study_benchmark: { summary: { grade: 'B', score: 88 } },
      schedule: { schedule_id: 'sched-1', name: 'Nightly Test Run' },
    });
    studyApi.preview.mockResolvedValue({
      bootstrap_plan: {
        repo: { name: 'torque-public', tracked_file_count: 1450 },
        recommendations: {
          initial_run: { max_batches: 5 },
          schedule: { name: 'codebase-study:torque-public', submit_proposals: false },
        },
      },
      study_profile: { id: 'torque-control-plane', label: 'TORQUE Control Plane' },
      profile_override: {
        exists: false,
        repo_path: 'docs/architecture/study-profile.override.json',
      },
    });
    studyApi.benchmark.mockResolvedValue({ study_benchmark: mockV2Schedules[0].study_benchmark });
    studyApi.getProfileOverride.mockResolvedValue({
      exists: true,
      active: true,
      repo_path: 'docs/architecture/study-profile.override.json',
      raw_override: '{\n  "version": 1,\n  "base_profile_id": "generic-javascript-repo",\n  "subsystem_priority": {\n    "runtime": 10\n  }\n}\n',
      override: {
        version: 1,
        base_profile_id: 'generic-javascript-repo',
        subsystem_priority: { runtime: 10 },
      },
      template: {
        version: 1,
        base_profile_id: 'generic-javascript-repo',
        subsystem_definitions: [],
        subsystem_priority: {},
        subsystem_guidance: {},
        flow_definitions: [],
        flow_guidance: {},
        validation_commands: {},
      },
      study_profile: {
        id: 'generic-javascript-repo',
        label: 'Generic JavaScript Repo',
        framework_detection: {
          archetype: 'frontend-app',
          confidence: 'high',
          frameworks: ['react', 'vite'],
          traits: ['spa'],
          evidence: ['package.json dependencies include react and vite'],
        },
      },
    });
    studyApi.saveProfileOverride.mockImplementation(async (data) => ({
      exists: true,
      active: true,
      repo_path: 'docs/architecture/study-profile.override.json',
      raw_override: `${JSON.stringify(data.override, null, 2)}\n`,
      override: data.override,
      template: {
        version: 1,
        base_profile_id: 'generic-javascript-repo',
        subsystem_definitions: [],
        subsystem_priority: {},
        subsystem_guidance: {},
        flow_definitions: [],
        flow_guidance: {},
        validation_commands: {},
      },
      study_profile: {
        id: 'generic-javascript-repo',
        label: 'Generic JavaScript Repo',
        framework_detection: {
          archetype: 'frontend-app',
          confidence: 'high',
          frameworks: ['react', 'vite'],
          traits: ['spa'],
          evidence: ['package.json dependencies include react and vite'],
        },
      },
    }));
    studyApi.deleteProfileOverride.mockResolvedValue({
      exists: false,
      active: false,
      repo_path: 'docs/architecture/study-profile.override.json',
      raw_override: null,
      override: null,
      template: {
        version: 1,
        base_profile_id: 'generic-javascript-repo',
        subsystem_definitions: [],
        subsystem_priority: {},
        subsystem_guidance: {},
        flow_definitions: [],
        flow_guidance: {},
        validation_commands: {},
      },
      study_profile: {
        id: 'generic-javascript-repo',
        label: 'Generic JavaScript Repo',
        framework_detection: {
          archetype: 'frontend-app',
          confidence: 'high',
          frameworks: ['react', 'vite'],
          traits: ['spa'],
          evidence: ['package.json dependencies include react and vite'],
        },
      },
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    schedulesApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Schedules />, { route: '/schedules' });
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders heading after loading', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Schedules')).toBeInTheDocument();
    });
  });

  it('displays New Schedule button', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
      expect(screen.getByText('Bootstrap Study')).toBeInTheDocument();
    });
  });

  it('toggles bootstrap form visibility when Bootstrap Study is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Bootstrap Study')).toBeInTheDocument();
    });

    expect(screen.queryByText('Create a study knowledge pack for a repo and optionally register the recurring schedule in one step.')).toBeNull();
    fireEvent.click(screen.getByText('Bootstrap Study'));
    expect(screen.getByText('Create a study knowledge pack for a repo and optionally register the recurring schedule in one step.')).toBeInTheDocument();
  });

  it('shows summary stat cards', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Total Schedules')).toBeInTheDocument();
      // Active and Disabled appear in both StatCard labels and status badges — use getAllByText
      expect(screen.getAllByText('Active').length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText('Disabled').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows correct total count', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      // Total = 2
      expect(screen.getByText('2')).toBeInTheDocument();
    });
  });

  it('renders table column headers', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Name')).toBeInTheDocument();
      expect(screen.getByText('Schedule')).toBeInTheDocument();
      expect(screen.getByText('Next Run')).toBeInTheDocument();
      expect(screen.getByText('Last Run')).toBeInTheDocument();
      expect(screen.getByText('Status')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });
  });

  it('renders schedule names from the v2 array response', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
      expect(screen.getByText('Weekly Cleanup')).toBeInTheDocument();
    });
  });

  it('renders cron expressions', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('0 0 * * *')).toBeInTheDocument();
      expect(screen.getByText('0 3 * * 0')).toBeInTheDocument();
    });
  });

  it('shows task description truncated in table', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText(/Run the full test suite/)).toBeInTheDocument();
    });
  });

  it('shows Enabled badge for enabled schedule', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Enabled')).toBeInTheDocument();
    });
  });

  it('shows Disabled badge for disabled schedule', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      // 'Disabled' appears in both the StatCard label and the status badge span
      const disabledEls = screen.getAllByText('Disabled');
      expect(disabledEls.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('renders Enable/Disable action buttons', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      // Enabled schedule shows "Disable", disabled schedule shows "Enable"
      expect(screen.getByText('Disable')).toBeInTheDocument();
      expect(screen.getByText('Enable')).toBeInTheDocument();
    });
  });

  it('renders Run Now buttons for each schedule', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      const runButtons = screen.getAllByText('Run Now');
      expect(runButtons.length).toBe(2);
    });
  });

  it('renders study delta context in the schedule list', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Study')).toBeInTheDocument();
      expect(screen.getByText('Delta: Moderate')).toBeInTheDocument();
      expect(screen.getByText('3 proposals')).toBeInTheDocument();
      expect(screen.getByText('42 pending')).toBeInTheDocument();
    });
  });

  it('renders Delete buttons for each schedule', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      const deleteButtons = screen.getAllByText('Delete');
      expect(deleteButtons.length).toBe(2);
    });
  });

  it('shows empty state when no schedules', async () => {
    schedulesApi.list.mockResolvedValue([]);
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText(/No scheduled tasks/)).toBeInTheDocument();
    });
  });

  it('calls schedulesApi.list on mount', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      // Called at least once on mount (may be called again by the 15s interval in fast test runs)
      expect(schedulesApi.list).toHaveBeenCalled();
    });
  });

  it('toggles form visibility when New Schedule is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    // Form should not be visible initially
    expect(screen.queryByText('New Scheduled Task')).toBeNull();

    // Click New Schedule to open form
    fireEvent.click(screen.getByText('New Schedule'));
    expect(screen.getByText('New Scheduled Task')).toBeInTheDocument();
  });

  it('renders form fields when form is open', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    expect(screen.getByPlaceholderText('e.g. Nightly test run')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('0 0 * * * (every midnight)')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('What should the task do?')).toBeInTheDocument();
  });

  it('shows Create Schedule and Cancel buttons in form', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    expect(screen.getByText('Create Schedule')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
  });

  it('hides form when Cancel is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));
    expect(screen.getByText('New Scheduled Task')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(screen.queryByText('New Scheduled Task')).toBeNull();
  });

  it('calls schedulesApi.toggle when Disable button is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Disable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Disable'));

    await waitFor(() => {
      expect(schedulesApi.toggle).toHaveBeenCalledWith('sched-1', false);
    });
  });

  it('calls schedulesApi.toggle with true when Enable is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Enable')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Enable'));

    await waitFor(() => {
      expect(schedulesApi.toggle).toHaveBeenCalledWith('sched-2', true);
    });
  });

  it('calls schedulesApi.delete when Delete button is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getAllByText('Delete').length).toBe(2);
    });

    fireEvent.click(screen.getAllByText('Delete')[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'));

    await waitFor(() => {
      expect(schedulesApi.delete).toHaveBeenCalledWith('sched-1');
    });
  });

  it('calls schedulesApi.run when Run Now is clicked', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getAllByText('Run Now').length).toBe(2);
    });

    fireEvent.click(screen.getAllByText('Run Now')[0]);

    await waitFor(() => {
      expect(schedulesApi.run).toHaveBeenCalledWith('sched-1');
    });
  });

  it('shows study intelligence controls in the detail drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    await waitFor(() => {
      expect(schedulesApi.get).toHaveBeenCalledWith('sched-1');
      expect(screen.getByText('Study Intelligence')).toBeInTheDocument();
      expect(screen.getByText('Auto-Submit')).toBeInTheDocument();
      expect(screen.getByText('Proposal Limit')).toBeInTheDocument();
      expect(screen.getByText('Min Delta Level')).toBeInTheDocument();
      expect(screen.getByText('Min Delta Score')).toBeInTheDocument();
      expect(screen.getByText('Pack Benchmark')).toBeInTheDocument();
      expect(screen.getByText('Study Profile Override')).toBeInTheDocument();
      expect(screen.getByText('Frontend App')).toBeInTheDocument();
      expect(screen.getByText('Save Override')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Run Benchmark' })).toBeInTheDocument();
      expect(screen.getByText('Pack Evaluation')).toBeInTheDocument();
      expect(screen.getByText('Latest Delta')).toBeInTheDocument();
      expect(screen.getByText('Recent Runs')).toBeInTheDocument();
    });
  });

  it('opens the schedule drawer from search params and highlights the traced run', async () => {
    renderWithProviders(<Schedules />, { route: '/operations?scheduleId=sched-1&runId=run-study-77#schedules' });

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    expect(dialog).toBeInTheDocument();
    await waitFor(() => {
      expect(schedulesApi.get).toHaveBeenCalledWith('sched-1');
      expect(within(dialog).getByText('run-study-77')).toBeInTheDocument();
      expect(within(dialog).getByText('Approval Trace Target')).toBeInTheDocument();
    });
  });

  it('updates study auto-submit controls from the detail drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Off' }));

    await waitFor(() => {
      expect(schedulesApi.update).toHaveBeenCalledWith('sched-1', { submit_proposals: true });
    });
  });

  it('renders study delta and evaluation details in the drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    expect(within(dialog).getByText('Why It Matters')).toBeInTheDocument();
    expect(within(dialog).getByText('Control-plane API')).toBeInTheDocument();
    expect(within(dialog).getByText(/Coverage is effectively complete/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Pack coverage hit 2\/3 expected evidence files/)).toBeInTheDocument();
  });

  it('calls studyApi.bootstrap and opens the created schedule drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Bootstrap Study')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Bootstrap Study'));
    fireEvent.change(screen.getByPlaceholderText('e.g. C:/Projects/MyRepo'), {
      target: { value: 'C:/Projects/torque-public' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Bootstrap Study' })[1]);

    await waitFor(() => {
      expect(studyApi.bootstrap).toHaveBeenCalledWith(expect.objectContaining({
        working_directory: 'C:/Projects/torque-public',
        create_schedule: true,
        run_initial_study: true,
        run_benchmark: true,
      }));
      expect(schedulesApi.get).toHaveBeenCalledWith('sched-1');
      expect(screen.getByText('Latest Study Bootstrap')).toBeInTheDocument();
    });
  });

  it('calls studyApi.preview from the bootstrap form', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Bootstrap Study')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Bootstrap Study'));
    fireEvent.change(screen.getByPlaceholderText('e.g. C:/Projects/MyRepo'), {
      target: { value: 'C:/Projects/torque-public' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Preview Plan' }));

    await waitFor(() => {
      expect(studyApi.preview).toHaveBeenCalledWith(expect.objectContaining({
        working_directory: 'C:/Projects/torque-public',
      }));
      expect(screen.getByText('Bootstrap Preview')).toBeInTheDocument();
    });
  });

  it('calls studyApi.benchmark from the detail drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run Benchmark' }));

    await waitFor(() => {
      expect(studyApi.benchmark).toHaveBeenCalledWith({ working_directory: 'C:/Projects/MyApp' });
    });
  });

  it('saves a study profile override from the detail drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    await waitFor(() => {
      expect(studyApi.getProfileOverride).toHaveBeenCalledWith({ working_directory: 'C:/Projects/MyApp' });
    });
    const overrideField = within(dialog).getByLabelText('Override JSON');
    fireEvent.change(overrideField, {
      target: {
        value: '{\n  "version": 1,\n  "base_profile_id": "generic-javascript-repo",\n  "subsystem_priority": {\n    "control-plane-api": 99\n  }\n}\n',
      },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save Override' }));

    await waitFor(() => {
      expect(studyApi.saveProfileOverride).toHaveBeenCalledWith({
        working_directory: 'C:/Projects/MyApp',
        override: {
          version: 1,
          base_profile_id: 'generic-javascript-repo',
          subsystem_priority: {
            'control-plane-api': 99,
          },
        },
      });
    });
  });

  it('can load the template and delete the study profile override from the detail drawer', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });

    await waitFor(() => {
      expect(screen.getByText('Nightly Test Run')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Nightly Test Run'));

    const dialog = await screen.findByRole('dialog', { name: 'Schedule details' });
    await waitFor(() => {
      expect(studyApi.getProfileOverride).toHaveBeenCalledWith({ working_directory: 'C:/Projects/MyApp' });
    });
    const overrideField = within(dialog).getByLabelText('Override JSON');

    fireEvent.click(within(dialog).getByRole('button', { name: 'Load Template' }));
    await waitFor(() => {
      expect(overrideField.value).toContain('"subsystem_definitions": []');
    });

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete Override' }));

    await waitFor(() => {
      expect(studyApi.deleteProfileOverride).toHaveBeenCalledWith({
        working_directory: 'C:/Projects/MyApp',
      });
    });
  });

  it('reloads schedules after successful toggle', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('Disable')).toBeInTheDocument();
    });

    const callsBefore = schedulesApi.list.mock.calls.length;
    fireEvent.click(screen.getByText('Disable'));

    await waitFor(() => {
      // list called at least once more after toggle
      expect(schedulesApi.list.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('reloads schedules after successful delete', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getAllByText('Delete').length).toBe(2);
    });

    const callsBefore = schedulesApi.list.mock.calls.length;
    fireEvent.click(screen.getAllByText('Delete')[0]);

    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByText('Delete'));

    await waitFor(() => {
      expect(schedulesApi.list.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  it('calls schedulesApi.create when form is submitted with valid data', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Nightly test run'), {
      target: { value: 'My New Schedule' },
    });
    fireEvent.change(screen.getByPlaceholderText('0 0 * * * (every midnight)'), {
      target: { value: '0 6 * * 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('What should the task do?'), {
      target: { value: 'Run weekly build checks' },
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    await waitFor(() => {
      expect(schedulesApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'My New Schedule',
          cron_expression: '0 6 * * 1',
          task_description: 'Run weekly build checks',
        })
      );
    });
  });

  it('creates workflow-source schedules with project metadata', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Nightly test run'), {
      target: { value: 'example-project autodev' },
    });
    fireEvent.change(screen.getByPlaceholderText('0 0 * * * (every midnight)'), {
      target: { value: '*/10 * * * *' },
    });
    fireEvent.change(screen.getByLabelText('Execution Target'), {
      target: { value: 'workflow_source' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. b588fb4f-cece-44b4-8407-4cbaa18a524d'), {
      target: { value: 'wf-source-1' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. C:/Projects/MyApp'), {
      target: { value: 'C:/Users/<user>/Projects/example-project-autodev' },
    });
    fireEvent.change(screen.getByPlaceholderText('e.g. example-project-autodev'), {
      target: { value: 'example-project-autodev' },
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    await waitFor(() => {
      expect(schedulesApi.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'example-project autodev',
          cron_expression: '*/10 * * * *',
          workflow_source_id: 'wf-source-1',
          working_directory: 'C:/Users/<user>/Projects/example-project-autodev',
          project: 'example-project-autodev',
        })
      );
    });
  });

  it('hides form after successful create', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    fireEvent.change(screen.getByPlaceholderText('e.g. Nightly test run'), {
      target: { value: 'My New Schedule' },
    });
    fireEvent.change(screen.getByPlaceholderText('0 0 * * * (every midnight)'), {
      target: { value: '0 6 * * 1' },
    });
    fireEvent.change(screen.getByPlaceholderText('What should the task do?'), {
      target: { value: 'Run weekly build checks' },
    });

    fireEvent.click(screen.getByText('Create Schedule'));

    await waitFor(() => {
      expect(screen.queryByText('New Scheduled Task')).toBeNull();
    });
  });

  it('handles API error on load gracefully', async () => {
    schedulesApi.list.mockRejectedValue(new Error('Network error'));
    // Should not throw — error is caught internally and logged
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      // After failed load, loading ends and table shows empty state
      expect(screen.getByText(/No scheduled tasks/)).toBeInTheDocument();
    });
  });

  it('shows N/A for null run dates', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      const unavailableValues = screen.getAllByText('N/A');
      expect(unavailableValues.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('renders provider select dropdown in form', async () => {
    renderWithProviders(<Schedules />, { route: '/schedules' });
    await waitFor(() => {
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('New Schedule'));

    // Provider dropdown should include auto option
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByText('Ollama')).toBeInTheDocument();
  });
});