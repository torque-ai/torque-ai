import { screen, waitFor, fireEvent, within } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import Schedules from './Schedules';

vi.mock('../api', () => ({
  schedules: {
    list: vi.fn(),
    create: vi.fn(),
    toggle: vi.fn(),
    delete: vi.fn(),
  },
}));

import { schedules as schedulesApi } from '../api';

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
    schedulesApi.toggle.mockResolvedValue({});
    schedulesApi.delete.mockResolvedValue({});
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
    });
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
      expect(screen.getByText('Cron')).toBeInTheDocument();
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
