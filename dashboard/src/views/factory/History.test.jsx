import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import History from './History';

vi.mock('../../api', () => ({
  factory: {
    intake: vi.fn(),
  },
  getDecisionLog: vi.fn(),
}));

vi.mock('date-fns', () => ({
  formatDistanceToNow: vi.fn(() => '5 minutes ago'),
}));

import { factory as factoryApi, getDecisionLog } from '../../api';

const selectedProject = {
  id: 'factory-1',
  name: 'torque-public',
};

const baseOutletContext = {
  selectedProject,
  projects: [selectedProject],
};

function renderHistory(outletContext = baseOutletContext) {
  return render(
    <MemoryRouter initialEntries={['/factory/history']}>
      <Routes>
        <Route path="/factory" element={<Outlet context={outletContext} />}>
          <Route path="history" element={<History />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}

function buildIntakeResponse(items, stats = {}) {
  return {
    items,
    stats: {
      completed: 0,
      shipped: 0,
      rejected: 0,
      ...stats,
    },
  };
}

describe('Factory History', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    factoryApi.intake.mockImplementation((_projectId, params = {}) => {
      const responses = {
        completed: buildIntakeResponse([], { completed: 0, shipped: 0, rejected: 0 }),
        shipped: buildIntakeResponse([], { completed: 0, shipped: 0, rejected: 0 }),
        rejected: buildIntakeResponse([], { completed: 0, shipped: 0, rejected: 0 }),
      };

      return Promise.resolve(responses[params.status] || buildIntakeResponse([]));
    });

    getDecisionLog.mockResolvedValue({ decisions: [] });
  });

  it('renders an empty state when there are no terminal work items', async () => {
    renderHistory();

    await waitFor(() => {
      expect(screen.getByText('No completed work items yet.')).toBeInTheDocument();
    });

    expect(factoryApi.intake).toHaveBeenCalledTimes(3);
    expect(factoryApi.intake).toHaveBeenCalledWith('factory-1', { status: 'completed', limit: 100 });
    expect(factoryApi.intake).toHaveBeenCalledWith('factory-1', { status: 'shipped', limit: 100 });
    expect(factoryApi.intake).toHaveBeenCalledWith('factory-1', { status: 'rejected', limit: 100 });
  });

  it('renders terminal rows and filters them by status pill', async () => {
    factoryApi.intake.mockImplementation((_projectId, params = {}) => {
      const responses = {
        completed: buildIntakeResponse([
          {
            id: 1,
            status: 'completed',
            title: 'Completed cleanup',
            description: 'Remove dead workflow branches',
            priority: 70,
            source: 'manual',
            batch_id: 'batch-completed-001',
            updated_at: '2026-04-14T11:00:00Z',
          },
        ], { completed: 1, shipped: 1, rejected: 1 }),
        shipped: buildIntakeResponse([
          {
            id: 2,
            status: 'shipped',
            title: 'Shipped feature',
            description: 'Release the factory dashboard update',
            priority: 90,
            source: 'plan_file',
            batch_id: 'batch-shipped-001',
            updated_at: '2026-04-14T12:00:00Z',
          },
        ], { completed: 1, shipped: 1, rejected: 1 }),
        rejected: buildIntakeResponse([
          {
            id: 3,
            status: 'rejected',
            title: 'Rejected experiment',
            description: 'Skip a risky rewrite',
            priority: 40,
            source: 'manual',
            reject_reason: 'Out of scope',
            batch_id: null,
            updated_at: '2026-04-14T10:00:00Z',
          },
        ], { completed: 1, shipped: 1, rejected: 1 }),
      };

      return Promise.resolve(responses[params.status] || buildIntakeResponse([]));
    });

    const { container } = renderHistory();

    await waitFor(() => {
      expect(screen.getByText('Completed cleanup')).toBeInTheDocument();
      expect(screen.getByText('Shipped feature')).toBeInTheDocument();
      expect(screen.getByText('Rejected experiment')).toBeInTheDocument();
    });

    const tableRows = container.querySelectorAll('tbody > tr');
    expect(tableRows[0].textContent).toContain('Shipped feature');
    expect(tableRows[1].textContent).toContain('Completed cleanup');
    expect(tableRows[2].textContent).toContain('Rejected experiment');

    fireEvent.click(screen.getByRole('button', { name: /Rejected/i }));

    await waitFor(() => {
      expect(screen.getByText('Rejected experiment')).toBeInTheDocument();
      expect(screen.queryByText('Shipped feature')).not.toBeInTheDocument();
      expect(screen.queryByText('Completed cleanup')).not.toBeInTheDocument();
    });

    expect(screen.getByText('Out of scope')).toBeInTheDocument();
  });

  it('expands a batch row and loads matching decision history on demand', async () => {
    factoryApi.intake.mockImplementation((_projectId, params = {}) => {
      const responses = {
        completed: buildIntakeResponse([], { completed: 0, shipped: 1, rejected: 0 }),
        shipped: buildIntakeResponse([
          {
            id: 9,
            status: 'shipped',
            title: 'Batch-backed shipment',
            description: 'Ship the dashboard history view',
            priority: 95,
            source: 'plan_file',
            batch_id: 'batch-42',
            updated_at: '2026-04-14T12:30:00Z',
          },
        ], { completed: 0, shipped: 1, rejected: 0 }),
        rejected: buildIntakeResponse([], { completed: 0, shipped: 1, rejected: 0 }),
      };

      return Promise.resolve(responses[params.status] || buildIntakeResponse([]));
    });

    getDecisionLog.mockResolvedValue({
      decisions: [
        {
          id: 'decision-2',
          batch_id: 'batch-13',
          stage: 'execute',
          action: 'ignored',
          reasoning: 'Different batch',
          created_at: '2026-04-14T11:00:00Z',
        },
        {
          id: 'decision-1',
          batch_id: 'batch-42',
          stage: 'plan',
          action: 'queued',
          reasoning: 'Prepared the batch for release.',
          created_at: '2026-04-14T12:00:00Z',
        },
      ],
    });

    renderHistory();

    const shippedRowLabel = await screen.findByText('Batch-backed shipment');
    fireEvent.click(shippedRowLabel.closest('tr'));

    await waitFor(() => {
      expect(getDecisionLog).toHaveBeenCalledWith('factory-1', { limit: 200 });
    });

    const expandedPanel = await screen.findByText('Batch Decisions');
    const panel = expandedPanel.closest('div');

    expect(within(panel).getByText('Plan')).toBeInTheDocument();
    expect(within(panel).getByText(/Plan \[queued\]: Prepared the batch for release\./)).toBeInTheDocument();
    expect(within(panel).queryByText(/Different batch/)).not.toBeInTheDocument();
  });
});
