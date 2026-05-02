import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('shows loading skeleton while specs are loading', () => {
    workflowSpecs.list.mockReturnValue(new Promise(() => {}));
    renderView();
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('shows error state when the initial load fails', async () => {
    workflowSpecs.list.mockRejectedValue(new Error('network down'));
    renderView();
    await waitFor(() => expect(screen.getByText('Failed to load workflow specs')).toBeInTheDocument());
    expect(screen.getByText('network down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('recovers from initial load failure when retry succeeds', async () => {
    workflowSpecs.list
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({
        specs: [
          {
            name: 'recover',
            relative_path: 'workflows/recover.yaml',
            valid: true,
            task_count: 1,
          },
        ],
      });

    renderView();
    await waitFor(() => expect(screen.getByText(/retry/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('recover')).toBeInTheDocument());
    expect(screen.getByText('1 task')).toBeInTheDocument();
    expect(workflowSpecs.list).toHaveBeenCalledTimes(2);
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
    fireEvent.click(screen.getByRole('button', { name: /run/i }));
    await waitFor(() =>
      expect(workflowSpecs.run).toHaveBeenCalledWith('workflows/deploy.yaml', expect.anything())
    );
  });

  it('only marks the clicked spec as running', async () => {
    let resolveRun;
    workflowSpecs.list.mockResolvedValue({
      specs: [
        {
          name: 'deploy',
          relative_path: 'workflows/deploy.yaml',
          valid: true,
          task_count: 2,
        },
        {
          name: 'smoke',
          relative_path: 'workflows/smoke.yaml',
          valid: true,
          task_count: 1,
        },
      ],
    });
    workflowSpecs.run.mockImplementation(
      () => new Promise((resolve) => {
        resolveRun = resolve;
      })
    );

    renderView();
    await waitFor(() => expect(screen.getByText('deploy')).toBeInTheDocument());

    const runButtons = screen.getAllByRole('button', { name: /run/i });
    fireEvent.click(runButtons[0]);

    await waitFor(() => expect(screen.getAllByRole('button', { name: /running|run/i })[0]).toHaveTextContent('Running...'));
    const postRunButtons = screen.getAllByRole('button', { name: /running|run/i });
    expect(postRunButtons[0]).toHaveTextContent('Running...');
    expect(postRunButtons[1]).toHaveTextContent('Run');
    expect(postRunButtons[0]).toBeDisabled();
    expect(postRunButtons[1]).not.toBeDisabled();

    resolveRun({ workflow_id: 'wf-1' });
  });
});
