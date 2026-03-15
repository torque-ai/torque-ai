import { screen, act, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders, mockFetch } from '../test-utils';
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
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
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
      expect(screen.getByText('Test task description')).toBeTruthy();
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
      expect(screen.getByText('Legacy task description')).toBeTruthy();
    });
  });

  it('shows loading state initially', () => {
    // Make the API call hang so loading stays visible
    tasksApi.get.mockReturnValue(new Promise(() => {}));
    taskLogs.get.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    expect(screen.getByText('Loading...')).toBeTruthy();
  });

  it('renders task ID in header', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    // Shows truncated task ID: #task-1 (first 8 chars)
    await waitFor(() => {
      expect(screen.getByText('#task-1')).toBeTruthy();
    });
  });

  it('renders drawer overlay', async () => {
    await act(async () => {
      renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    });
    const overlay = document.querySelector('.drawer-overlay');
    expect(overlay).toBeTruthy();
  });

  it('renders tab buttons after loading', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('overview')).toBeTruthy();
      expect(screen.getByText('output')).toBeTruthy();
      expect(screen.getByText('diff')).toBeTruthy();
      expect(screen.getByText('timeline')).toBeTruthy();
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
      expect(screen.getByText('output')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('Fallback task output')).toBeTruthy();
    });
  });

  it('renders v2 task logs output in the output tab', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('output')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('Hello output')).toBeTruthy();
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
      expect(screen.getByText('output')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('stdout line')).toBeTruthy();
      expect(screen.getByText('stderr')).toBeTruthy();
      expect(screen.getByText('stderr line')).toBeTruthy();
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
      expect(screen.getByText('output')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('output').click();
    });

    await waitFor(() => {
      expect(screen.getByText('No output available')).toBeTruthy();
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
      expect(screen.getByText('host-1')).toBeTruthy();
    });

    expect(screen.queryByText('GPU')).toBeNull();
  });

  it('renders v2 task diff data in the diff tab', async () => {
    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('diff')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('diff').click();
    });

    await waitFor(() => {
      expect(tasksApi.diff).toHaveBeenCalledWith('task-1');
      expect(screen.getByText('2 files')).toBeTruthy();
      expect(screen.getByText('dashboard/src/components/TaskDetailDrawer.jsx')).toBeTruthy();
      expect(screen.getByText('server/api/v2-task-handlers.js')).toBeTruthy();
      expect(screen.getByText('modified')).toBeTruthy();
      expect(screen.getByText('added')).toBeTruthy();
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
      expect(screen.getByText('diff')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('diff').click();
    });

    await waitFor(() => {
      expect(screen.getByText('1 file')).toBeTruthy();
      expect(screen.getByText('--- a/src/legacy.js')).toBeTruthy();
      expect(screen.getByText('+new value')).toBeTruthy();
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
      expect(screen.getByText('completed')).toBeTruthy();
    });

    rerender(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} refreshTick={1} />);

    await waitFor(() => {
      expect(tasksApi.get).toHaveBeenCalledTimes(initialCallCount + 2);
      expect(screen.getByText('failed')).toBeTruthy();
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
      expect(screen.getByText('Second task description')).toBeTruthy();
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

    expect(screen.getByText('Second task description')).toBeTruthy();
    expect(screen.queryByText('First task description')).toBeNull();
  });

  it('renders and routes Reject Switch for pending provider switch tasks', async () => {
    tasksApi.get.mockResolvedValueOnce({
      ...mockTask,
      status: 'pending_provider_switch',
    });

    renderWithProviders(<TaskDetailDrawer taskId="task-1" onClose={vi.fn()} />);

    const rejectButton = await screen.findByRole('button', { name: 'Reject Switch' });
    expect(screen.getByRole('button', { name: 'Approve Switch' })).toBeTruthy();

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
      expect(screen.getByText('diff')).toBeTruthy();
    });

    await act(async () => {
      screen.getByText('diff').click();
    });

    rerender(<TaskDetailDrawer taskId="task-2" onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('#task-2')).toBeTruthy();
    });

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
      expect(screen.getByText('task-two.js')).toBeTruthy();
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

    expect(screen.getByText('task-two.js')).toBeTruthy();
    expect(screen.queryByText('task-one.js')).toBeNull();
  });
});
