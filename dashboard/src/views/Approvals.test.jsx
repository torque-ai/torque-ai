import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Approvals from './Approvals';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  approvals: {
    listPending: vi.fn(),
    getHistory: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  },
  tasks: {
    list: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
    approveBatch: vi.fn(),
  },
}));

import { approvals as approvalsApi, tasks as tasksApi } from '../api';

// v2 approvals endpoints resolve to bare arrays, not { approvals: [...] }.
const mockPendingV2Response = [
  {
    id: 'appr-001-abcdef12',
    approval_type: 'study_proposal',
    kind: 'invariant-review',
    description: 'Review task lifecycle changes for invariant drift',
    task_id: 'task-999-aabbccdd',
    rule: 'Study proposal review',
    created_at: '2026-02-28T10:00:00Z',
    rationale: 'Changed files intersect the task lifecycle invariant.',
    files: ['server/task-manager.js', 'server/execution/task-finalizer.js'],
    related_tests: ['server/tests/task-core-handlers.test.js'],
    validation_commands: ['npx vitest run server/tests/task-core-handlers.test.js'],
    study_trace: {
      schedule_id: 'schedule-study-1',
      schedule_name: 'codebase-study:torque-public',
      schedule_run_id: 'run-study-77',
      delta_significance_level: 'high',
      delta_significance_score: 84,
      significance_reasons: ['2 critical invariants were touched.'],
      changed_subsystems: ['Task execution pipeline', 'Control-plane API'],
      affected_flows: ['Task submission -> execution'],
      run_mode: 'repo-delta',
    },
  },
  {
    id: 'appr-002-12345678',
    description: 'Delete staging database',
    task_id: 'task-888-11223344',
    rule: 'destructive-action',
    created_at: '2026-02-28T09:30:00Z',
  },
];

const todayStr = new Date().toISOString();

const mockHistoryV2Response = [
  {
    id: 'appr-100-aaaaaaaa',
    approval_type: 'study_proposal',
    kind: 'failure-mode-review',
    description: 'Validate provider fallback risk after recent changes',
    decision: 'approved',
    decided_by: 'admin',
    decided_at: todayStr,
    rationale: 'The change set intersects a known failure mode.',
    study_trace: {
      schedule_id: 'schedule-study-1',
      schedule_name: 'codebase-study:torque-public',
      schedule_run_id: 'run-study-66',
      delta_significance_level: 'medium',
      delta_significance_score: 37,
      significance_reasons: ['1 known failure mode intersected the changed seam.'],
      changed_subsystems: ['Provider adapters'],
      affected_flows: ['Task submission -> execution'],
      run_mode: 'repo-delta',
    },
  },
  {
    id: 'appr-101-bbbbbbbb',
    description: 'Scale down workers',
    decision: 'rejected',
    decided_by: 'ops-lead',
    decided_at: todayStr,
  },
  {
    id: 'appr-102-cccccccc',
    description: 'Old approval',
    decision: 'approved',
    decided_by: 'admin',
    decided_at: '2026-01-15T08:00:00Z',
  },
];

const longFactoryDescription = 'Second factory approval task '.repeat(10);

const mockFactoryTasksResponse = {
  tasks: [
    {
      id: 'task-approval-1',
      task_description: 'First factory approval task for alpha',
      project: 'alpha',
      status: 'pending_approval',
      created_at: '2026-02-28T10:05:00Z',
      tags: [
        'factory:batch_id=batch-42',
        'factory:work_item_id=work-item-7',
        'factory:plan_task_number=1',
      ],
    },
    {
      id: 'task-approval-2',
      task_description: longFactoryDescription,
      project: 'alpha',
      status: 'pending_approval',
      created_at: '2026-02-28T10:06:00Z',
      tags: [
        'factory:batch_id=batch-42',
        'factory:work_item_id=work-item-7',
        'factory:plan_task_number=2',
      ],
    },
    {
      id: 'task-approval-3',
      task_description: 'Beta factory approval task',
      project: 'beta',
      status: 'pending_approval',
      created_at: '2026-02-28T10:07:00Z',
      tags: [
        'factory:batch_id=batch-99',
        'factory:work_item_id=work-item-9',
        'factory:plan_task_number=1',
      ],
    },
    {
      id: 'task-non-factory-1',
      task_description: 'Pending approval task without factory tags',
      project: 'alpha',
      status: 'pending_approval',
      created_at: '2026-02-28T10:08:00Z',
      tags: [],
    },
  ],
  total: 4,
};

describe('Approvals', () => {
  beforeEach(() => {
    approvalsApi.listPending.mockResolvedValue(mockPendingV2Response);
    approvalsApi.getHistory.mockResolvedValue(mockHistoryV2Response);
    approvalsApi.approve.mockResolvedValue({});
    approvalsApi.reject.mockResolvedValue({});
    tasksApi.list.mockResolvedValue({ tasks: [], total: 0 });
    tasksApi.approve.mockResolvedValue({});
    tasksApi.reject.mockResolvedValue({});
    tasksApi.approveBatch.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    approvalsApi.listPending.mockReturnValue(new Promise(() => {}));
    approvalsApi.getHistory.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Approvals />, { route: '/approvals' });
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders heading after data loads', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
  });

  it('loads approval history on mount before switching tabs', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(approvalsApi.getHistory).toHaveBeenCalledWith(50);
    });
  });

  it('renders subtitle text', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Review and act on pending approval requests')).toBeInTheDocument();
    });
  });

  it('renders grouped factory task approvals with source and project filters', async () => {
    tasksApi.list.mockResolvedValue(mockFactoryTasksResponse);

    renderWithProviders(<Approvals />, { route: '/approvals?source=factory&project=alpha' });

    const section = await screen.findByRole('region', { name: 'Factory Task Approvals' });
    expect(within(section).getByText('Source: Factory')).toBeInTheDocument();
    expect(within(section).getByText('Project filter: alpha')).toBeInTheDocument();
    expect(within(section).getByText('Batch batch-42')).toBeInTheDocument();
    expect(within(section).queryByText('Batch batch-99')).toBeNull();
    expect(within(section).getByText('Task 1')).toBeInTheDocument();
    expect(
      within(section).getByText(`${longFactoryDescription.slice(0, 200).trimEnd()}...`)
    ).toBeInTheDocument();
  });

  it('approves an entire factory batch and removes it from the list', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: mockFactoryTasksResponse.tasks.filter((task) => task.tags.includes('factory:batch_id=batch-42')),
      total: 2,
    });

    renderWithProviders(<Approvals />, { route: '/approvals?source=factory' });

    const section = await screen.findByRole('region', { name: 'Factory Task Approvals' });
    expect(within(section).getByText('Batch batch-42')).toBeInTheDocument();

    fireEvent.click(within(section).getByRole('button', { name: 'Approve all' }));

    await waitFor(() => {
      expect(tasksApi.approveBatch).toHaveBeenCalledWith({
        batch_id: 'batch-42',
        task_ids: ['task-approval-1', 'task-approval-2'],
      });
    });

    await waitFor(() => {
      expect(within(section).queryByText('Batch batch-42')).toBeNull();
      expect(within(section).getByText('No tasks awaiting approval.')).toBeInTheDocument();
    });
  });

  it('rejects all tasks in a factory batch via per-task rejects', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: mockFactoryTasksResponse.tasks.filter((task) => task.tags.includes('factory:batch_id=batch-42')),
      total: 2,
    });

    renderWithProviders(<Approvals />, { route: '/approvals?source=factory' });

    const section = await screen.findByRole('region', { name: 'Factory Task Approvals' });
    fireEvent.click(within(section).getByRole('button', { name: 'Reject all' }));

    await waitFor(() => {
      expect(tasksApi.reject).toHaveBeenCalledTimes(2);
      expect(tasksApi.reject).toHaveBeenCalledWith('task-approval-1');
      expect(tasksApi.reject).toHaveBeenCalledWith('task-approval-2');
    });
  });

  it('restores a factory task when reject fails', async () => {
    tasksApi.list.mockResolvedValue({
      tasks: [mockFactoryTasksResponse.tasks[0]],
      total: 1,
    });
    tasksApi.reject.mockRejectedValueOnce(new Error('boom'));

    renderWithProviders(<Approvals />, { route: '/approvals?source=factory' });

    const section = await screen.findByRole('region', { name: 'Factory Task Approvals' });
    fireEvent.click(within(section).getByRole('button', { name: 'Reject' }));

    await waitFor(() => {
      expect(screen.getByText('Reject failed: boom')).toBeInTheDocument();
    });

    expect(within(section).getByText('Task 1')).toBeInTheDocument();
    expect(within(section).getByText('First factory approval task for alpha')).toBeInTheDocument();
  });

  it('displays Pending stat card with correct count', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // "Pending" appears in both stat card and tab button
      const pendingElements = screen.getAllByText('Pending');
      expect(pendingElements.length).toBeGreaterThanOrEqual(1);
    });
  });

  it('displays Approved Today stat card', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approved Today')).toBeInTheDocument();
    });
  });

  it('displays Rejected Today stat card', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Rejected Today')).toBeInTheDocument();
    });
  });

  it('renders pending tab as active by default', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // Pending tab button exists; the pending table is shown
      expect(screen.getByText('Review task lifecycle changes for invariant drift')).toBeInTheDocument();
    });
  });

  it('renders pending approvals from the v2 array response shape', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Review task lifecycle changes for invariant drift')).toBeInTheDocument();
      expect(screen.getByText('Delete staging database')).toBeInTheDocument();
    });
  });

  it('renders study proposal details in the pending table', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Study Proposal')).toBeInTheDocument();
      expect(screen.getByText('invariant-review')).toBeInTheDocument();
      expect(screen.getByText('Changed files intersect the task lifecycle invariant.')).toBeInTheDocument();
      expect(screen.getByText('Why this proposal happened')).toBeInTheDocument();
      expect(screen.getByText('Delta: High')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Open generating run' })).toHaveAttribute(
        'href',
        '/operations?scheduleId=schedule-study-1&runId=run-study-77#schedules'
      );
      expect(screen.getByText(/Files: server\/task-manager\.js, server\/execution\/task-finalizer\.js/)).toBeInTheDocument();
      expect(screen.getByText(/Tests: server\/tests\/task-core-handlers\.test\.js/)).toBeInTheDocument();
      expect(screen.getByText(/Validate: npx vitest run server\/tests\/task-core-handlers\.test\.js/)).toBeInTheDocument();
    });
  });

  it('renders pending table headers', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('ID')).toBeInTheDocument();
      expect(screen.getByText('Description')).toBeInTheDocument();
      expect(screen.getByText('Rule')).toBeInTheDocument();
      expect(screen.getByText('Created At')).toBeInTheDocument();
      expect(screen.getByText('Actions')).toBeInTheDocument();
    });
  });

  it('renders Approve and Reject buttons for each pending item', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      const approveButtons = screen.getAllByText('Approve');
      const rejectButtons = screen.getAllByText('Reject');
      expect(approveButtons.length).toBe(2);
      expect(rejectButtons.length).toBe(2);
    });
  });

  it('renders rule names for pending items', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Study proposal review')).toBeInTheDocument();
      expect(screen.getByText('destructive-action')).toBeInTheDocument();
    });
  });

  it('shows empty pending state when no approvals', async () => {
    approvalsApi.listPending.mockResolvedValue([]);
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeInTheDocument();
    });
  });

  it('switches to history tab on click', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('Validate provider fallback risk after recent changes')).toBeInTheDocument();
      expect(screen.getByText('Scale down workers')).toBeInTheDocument();
    });
  });

  it('renders study proposal rationale in history', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('failure-mode-review')).toBeInTheDocument();
      expect(screen.getByText('The change set intersects a known failure mode.')).toBeInTheDocument();
      expect(screen.getAllByText('Open generating run').length).toBeGreaterThanOrEqual(1);
    });
  });

  it('shows history table headers', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('Decision')).toBeInTheDocument();
      expect(screen.getByText('Decided By')).toBeInTheDocument();
      expect(screen.getByText('Decided At')).toBeInTheDocument();
    });
  });

  it('shows decision badges in history', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      const approvedBadges = screen.getAllByText('approved');
      const rejectedBadges = screen.getAllByText('rejected');
      expect(approvedBadges.length).toBe(2); // 2 approved in history
      expect(rejectedBadges.length).toBe(1);
    });
  });

  it('shows decided by names in history', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      // "admin" appears twice (two approved history items decided by admin)
      const adminElements = screen.getAllByText('admin');
      expect(adminElements.length).toBe(2);
      expect(screen.getByText('ops-lead')).toBeInTheDocument();
    });
  });

  it('shows empty history state when no history', async () => {
    approvalsApi.getHistory.mockResolvedValue([]);
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('No approval history')).toBeInTheDocument();
    });
  });

  it('calls approve API when Approve button is clicked', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getAllByText('Approve').length).toBe(2);
    });
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() => {
      expect(approvalsApi.approve).toHaveBeenCalledWith('appr-001-abcdef12');
    });
  });

  it('calls reject API when Reject button is clicked', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getAllByText('Reject').length).toBe(2);
    });
    fireEvent.click(screen.getAllByText('Reject')[0]);
    await waitFor(() => {
      expect(approvalsApi.reject).toHaveBeenCalledWith('appr-001-abcdef12');
    });
  });

  it('reloads data after successful approve', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getAllByText('Approve').length).toBe(2);
    });
    // loadData is called once on mount + once after approve
    const callCountBefore = approvalsApi.listPending.mock.calls.length;
    fireEvent.click(screen.getAllByText('Approve')[0]);
    await waitFor(() => {
      expect(approvalsApi.listPending.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });

  it('reloads data after successful reject', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getAllByText('Reject').length).toBe(2);
    });
    const callCountBefore = approvalsApi.listPending.mock.calls.length;
    fireEvent.click(screen.getAllByText('Reject')[0]);
    await waitFor(() => {
      expect(approvalsApi.listPending.mock.calls.length).toBeGreaterThan(callCountBefore);
    });
  });

  it('displays truncated IDs in the table', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // truncateId takes first 8 chars
      expect(screen.getByText('appr-001')).toBeInTheDocument();
      expect(screen.getByText('appr-002')).toBeInTheDocument();
    });
  });

  it('displays task ID references', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // task_id is truncated and shown as "Task: xxxxxxxx"
      expect(screen.getByText('Task: task-999')).toBeInTheDocument();
    });
  });
});
