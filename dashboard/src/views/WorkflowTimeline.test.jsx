import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import { renderWithProviders } from '../test-utils';
import WorkflowTimeline from './WorkflowTimeline';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  workflows: {
    checkpoints: vi.fn(),
    fork: vi.fn(),
  },
}));

import { workflows as workflowsApi } from '../api';

const mockCheckpoints = [
  {
    checkpoint_id: 'cp-1',
    workflow_id: 'wf-1',
    step_id: 'plan',
    task_id: 'task-plan',
    state_version: 1,
    taken_at: '2026-04-23T20:00:00.000Z',
  },
  {
    checkpoint_id: 'cp-2',
    workflow_id: 'wf-1',
    step_id: 'debug',
    task_id: 'task-debug',
    state_version: 2,
    taken_at: '2026-04-23T20:10:00.000Z',
  },
];

function renderTimeline(route = '/workflows/wf-1/timeline') {
  return renderWithProviders(
    <Routes>
      <Route path="/workflows/:id/timeline" element={<WorkflowTimeline />} />
    </Routes>,
    { route },
  );
}

describe('WorkflowTimeline', () => {
  beforeEach(() => {
    workflowsApi.checkpoints.mockResolvedValue({ checkpoints: mockCheckpoints });
    workflowsApi.fork.mockResolvedValue({
      new_workflow_id: 'wf-fork-99',
      resumes_from_step: 'debug',
      cloned_step_count: 3,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads and renders workflow checkpoints', async () => {
    renderTimeline();

    await waitFor(() => {
      expect(workflowsApi.checkpoints).toHaveBeenCalledWith('wf-1');
      expect(screen.getByText('Workflow Timeline')).toBeInTheDocument();
      expect(screen.getByText('plan')).toBeInTheDocument();
      expect(screen.getByText('debug')).toBeInTheDocument();
    });
  });

  it('validates override JSON before forking', async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText('plan')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('plan'));
    fireEvent.change(screen.getByLabelText(/optional state overrides/i), {
      target: { value: '{"broken"' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));

    expect(workflowsApi.fork).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('State overrides must be valid JSON');
    });
  });

  it('forks from the selected checkpoint and renders the result', async () => {
    renderTimeline();

    await waitFor(() => {
      expect(screen.getByText('debug')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('debug'));
    fireEvent.change(screen.getByLabelText(/optional state overrides/i), {
      target: { value: '{\n  "resume_mode": "debug"\n}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create fork' }));

    await waitFor(() => {
      expect(workflowsApi.fork).toHaveBeenCalledWith('wf-1', {
        checkpoint_id: 'cp-2',
        state_overrides: { resume_mode: 'debug' },
      });
      expect(screen.getByText('Fork created')).toBeInTheDocument();
      expect(screen.getByText('Open fork timeline')).toBeInTheDocument();
      expect(screen.getAllByText(/wf-fork-99/).length).toBeGreaterThan(0);
    });
  });
});
