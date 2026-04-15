import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../test-utils';
import LoopControlBar from './LoopControlBar';

vi.mock('../../api', () => ({
  factory: {
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

import { factory as factoryApi } from '../../api';

const baseProject = {
  id: 'factory-1',
  name: 'torque-public',
  path: 'C:\\Users\\<os-user>\\Projects\\torque-public',
  status: 'running',
  trust_level: 'guided',
  loop_state: 'IDLE',
  loop_batch_id: null,
  loop_paused_at_stage: null,
  loop_last_action_at: null,
};

function renderLoopControlBar(overrides = {}) {
  const project = {
    ...baseProject,
    ...(overrides.project || {}),
  };

  return renderWithProviders(
    <LoopControlBar
      activeProjectAction={null}
      approvalsHref={null}
      handleToggleProject={vi.fn()}
      pendingApprovalCount={0}
      project={project}
      projects={[project]}
      selectedProjectId={project.id}
      setSelectedProjectId={vi.fn()}
    />,
    { route: '/factory' },
  );
}

describe('LoopControlBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    factoryApi.listLoopInstances.mockResolvedValue([]);
    factoryApi.startLoopInstance.mockResolvedValue({});
    factoryApi.loopInstanceStatus.mockResolvedValue({});
    factoryApi.advanceLoopInstance.mockResolvedValue({ job_id: 'job-1', status: 'running' });
    factoryApi.loopInstanceJobStatus.mockResolvedValue({ status: 'running' });
    factoryApi.approveGateInstance.mockResolvedValue({});
    factoryApi.rejectGateInstance.mockResolvedValue({});
    factoryApi.retryVerifyInstance.mockResolvedValue({});
  });

  it('shows an empty state when there are no active instances and no legacy loop', async () => {
    renderLoopControlBar();

    await waitFor(() => {
      expect(screen.getByTestId('loop-control-empty-state')).toHaveTextContent('No active loop instances for this project.');
    });

    expect(screen.queryAllByTestId('loop-instance-card')).toHaveLength(0);
    expect(screen.getByRole('button', { name: '+ Start New Instance' })).toBeInTheDocument();
    expect(factoryApi.listLoopInstances).toHaveBeenCalledWith('factory-1', { activeOnly: true });
  });

  it('renders multiple active instance cards', async () => {
    factoryApi.listLoopInstances.mockResolvedValue([
      {
        id: '11111111-1111-4111-8111-111111111111',
        project_id: 'factory-1',
        work_item_id: 41,
        batch_id: 'batch-sense-001',
        loop_state: 'SENSE',
        paused_at_stage: null,
        last_action_at: '2026-04-14T18:00:00Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        project_id: 'factory-1',
        work_item_id: 42,
        batch_id: 'batch-plan-002',
        loop_state: 'PLAN',
        paused_at_stage: 'PLAN',
        last_action_at: '2026-04-14T18:01:00Z',
      },
      {
        id: '33333333-3333-4333-8333-333333333333',
        project_id: 'factory-1',
        work_item_id: 43,
        batch_id: 'batch-verify-003',
        loop_state: 'VERIFY',
        paused_at_stage: 'VERIFY_FAIL',
        last_action_at: '2026-04-14T18:02:00Z',
      },
    ]);

    renderLoopControlBar();

    await waitFor(() => {
      expect(screen.getAllByTestId('loop-instance-card')).toHaveLength(3);
    });

    // PLAN text appears both as a state badge and as a dt/dd row; use getAllByText to tolerate.
    expect(screen.getAllByText('SENSE').length).toBeGreaterThan(0);
    expect(screen.getAllByText('PLAN').length).toBeGreaterThan(0);
    expect(screen.getAllByText('VERIFY').length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: '#41' })).toHaveAttribute('href', '/factory/intake#work-item-41');
    expect(screen.getByRole('button', { name: 'Retry Verify' })).toBeInTheDocument();
  });

  it('dispatches Advance against the selected instance id', async () => {
    const instanceId = '11111111-1111-4111-8111-111111111111';
    factoryApi.listLoopInstances.mockResolvedValue([
      {
        id: instanceId,
        project_id: 'factory-1',
        work_item_id: 41,
        batch_id: 'batch-sense-001',
        loop_state: 'SENSE',
        paused_at_stage: null,
        last_action_at: '2026-04-14T18:00:00Z',
      },
    ]);

    renderLoopControlBar();

    const card = await screen.findByTestId('loop-instance-card');
    fireEvent.click(within(card).getByRole('button', { name: 'Advance' }));

    await waitFor(() => {
      expect(factoryApi.advanceLoopInstance).toHaveBeenCalledWith(instanceId);
    });
  });

  it('starts a new instance for the selected project', async () => {
    renderLoopControlBar();

    fireEvent.click(await screen.findByRole('button', { name: '+ Start New Instance' }));

    await waitFor(() => {
      expect(factoryApi.startLoopInstance).toHaveBeenCalledWith('factory-1');
    });
  });

  it('renders the legacy fallback card and resolves actions through instance endpoints', async () => {
    const legacyProject = {
      ...baseProject,
      loop_state: 'PAUSED',
      loop_batch_id: 'batch-legacy-001',
      loop_paused_at_stage: 'PLAN',
      loop_last_action_at: '2026-04-14T18:10:00Z',
    };

    factoryApi.listLoopInstances.mockImplementation((_projectId, options = {}) => {
      if (options.activeOnly === true) {
        return Promise.resolve([]);
      }

      return Promise.resolve([
        {
          id: '44444444-4444-4444-8444-444444444444',
          project_id: 'factory-1',
          work_item_id: 99,
          batch_id: 'batch-legacy-001',
          loop_state: 'PLAN',
          paused_at_stage: 'PLAN',
          last_action_at: '2026-04-14T18:10:00Z',
          created_at: '2026-04-14T18:00:00Z',
          terminated_at: null,
        },
      ]);
    });

    renderLoopControlBar({ project: legacyProject });

    const legacyCard = await screen.findByTestId('loop-instance-card');
    expect(within(legacyCard).getByText('Legacy fallback')).toBeInTheDocument();

    fireEvent.click(within(legacyCard).getByRole('button', { name: 'Approve Gate' }));

    await waitFor(() => {
      expect(factoryApi.listLoopInstances).toHaveBeenCalledWith('factory-1', { activeOnly: false });
      expect(factoryApi.approveGateInstance).toHaveBeenCalledWith(
        '44444444-4444-4444-8444-444444444444',
        'PLAN',
      );
    });
  });
});
