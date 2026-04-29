import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import TaskDetailDrawer from './TaskDetailDrawer';

// Mock the api module so TaskDetailDrawer's internal fetch calls work
vi.mock('../api', () => ({
  tasks: {
    get: vi.fn(),
    retry: vi.fn(),
    cancel: vi.fn(),
    approveSwitch: vi.fn(),
    rejectSwitch: vi.fn(),
    reassignProvider: vi.fn(),
    diff: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
  taskLogs: {
    get: vi.fn(),
  },
}));

import { tasks as tasksApi, taskLogs, providers as providersApi } from '../api';

const mockTask = {
  id: 'task-1',
  description: 'Test task description',
  status: 'completed',
  provider: 'ollama',
  model: 'qwen3:8b',
  created_at: '2026-01-01T00:00:00Z',
  started_at: '2026-01-01T00:01:00Z',
  completed_at: '2026-01-01T00:05:00Z',
  output: 'Fallback task output',
  error_output: null,
};

const mockV2Diff = {
  task_id: 'task-1',
  files_changed: 2,
  changes: [
    {
      file: 'dashboard/src/components/TaskDetailDrawer.jsx',
      action: 'modified',
      lines_added: 12,
      lines_removed: 5,
    },
    {
      file: 'server/api/v2-task-handlers.js',
      action: 'added',
      lines_added: 3,
      lines_removed: 1,
    },
  ],
};

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TaskDetailDrawer', () => {
  beforeEach(() => {
    tasksApi.get.mockResolvedValue(mockTask);
    tasksApi.diff.mockResolvedValue(mockV2Diff);
    tasksApi.approveSwitch.mockResolvedValue({});
    tasksApi.rejectSwitch.mockResolvedValue({});
    tasksApi.reassignProvider.mockResolvedValue({});
    providersApi.list.mockResolvedValue([]);
    taskLogs.get.mockResolvedValue({
      task_id: 'task-1',
      status: 'completed',
      output: 'Hello output',
      error_output: null,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders nothing when taskId is null', () => {
    const { container } = renderWithProviders(<TaskDetailDrawer taskId={null} onClose={vi.fn()} />);
    // TaskDetailDrawer returns null when taskId is falsy
    // The ToastProvider still renders its container, so check no drawer overlay exists
    expect(container.querySelector('.drawer-overlay')).toBeNull();
    expect(container.querySelector('.animate-slide-in-right')).toBeNull();
  });

  it('calls subscribe on mount when provided', async () => {
    const subscribe = vi.fn();
    await act(async () => {
      renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} subscribe={subscribe} />);
    });
    expect(subscribe).toHaveBeenCalledWith('task-1');
  });

  it('calls unsubscribe on unmount when provided', async () => {
    const unsubscribe = vi.fn();
    let unmount;
    await act(async () => {
      ({ unmount } = renderWithProviders(
        <TaskDetailDrawer taskId="task-1" onClose={vi.fn()} unsubscribe={unsubscribe} />
      ));
    });
    await act(async () => {
      unmount();
    });
    expect(unsubscribe).toHaveBeenCalledWith('task-1');
  });

  it('calls onClose when Escape key pressed', async () => {
    const onClose = vi.fn();
    await act(async () => {
      renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={onClose} />);
    });
    // Escape listener is on the drawer element (focus trap), not document
    const drawer = document.querySelector('.animate-slide-in-right');
    await act(async () => {
      fireEvent.keyDown(drawer, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('fetches task data on mount', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(tasksApi.get).toHaveBeenCalledWith('task-1');
    });
  });

  it('fetches task logs on mount', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(taskLogs.get).toHaveBeenCalledWith('task-1');
    });
  });

  it('renders task description after loading', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Test task description')).toBeInTheDocument();
    });
  });

  it('falls back to legacy task_description when v2 description is missing', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      description: undefined,
      task_description: 'Legacy task description',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Legacy task description')).toBeInTheDocument();
    });
  });

  it('shows loading state initially', () => {
    // Make the API call hang so loading stays visible
    tasksApi.get.mockReturnValue(new Promise(() => {}));
    taskLogs.get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    expect(screen.getByTestId('loading-skeleton')).toBeInTheDocument();
  });

  it('renders task ID in header', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    // Shows truncated task ID: #task-1 (first 8 chars)
    await waitFor(() => {
      expect(screen.getByText('#task-1')).toBeInTheDocument();
    });
  });

  it('renders drawer overlay', async () => {
    await act(async () => {
      renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    });
    const overlay = document.querySelector('.drawer-overlay');
    expect(overlay).toBeInTheDocument();
  });

  it('renders tab buttons after loading', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('overview')).toBeInTheDocument();
      expect(screen.getByText('output')).toBeInTheDocument();
      expect(screen.getByText('diff')).toBeInTheDocument();
      expect(screen.getByText('timeline')).toBeInTheDocument();
    });
  });

  it('renders v2 task detail output in the output tab when logs omit stdout', async () => {
    taskLogs.get.mockResolvedValueOnce({
      task_id: 'task-1',
      status: 'completed',
      output: null,
      error_output: null,
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('Fallback task output')).toBeInTheDocument();
    });
  });

  it('renders v2 task logs output in the output tab', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('Hello output')).toBeInTheDocument();
    });
  });

  it('renders v2 stderr content in the output tab', async () => {
    taskLogs.get.mockResolvedValueOnce({
      task_id: 'task-1',
      status: 'completed',
      output: 'stdout line',
      error_output: 'stderr line',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('stdout line')).toBeInTheDocument();
      expect(screen.getByText('stderr')).toBeInTheDocument();
      expect(screen.getByText('stderr line')).toBeInTheDocument();
    });
  });

  it('renders persisted stream stderr chunks in the output tab', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      output: null,
      error_output: null,
    });
    taskLogs.get.mockResolvedValueOnce({
      task_id: 'task-1',
      status: 'running',
      output: null,
      error_output: null,
      stream_chunks: [
        {
          sequence_num: 4,
          chunk_type: 'stderr',
          chunk_data: 'codex stderr from stream table',
        },
      ],
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('stderr')).toBeInTheDocument();
      expect(screen.getByText('codex stderr from stream table')).toBeInTheDocument();
    });
  });

  it('renders live streaming stderr chunks in the output tab', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      output: null,
      error_output: null,
    });
    taskLogs.get.mockResolvedValueOnce({
      task_id: 'task-1',
      status: 'running',
      output: null,
      error_output: null,
      stream_chunks: [],
    });

    renderWithProviders(
      <TaskDetailDrawer
        taskId="task-1"
        onClose={vi.fn()}
        streamingOutput={[{ content: 'live codex stderr chunk', type: 'stderr', isStderr: true }]}
      />
    );

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('Streaming live output...')).toBeInTheDocument();
      expect(screen.getByText('stderr')).toBeInTheDocument();
      expect(screen.getByText('live codex stderr chunk')).toBeInTheDocument();
    });
  });

  it('shows an empty output state when v2 logs fields are blank', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      output: null,
      error_output: null,
    });
    taskLogs.get.mockResolvedValueOnce({
      task_id: 'task-1',
      status: 'completed',
      output: '',
      error_output: '',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('No output available')).toBeInTheDocument();
    });
  });

  it('shows host id and omits GPU status when host enrichment is missing', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      status: 'running',
      ollama_host_id: 'host-1',
      ollama_host_name: undefined,
      gpu_active: undefined,
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('host-1')).toBeInTheDocument();
    });

    expect(screen.queryByText('GPU')).toBeNull();
  });

  it('renders provider decision details from task detail responses', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      provider: 'anthropic',
      provider_decision_trace: {
        selected_provider: 'ollama',
        requested_provider: 'anthropic',
        user_provider_override: false,
        selected_at: '2026-01-01T00:00:30Z',
        switch_reason: 'anthropic -> ollama (budget exceeded)',
        fallback_candidates: [
          { provider: 'ollama', role: 'fallback' },
        ],
        blocked_candidates: [
          { provider: 'codex', blocked: true, blocked_reason: 'circuit_breaker_open' },
        ],
      },
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('Provider Decision')).toBeInTheDocument();
      expect(screen.getByText('Fallbacks')).toBeInTheDocument();
      expect(screen.getByText('Blocked')).toBeInTheDocument();
      expect(screen.getByText('anthropic -> ollama (budget exceeded)')).toBeInTheDocument();
      expect(screen.getByText('codex')).toBeInTheDocument();
      expect(screen.getAllByText('ollama').length).toBeGreaterThan(0);
    });
  });

  it('renders v2 task diff data in the diff tab', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('diff')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('diff').click();
    });

    await waitFor(() => {
      expect(tasksApi.diff).toHaveBeenCalledWith('task-1');
      expect(screen.getByText('2 files')).toBeInTheDocument();
      expect(screen.getByText('dashboard/src/components/TaskDetailDrawer.jsx')).toBeInTheDocument();
      expect(screen.getByText('server/api/v2-task-handlers.js')).toBeInTheDocument();
      expect(screen.getByText('modified')).toBeInTheDocument();
      expect(screen.getByText('added')).toBeInTheDocument();
      expect(screen.getAllByText('No inline patch available from v2 diff endpoint')).toHaveLength(2);
    });
  });

  it('renders legacy task diff payloads in the diff tab', async () => {
    tasksApi.diff.mockResolvedValueOnce({
      files_changed: 1,
      lines_added: 1,
      lines_removed: 1,
      diff_content: 'diff --git a/src/legacy.js b/src/legacy.js\n--- a/src/legacy.js\n+++ b/src/legacy.js\n-old value\n+new value',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('diff')).toBeInTheDocument();
    });

    await act(async () => {
      screen.getByText('diff').click();
    });

    await waitFor(() => {
      expect(screen.getByText('1 file')).toBeInTheDocument();
      expect(screen.getByText('--- a/src/legacy.js')).toBeInTheDocument();
      expect(screen.getByText('+new value')).toBeInTheDocument();
    });
  });

  it('refreshes the selected task when refreshTick changes', async () => {
    tasksApi.get
      .mockResolvedValueOnce(mockTask)
      .mockResolvedValueOnce({ ...mockTask, status: 'failed' });
    const initialCallCount = tasksApi.get.mock.calls.length;

    const { rerender } = renderWithProviders(
      <TaskDetailDrawer taskId="task-1" onClose={vi.fn()} refreshTick={0} />
    );

    await waitFor(() => {
      expect(tasksApi.get).toHaveBeenCalledTimes(initialCallCount + 1);
      expect(screen.getByText('completed')).toBeInTheDocument();
    });

    rerender(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} refreshTick={1} />);

    await waitFor(() => {
      expect(tasksApi.get).toHaveBeenCalledTimes(initialCallCount + 2);
      expect(screen.getByText('failed')).toBeInTheDocument();
    });
  });

  it('ignores stale task detail responses after switching tasks', async () => {
    const taskOne = createDeferred();
    const taskTwo = createDeferred();
    const logsOne = createDeferred();
    const logsTwo = createDeferred();

    tasksApi.get.mockImplementation((id) => {
      if (id === 'task-1') return taskOne.promise;
      if (id === 'task-2') return taskTwo.promise;
      throw new Error(`Unexpected task id ${id}`);
    });
    taskLogs.get.mockImplementation((id) => {
      if (id === 'task-1') return logsOne.promise;
      if (id === 'task-2') return logsTwo.promise;
      throw new Error(`Unexpected task id ${id}`);
    });

    const { rerender } = renderWithProviders(
      <TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />
    );

    rerender(<TaskDetailDrawer taskId="task-2" onClose={vi.fn()} />);

    taskTwo.resolve({
      ...mockTask,
      id: 'task-2',
      description: 'Second task description',
    });
    logsTwo.resolve({
      task_id: 'task-2',
      status: 'completed',
      output: 'Second task output',
      error_output: null,
    });

    await waitFor(() => {
      expect(screen.getByText('Second task description')).toBeInTheDocument();
    });

    taskOne.resolve({
      ...mockTask,
      id: 'task-1',
      description: 'First task description',
    });
    logsOne.resolve({
      task_id: 'task-1',
      status: 'completed',
      output: 'First task output',
      error_output: null,
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('Second task description')).toBeInTheDocument();
    expect(screen.queryByText('First task description')).toBeNull();
  });

  it('renders and routes Reject Switch for pending provider switch tasks', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      status: 'pending_provider_switch',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    const rejectButton = await screen.findByRole('button', { name: 'Reject Switch' });
    expect(screen.getByRole('button', { name: 'Approve Switch' })).toBeInTheDocument();

    fireEvent.click(rejectButton);

    await waitFor(() => {
      expect(tasksApi.rejectSwitch).toHaveBeenCalledWith('task-1');
    });
  });

  it('renders queued provider reassignment controls and submits the selected provider', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      status: 'queued',
      provider: null,
    });
    providersApi.list.mockResolvedValueOnce([
      { provider: 'codex', enabled: true },
      { provider: 'ollama', enabled: true },
    ]);

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    const select = await screen.findByLabelText('Reassign provider');
    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalledTimes(1);
      expect(select.value).toBe('codex');
      expect(screen.getByRole('button', { name: 'Reassign' }).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole('button', { name: 'Reassign' }));

    await waitFor(() => {
      expect(tasksApi.reassignProvider).toHaveBeenCalledWith('task-1', 'codex');
    });
  });

  it('ignores stale diff responses after switching tasks', async () => {
    const diffOne = createDeferred();
    const diffTwo = createDeferred();

    tasksApi.diff.mockImplementation((id) => {
      if (id === 'task-1') return diffOne.promise;
      if (id === 'task-2') {
        return diffTwo.promise;
      }
      throw new Error(`Unexpected task id ${id}`);
    });

    const { rerender } = renderWithProviders(
      <TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />
    );

    await waitFor(() => {
      expect(screen.getByText('diff')).toBeInTheDocument();
    }, { timeout: 3000 });

    await act(async () => {
      screen.getByText('diff').click();
    });

    rerender(<TaskDetailDrawer taskId="task-2" onClose={vi.fn()} />);

    // Wait for task-2 tabs to render (header appears before loading completes)
    await waitFor(() => {
      expect(screen.getByText('#task-2')).toBeInTheDocument();
      // Tabs only render after loading completes — verify they're present
      expect(screen.getAllByText('diff').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    await act(async () => {
      screen.getByText('diff').click();
    });

    diffTwo.resolve({
      task_id: 'task-2',
      files_changed: 1,
      changes: [
        {
          file: 'task-two.js',
          action: 'modified',
          lines_added: 4,
          lines_removed: 1,
        },
      ],
    });

    await waitFor(() => {
      expect(screen.getByText('task-two.js')).toBeInTheDocument();
    });

    diffOne.resolve({
      task_id: 'task-1',
      files_changed: 1,
      changes: [
        {
          file: 'task-one.js',
          action: 'modified',
          lines_added: 2,
          lines_removed: 2,
        },
      ],
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByText('task-two.js')).toBeInTheDocument();
    expect(screen.queryByText('task-one.js')).toBeNull();
  });
});
