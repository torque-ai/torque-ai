import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import RoutingTemplates from './RoutingTemplates';

vi.mock('../api', () => ({
  requestV2: vi.fn().mockResolvedValue({}),
  providers: {
    list: vi.fn().mockResolvedValue([
      { id: 'ollama' }, { id: 'codex' }, { id: 'codex-spark' },
      { id: 'claude-cli' }, { id: 'anthropic' }, { id: 'deepinfra' },
    ]),
  },
  routingTemplates: {
    list: vi.fn().mockResolvedValue({
      items: [
        { id: 'preset-system-default', name: 'System Default', preset: true, rules: { default: 'ollama', security: 'anthropic', xaml_wpf: 'anthropic', architectural: 'deepinfra', reasoning: 'deepinfra', large_code_gen: 'codex', documentation: 'groq', simple_generation: 'ollama', targeted_file_edit: 'ollama' }, complexity_overrides: {} },
        { id: 'user-1', name: 'My Custom', preset: false, rules: { default: 'codex', security: 'codex', xaml_wpf: 'codex', architectural: 'codex', reasoning: 'codex', large_code_gen: 'codex', documentation: 'codex', simple_generation: 'codex', targeted_file_edit: 'codex' }, complexity_overrides: {} },
      ],
    }),
    getActive: vi.fn().mockResolvedValue({
      template: { id: 'preset-system-default', name: 'System Default', preset: true, rules: { default: 'ollama' }, complexity_overrides: {} },
      categories: [
        { key: 'security', displayName: 'Security', description: 'Auth tasks', keywords: 'auth, encrypt' },
        { key: 'default', displayName: 'Default', description: 'Catch-all', keywords: '' },
      ],
    }),
    categories: vi.fn().mockResolvedValue({
      items: [
        { key: 'security', displayName: 'Security', description: 'Auth tasks', keywords: 'auth, encrypt' },
        { key: 'default', displayName: 'Default', description: 'Catch-all', keywords: '' },
      ],
    }),
    create: vi.fn().mockResolvedValue({ id: 'new-1', name: 'New Template' }),
    setActive: vi.fn().mockResolvedValue({ message: 'Active template set' }),
  },
}));

vi.mock('../components/Toast', () => ({
  useToast: () => ({ success: vi.fn(), error: vi.fn() }),
}));

describe('RoutingTemplates', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('renders template selector with presets and user templates', async () => {
    render(<RoutingTemplates />);
    await waitFor(() => {
      expect(screen.getByText(/System Default/)).toBeInTheDocument();
    });
  });

  it('renders category rows', async () => {
    render(<RoutingTemplates />);
    await waitFor(() => {
      expect(screen.getByText(/Security/)).toBeInTheDocument();
    });
  });

  it('renders activate button', async () => {
    render(<RoutingTemplates />);
    await waitFor(() => {
      expect(screen.getByText(/Activate/i)).toBeInTheDocument();
    });
  });

  it('renders New and Duplicate buttons', async () => {
    render(<RoutingTemplates />);
    await waitFor(() => {
      expect(screen.getByText('New')).toBeInTheDocument();
      expect(screen.getByText('Duplicate')).toBeInTheDocument();
    });
  });
});
