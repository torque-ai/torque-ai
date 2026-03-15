import { render, screen, act } from '@testing-library/react';
import { ToastProvider, useToast } from './Toast';

function TestComponent() {
  const toast = useToast();
  return (
    <div>
      <button onClick={() => toast.error('Error message')}>Show Error</button>
      <button onClick={() => toast.success('Success message')}>Show Success</button>
      <button onClick={() => toast.info('Info message')}>Show Info</button>
      <button onClick={() => toast.warning('Warning message')}>Show Warning</button>
    </div>
  );
}

describe('Toast', () => {
  it('throws when useToast is used outside ToastProvider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestComponent />)).toThrow('useToast must be used within ToastProvider');
    spy.mockRestore();
  });

  it('renders error toast when triggered', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Error').click(); });
    expect(screen.getByText('Error message')).toBeTruthy();
  });

  it('renders success toast when triggered', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Success').click(); });
    expect(screen.getByText('Success message')).toBeTruthy();
  });

  it('renders info toast when triggered', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Info').click(); });
    expect(screen.getByText('Info message')).toBeTruthy();
  });

  it('renders warning toast when triggered', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Warning').click(); });
    expect(screen.getByText('Warning message')).toBeTruthy();
  });

  it('auto-removes toast after timeout', async () => {
    vi.useFakeTimers();
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Success').click(); });
    expect(screen.getByText('Success message')).toBeTruthy();
    // success duration is 3000ms
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.queryByText('Success message')).toBeNull();
    vi.useRealTimers();
  });

  it('auto-removes error toast after 5s default', async () => {
    vi.useFakeTimers();
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Error').click(); });
    expect(screen.getByText('Error message')).toBeTruthy();
    // error duration is 5000ms — still visible at 4s
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.getByText('Error message')).toBeTruthy();
    // gone after 5s
    await act(async () => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByText('Error message')).toBeNull();
    vi.useRealTimers();
  });

  it('sets container aria-live to polite', () => {
    const { container } = render(<ToastProvider><TestComponent /></ToastProvider>);
    const toastContainer = container.querySelector('[aria-live="polite"][aria-label="Notifications"]');
    expect(toastContainer).not.toBeNull();
    expect(toastContainer.getAttribute('aria-live')).toBe('polite');
  });

  it('sets error toasts to role alert', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Error').click(); });
    const toastText = screen.getByText('Error message');
    const toastNode = toastText.closest('div');
    expect(toastNode).not.toBeNull();
    expect(toastNode.getAttribute('role')).toBe('alert');
  });

  it('sets success toasts to role status', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Success').click(); });
    const toastText = screen.getByText('Success message');
    const toastNode = toastText.closest('div');
    expect(toastNode).not.toBeNull();
    expect(toastNode.getAttribute('role')).toBe('status');
  });

  it('sets info toasts to role status', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Info').click(); });
    const toastText = screen.getByText('Info message');
    const toastNode = toastText.closest('div');
    expect(toastNode).not.toBeNull();
    expect(toastNode.getAttribute('role')).toBe('status');
  });

  it('sets dismiss button aria-label', async () => {
    render(<ToastProvider><TestComponent /></ToastProvider>);
    await act(async () => { screen.getByText('Show Success').click(); });
    expect(screen.getByLabelText('Dismiss notification')).toBeTruthy();
  });
});
