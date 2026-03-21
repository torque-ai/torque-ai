import { render, screen, fireEvent, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

// Mock the api module
vi.mock('../api', () => ({
  providers: { list: vi.fn() },
  request: vi.fn(),
}));

import HealthBar from './HealthBar';
import { providers, request } from '../api';

const MOCK_PROVIDERS = [
  { id: 'codex', name: 'Codex', enabled: true, status: 'healthy' },
  { id: 'ollama', name: 'Ollama', enabled: true, status: 'healthy' },
  { id: 'deepinfra', name: 'DeepInfra', enabled: true, status: 'degraded' },
  { id: 'hyperbolic', name: 'Hyperbolic', enabled: true, status: 'unavailable' },
  { id: 'anthropic', name: 'Anthropic', enabled: false, status: 'disabled' },
];

describe('HealthBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    providers.list.mockResolvedValue(MOCK_PROVIDERS);
    request.mockResolvedValue({ tasks: [{ id: '1' }, { id: '2' }] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('renders compact bar with healthy count', async () => {
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('fetches from providers.list not provider-quotas', async () => {
    await act(async () => { render(<HealthBar />); });
    expect(providers.list).toHaveBeenCalled();
  });

  it('shows provider grid when clicked', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('deepinfra')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
  });

  it('shows status labels for non-healthy providers', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('degraded')).toBeInTheDocument();
    expect(screen.getByText('unavailable')).toBeInTheDocument();
    expect(screen.getByText('disabled')).toBeInTheDocument();
  });

  it('closes popover when clicking outside', async () => {
    await act(async () => { render(<HealthBar />); });
    const providerSection = screen.getByText('Providers:').closest('button');
    fireEvent.click(providerSection);
    expect(screen.getByText('codex')).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText('codex')).toBeNull();
  });

  it('shows "none" when zero providers returned', async () => {
    providers.list.mockResolvedValue([]);
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('shows "err" when API fails', async () => {
    providers.list.mockRejectedValue(new Error('Network error'));
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('err')).toBeInTheDocument();
  });

  it('handles { providers: [...] } envelope shape from V2 API', async () => {
    providers.list.mockResolvedValue({ providers: MOCK_PROVIDERS });
    await act(async () => { render(<HealthBar />); });
    expect(screen.getByText('2/5')).toBeInTheDocument();
  });

  it('handles provider field name instead of id (governance handler shape)', async () => {
    providers.list.mockResolvedValue([
      { provider: 'codex', enabled: true, status: 'healthy' },
      { provider: 'ollama', enabled: true, status: 'degraded' },
    ]);
    await act(async () => { render(<HealthBar />); });
    const btn = screen.getByText('Providers:').closest('button');
    fireEvent.click(btn);
    expect(screen.getByText('codex')).toBeInTheDocument();
    expect(screen.getByText('ollama')).toBeInTheDocument();
  });

  it('polls every 30 seconds', async () => {
    await act(async () => { render(<HealthBar />); });
    const callsAfterMount = providers.list.mock.calls.length;
    await act(async () => { vi.advanceTimersByTime(30000); });
    expect(providers.list.mock.calls.length - callsAfterMount).toBe(1);
  });
});
