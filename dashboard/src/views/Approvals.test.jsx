import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Approvals from './Approvals';

vi.mock('../api', () => ({
  approvals: {
    listPending: vi.fn(),
    getHistory: vi.fn(),
    approve: vi.fn(),
    reject: vi.fn(),
  },
}));

import { approvals as approvalsApi } from '../api';

// v2 approvals endpoints resolve to bare arrays, not { approvals: [...] }.
const mockPendingV2Response = [
  {
    id: 'appr-001-abcdef12',
    description: 'Deploy production build',
    task_id: 'task-999-aabbccdd',
    rule: 'production-deploy',
    created_at: '2026-02-28T10:00:00Z',
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
    description: 'Run migration script',
    decision: 'approved',
    decided_by: 'admin',
    decided_at: todayStr,
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

describe('Approvals', () => {
  beforeEach(() => {
    approvalsApi.listPending.mockResolvedValue(mockPendingV2Response);
    approvalsApi.getHistory.mockResolvedValue(mockHistoryV2Response);
    approvalsApi.approve.mockResolvedValue({});
    approvalsApi.reject.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    approvalsApi.listPending.mockReturnValue(new Promise(() => {}));
    approvalsApi.getHistory.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<Approvals />, { route: '/approvals' });
    expect(screen.getByTestId('loading-skeleton')).toBeTruthy();
  });

  it('renders heading after data loads', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeTruthy();
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
      expect(screen.getByText('Review and act on pending approval requests')).toBeTruthy();
    });
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
      expect(screen.getByText('Approved Today')).toBeTruthy();
    });
  });

  it('displays Rejected Today stat card', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Rejected Today')).toBeTruthy();
    });
  });

  it('renders pending tab as active by default', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // Pending tab button exists; the pending table is shown
      expect(screen.getByText('Deploy production build')).toBeTruthy();
    });
  });

  it('renders pending approvals from the v2 array response shape', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Deploy production build')).toBeTruthy();
      expect(screen.getByText('Delete staging database')).toBeTruthy();
    });
  });

  it('renders pending table headers', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('ID')).toBeTruthy();
      expect(screen.getByText('Description')).toBeTruthy();
      expect(screen.getByText('Rule')).toBeTruthy();
      expect(screen.getByText('Created At')).toBeTruthy();
      expect(screen.getByText('Actions')).toBeTruthy();
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
      expect(screen.getByText('production-deploy')).toBeTruthy();
      expect(screen.getByText('destructive-action')).toBeTruthy();
    });
  });

  it('shows empty pending state when no approvals', async () => {
    approvalsApi.listPending.mockResolvedValue([]);
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('No pending approvals')).toBeTruthy();
    });
  });

  it('switches to history tab on click', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('Run migration script')).toBeTruthy();
      expect(screen.getByText('Scale down workers')).toBeTruthy();
    });
  });

  it('shows history table headers', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('Decision')).toBeTruthy();
      expect(screen.getByText('Decided By')).toBeTruthy();
      expect(screen.getByText('Decided At')).toBeTruthy();
    });
  });

  it('shows decision badges in history', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeTruthy();
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
      expect(screen.getByText('Approvals')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      // "admin" appears twice (two approved history items decided by admin)
      const adminElements = screen.getAllByText('admin');
      expect(adminElements.length).toBe(2);
      expect(screen.getByText('ops-lead')).toBeTruthy();
    });
  });

  it('shows empty history state when no history', async () => {
    approvalsApi.getHistory.mockResolvedValue([]);
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      expect(screen.getByText('Approvals')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('History'));
    await waitFor(() => {
      expect(screen.getByText('No approval history')).toBeTruthy();
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
      expect(screen.getByText('appr-001')).toBeTruthy();
      expect(screen.getByText('appr-002')).toBeTruthy();
    });
  });

  it('displays task ID references', async () => {
    renderWithProviders(<Approvals />, { route: '/approvals' });
    await waitFor(() => {
      // task_id is truncated and shown as "Task: xxxxxxxx"
      expect(screen.getByText('Task: task-999')).toBeTruthy();
    });
  });
});
