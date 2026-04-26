import { render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import OperationsPerf from './OperationsPerf';

beforeEach(() => { vi.restoreAllMocks(); });

test('renders counter table when fetch succeeds', async () => {
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      ok: true,
      counters: {
        listTasksParsed: 42,
        listTasksRaw: 7,
        capabilitySetBuilt: 3,
        pragmaCostBudgets: 1,
        pragmaPackRegistry: 0,
      },
    }),
  });
  render(<OperationsPerf />);
  await waitFor(() => screen.getByText('42'));
  expect(screen.getByText('listTasks (parsed)')).toBeInTheDocument();
  expect(screen.getByText('42')).toBeInTheDocument();
});

test('shows loading state before fetch resolves', () => {
  global.fetch = vi.fn(() => new Promise(() => {})); // never resolves
  render(<OperationsPerf />);
  expect(screen.getByText(/loading/i)).toBeInTheDocument();
});

test('shows error state when fetch fails', async () => {
  global.fetch = vi.fn().mockRejectedValue(new Error('network failure'));
  render(<OperationsPerf />);
  await waitFor(() => screen.getByText(/error/i));
  expect(screen.getByText(/error/i)).toBeInTheDocument();
});
