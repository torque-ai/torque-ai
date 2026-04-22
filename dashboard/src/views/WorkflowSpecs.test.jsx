import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import WorkflowSpecs from './WorkflowSpecs';

vi.mock('../api', () => ({
  workflowSpecs: {
    list: vi.fn(),
    run: vi.fn(),
  },
}));

import { workflowSpecs } from '../api';

function renderView() {
  return render(
    <MemoryRouter>
      <WorkflowSpecs />
    </MemoryRouter>
  );
}

describe('WorkflowSpecs view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows empty state when no specs', async () => {
    workflowSpecs.list.mockResolvedValue({ specs: [] });
    renderView();
    await waitFor(() => expect(screen.getByText(/No workflow specs found/i)).toBeInTheDocument());
  });

  it('lists valid specs', async () => {
    workflowSpecs.list.mockResolvedValue({
      specs: [
        {
          name: 'deploy',
          relative_path: 'workflows/deploy.yaml',
          valid: true,
          task_count: 5,
          description: 'Deploy the app',
        },
      ],
    });
    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    expect(screen.getByText('5 tasks')).toBeInTheDocument();
  });

  it('shows error details for invalid specs', async () => {
    workflowSpecs.list.mockResolvedValue({
      specs: [
        {
          name: 'broken',
          relative_path: 'workflows/broken.yaml',
          valid: false,
          errors: ['missing tasks'],
          task_count: 0,
        },
      ],
    });
    renderView();
    await waitFor(() => expect(screen.getByText(/missing tasks/)).toBeInTheDocument());
  });

  it('runs a spec when Run button clicked', async () => {
    const user = userEvent.setup();
    workflowSpecs.list.mockResolvedValue({
      specs: [
        {
          name: 'deploy',
          relative_path: 'workflows/deploy.yaml',
          valid: true,
          task_count: 2,
        },
      ],
    });
    workflowSpecs.run.mockResolvedValue({ workflow_id: 'wf-123' });
    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() =>
      expect(workflowSpecs.run).toHaveBeenCalledWith('workflows/deploy.yaml', expect.anything())
    );
  });
});
