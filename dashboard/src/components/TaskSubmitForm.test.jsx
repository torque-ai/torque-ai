import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import TaskSubmitForm from './TaskSubmitForm';

vi.mock('../api', () => ({
  tasks: {
    submit: vi.fn(),
  },
  providers: {
    list: vi.fn(),
  },
  hosts: {
    list: vi.fn(),
  },
}));

import { tasks as tasksApi, providers as providersApi, hosts as hostsApi } from '../api';

const mockProviders = [
  { provider: 'codex', enabled: true, stats: {} },
  { provider: 'ollama', enabled: true, stats: {} },
  { provider: 'hashline-ollama', enabled: true, stats: {} },
  { provider: 'deepinfra', enabled: false, stats: {} },
  { provider: 'claude-cli', enabled: true, stats: {} },
];

const mockHosts = [
  {
    name: 'remote-gpu-host',
    enabled: true,
    models: ['qwen2.5-coder:32b', 'codestral:22b'],
    status: 'healthy',
  },
  {
    name: 'DisabledHost',
    enabled: false,
    models: ['llama3:8b'],
    status: 'down',
  },
];

describe('TaskSubmitForm', () => {
  beforeEach(() => {
    providersApi.list.mockResolvedValue(mockProviders);
    hostsApi.list.mockResolvedValue(mockHosts);
    tasksApi.submit.mockResolvedValue({ success: true, task_id: 'task-abc123' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders form with provider and model dropdowns', async () => {
    renderWithProviders(<TaskSubmitForm />);

    // Form exists
    expect(screen.getByTestId('task-submit-form')).toBeInTheDocument();

    // Main elements — heading says "Submit Task", button also says "Submit Task"
    expect(screen.getAllByText('Submit Task').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByLabelText(/Task Description/)).toBeInTheDocument();
    expect(screen.getByLabelText('Provider')).toBeInTheDocument();
    expect(screen.getByLabelText('Model')).toBeInTheDocument();
    expect(screen.getByLabelText('Working Directory')).toBeInTheDocument();
  });

  it('populates provider dropdown from API', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      const providerSelect = screen.getByLabelText('Provider');
      // Check auto option exists
      const options = providerSelect.querySelectorAll('option');
      const optionValues = [...options].map((o) => o.value);
      expect(optionValues).toContain('auto');
      expect(optionValues).toContain('codex');
      expect(optionValues).toContain('ollama');
      expect(optionValues).toContain('deepinfra');
    });
  });

  it('shows disabled label for disabled providers', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      const providerSelect = screen.getByLabelText('Provider');
      const deepinfraOption = [...providerSelect.querySelectorAll('option')].find(
        (o) => o.value === 'deepinfra'
      );
      expect(deepinfraOption).toBeInTheDocument();
      expect(deepinfraOption.disabled).toBe(true);
      expect(deepinfraOption.textContent).toContain('(disabled)');
    });
  });

  it('model dropdown is disabled when provider is auto', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      const modelInput = screen.getByLabelText('Model');
      expect(modelInput.disabled).toBe(true);
    });
  });

  it('updates available models when provider changes to ollama', async () => {
    renderWithProviders(<TaskSubmitForm />);

    // Wait for providers and hosts to load
    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalled();
      expect(hostsApi.list).toHaveBeenCalled();
    });

    // Change provider to ollama
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });

    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Model');
      expect(modelSelect.disabled).toBe(false);
      const options = [...modelSelect.querySelectorAll('option')];
      const optionValues = options.map((o) => o.value);
      // Should have Default + ollama host models (from enabled hosts only)
      expect(optionValues).toContain('');
      expect(optionValues).toContain('qwen2.5-coder:32b');
      expect(optionValues).toContain('codestral:22b');
      // Models from disabled host should NOT appear
      expect(optionValues).not.toContain('llama3:8b');
    });
  });

  it('updates available models when provider changes to deepinfra', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalled();
    });

    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'deepinfra' } });

    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Model');
      const options = [...modelSelect.querySelectorAll('option')];
      const optionValues = options.map((o) => o.value);
      expect(optionValues).toContain('Qwen/Qwen2.5-72B-Instruct');
      expect(optionValues).toContain('meta-llama/Llama-3.1-405B-Instruct');
    });
  });

  it('resets model when provider changes', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalled();
    });

    // Select ollama and pick a model
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'ollama' } });

    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Model');
      fireEvent.change(modelSelect, { target: { value: 'qwen2.5-coder:32b' } });
      expect(modelSelect.value).toBe('qwen2.5-coder:32b');
    });

    // Switch to codex — model should reset
    fireEvent.change(providerSelect, { target: { value: 'codex' } });

    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Model');
      expect(modelSelect.value).toBe('');
    });
  });

  it('auto selection sends no provider override', async () => {
    renderWithProviders(<TaskSubmitForm />);

    // Fill in the task
    const textarea = screen.getByLabelText(/Task Description/);
    fireEvent.change(textarea, { target: { value: 'Write unit tests for MyService.ts' } });

    // Submit with auto
    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(tasksApi.submit).toHaveBeenCalledWith({
        task: 'Write unit tests for MyService.ts',
      });
    });
  });

  it('form submission includes selected provider and model', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalled();
    });

    // Fill in task
    const textarea = screen.getByLabelText(/Task Description/);
    fireEvent.change(textarea, { target: { value: 'Fix the login bug' } });

    // Select provider
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'codex' } });

    // Select model
    await waitFor(() => {
      const modelSelect = screen.getByLabelText('Model');
      fireEvent.change(modelSelect, { target: { value: 'gpt-5.3-codex-spark' } });
    });

    // Fill working directory
    const wdInput = screen.getByLabelText('Working Directory');
    fireEvent.change(wdInput, { target: { value: 'C:/Projects/MyApp' } });

    // Submit
    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(tasksApi.submit).toHaveBeenCalledWith({
        task: 'Fix the login bug',
        provider: 'codex',
        model: 'gpt-5.3-codex-spark',
        working_directory: 'C:/Projects/MyApp',
      });
    });
  });

  it('shows error toast when task is empty', async () => {
    renderWithProviders(<TaskSubmitForm />);

    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    // Button should be disabled when task is empty
    expect(submitBtn.disabled).toBe(true);
  });

  it('shows success toast on successful submission', async () => {
    const onSubmitted = vi.fn();
    const onClose = vi.fn();
    renderWithProviders(<TaskSubmitForm onSubmitted={onSubmitted} onClose={onClose} />);

    const textarea = screen.getByLabelText(/Task Description/);
    fireEvent.change(textarea, { target: { value: 'Run test suite' } });

    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(tasksApi.submit).toHaveBeenCalled();
      expect(onSubmitted).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('shows error toast on failed submission', async () => {
    tasksApi.submit.mockRejectedValue(new Error('Server error'));
    renderWithProviders(<TaskSubmitForm />);

    const textarea = screen.getByLabelText(/Task Description/);
    fireEvent.change(textarea, { target: { value: 'Do something' } });

    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(tasksApi.submit).toHaveBeenCalled();
    });

    // Form should still be visible (not closed on error)
    expect(screen.getByTestId('task-submit-form')).toBeInTheDocument();
  });

  it('shows submitting state while request is in flight', async () => {
    tasksApi.submit.mockReturnValue(new Promise(() => {})); // never resolves
    renderWithProviders(<TaskSubmitForm />);

    const textarea = screen.getByLabelText(/Task Description/);
    fireEvent.change(textarea, { target: { value: 'Long running task' } });

    const submitBtn = screen.getByRole('button', { name: /Submit Task/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText('Submitting...')).toBeInTheDocument();
    });
  });

  it('renders close button when onClose is provided', () => {
    const onClose = vi.fn();
    renderWithProviders(<TaskSubmitForm onClose={onClose} />);

    const closeBtn = screen.getByLabelText('Close submit form');
    expect(closeBtn).toBeInTheDocument();
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not render close button when onClose is not provided', () => {
    renderWithProviders(<TaskSubmitForm />);
    expect(screen.queryByLabelText('Close submit form')).toBeNull();
  });

  it('shows fallback text input for model when provider has no known models', async () => {
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      expect(providersApi.list).toHaveBeenCalled();
    });

    // Select hashline-openai which has no known models and no ollama hosts
    const providerSelect = screen.getByLabelText('Provider');
    fireEvent.change(providerSelect, { target: { value: 'hashline-openai' } });

    await waitFor(() => {
      const modelInput = screen.getByLabelText('Model');
      // Should be a text input, not a select
      expect(modelInput.tagName).toBe('INPUT');
      expect(modelInput.type).toBe('text');
    });
  });

  it('handles empty provider list gracefully', async () => {
    providersApi.list.mockResolvedValue([]);
    renderWithProviders(<TaskSubmitForm />);

    await waitFor(() => {
      const providerSelect = screen.getByLabelText('Provider');
      const options = providerSelect.querySelectorAll('option');
      // Should have auto + static fallback list
      expect(options.length).toBeGreaterThan(1);
    });
  });

  it('handles API errors gracefully', async () => {
    providersApi.list.mockRejectedValue(new Error('Network error'));
    hostsApi.list.mockRejectedValue(new Error('Network error'));
    renderWithProviders(<TaskSubmitForm />);

    // Form should still render
    await waitFor(() => {
      expect(screen.getByTestId('task-submit-form')).toBeInTheDocument();
    });
  });
});
