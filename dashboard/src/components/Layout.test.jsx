import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ToastProvider } from './Toast';
import Layout from './Layout';

function renderLayout(props = {}, route = '/') {
  const defaultProps = { isConnected: true, isReconnecting: false, failedCount: 0, stuckCount: 0 };
  return render(
    <MemoryRouter initialEntries={[route]}>
      <ToastProvider>
        <Routes>
          <Route element={<Layout {...defaultProps} {...props} />}>
            <Route index element={<div>Kanban Content</div>} />
            <Route path="history" element={<div>History Content</div>} />
            <Route path="providers" element={<div>Providers Content</div>} />
          </Route>
        </Routes>
      </ToastProvider>
    </MemoryRouter>
  );
}

describe('Layout', () => {
  it('renders TORQUE branding in sidebar', () => {
    renderLayout();
    // TORQUE appears in both sidebar h1 and breadcrumb span — use getAllByText
    const torqueElements = screen.getAllByText('TORQUE');
    expect(torqueElements.length).toBeGreaterThanOrEqual(1);
    // The h1 branding element specifically
    const h1 = torqueElements.find(el => el.tagName === 'H1');
    expect(h1).toBeTruthy();
  });

  it('renders navigation items', () => {
    renderLayout();
    // Some items appear in both sidebar nav and breadcrumb — use getAllByText
    const kanbanLinks = screen.getAllByText('Kanban');
    expect(kanbanLinks.length).toBeGreaterThanOrEqual(1);
    const historyLinks = screen.getAllByText('History');
    expect(historyLinks.length).toBeGreaterThanOrEqual(1);
    const providersLinks = screen.getAllByText('Providers');
    expect(providersLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders child route content', () => {
    renderLayout({}, '/');
    expect(screen.getByText('Kanban Content')).toBeTruthy();
  });

  it('shows connected status', () => {
    renderLayout({ isConnected: true });
    expect(screen.getByText('Connected')).toBeTruthy();
  });

  it('shows reconnecting status', () => {
    renderLayout({ isConnected: false, isReconnecting: true });
    expect(screen.getByText('Reconnecting...')).toBeTruthy();
  });

  it('shows disconnected status', () => {
    renderLayout({ isConnected: false, isReconnecting: false });
    expect(screen.getByText('Disconnected')).toBeTruthy();
  });

  it('shows notification badge when alerts exist', () => {
    renderLayout({ failedCount: 3, stuckCount: 2 });
    expect(screen.getByText('5')).toBeTruthy();
  });

  it('shows 9+ for large alert counts', () => {
    renderLayout({ failedCount: 7, stuckCount: 5 });
    expect(screen.getByText('9+')).toBeTruthy();
  });

  it('shows breadcrumb for current route', () => {
    renderLayout({}, '/providers');
    // The breadcrumb renders "TORQUE / Providers" — Providers text exists in breadcrumb
    const providersElements = screen.getAllByText('Providers');
    // At least one is the breadcrumb (font-medium class)
    const breadcrumb = providersElements.find(el => el.className.includes('font-medium'));
    expect(breadcrumb).toBeTruthy();
  });

  it('shows keyboard shortcut hint', () => {
    renderLayout();
    expect(screen.getByText('?')).toBeTruthy();
  });

  it('renders all navigation items from route config', () => {
    renderLayout();
    // Verify core nav items are present
    expect(screen.getByText('Batches')).toBeTruthy();
    expect(screen.getByText('Hosts')).toBeTruthy();
    expect(screen.getByText('Workstations')).toBeTruthy();
    expect(screen.getByText('Budget')).toBeTruthy();
    expect(screen.getByText('Models')).toBeTruthy();
    expect(screen.getByText('Workflows')).toBeTruthy();
  });

  it('does not show notification badge when no alerts', () => {
    renderLayout({ failedCount: 0, stuckCount: 0 });
    // The bell icon exists but no count badge
    const bellButton = screen.getByLabelText('Notifications: no alerts');
    expect(bellButton).toBeTruthy();
    // No badge number should appear in the bell area
    expect(bellButton.querySelector('.bg-red-500')).toBeNull();
  });
});
