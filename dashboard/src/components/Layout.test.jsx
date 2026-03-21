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
            <Route path="settings" element={<div>Project Settings Content</div>} />
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
    expect(h1).toBeInTheDocument();
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
    const settingsLinks = screen.getAllByText('Project Settings');
    expect(settingsLinks.length).toBeGreaterThanOrEqual(1);
  });

  it('renders child route content', () => {
    renderLayout({}, '/');
    expect(screen.getByText('Kanban Content')).toBeInTheDocument();
  });

  it('shows connected status', () => {
    renderLayout({ isConnected: true });
    expect(screen.getByLabelText('Connection status: connected')).toBeInTheDocument();
  });

  it('shows reconnecting status', () => {
    renderLayout({ isConnected: false, isReconnecting: true });
    expect(screen.getByLabelText('Connection status: reconnecting')).toBeInTheDocument();
  });

  it('shows disconnected status', () => {
    renderLayout({ isConnected: false, isReconnecting: false });
    expect(screen.getByLabelText('Connection status: disconnected')).toBeInTheDocument();
  });

  it('shows notification badge when alerts exist', () => {
    renderLayout({ failedCount: 3, stuckCount: 2 });
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('shows 9+ for large alert counts', () => {
    renderLayout({ failedCount: 7, stuckCount: 5 });
    expect(screen.getByText('9+')).toBeInTheDocument();
  });

  it('shows breadcrumb for current route', () => {
    renderLayout({}, '/providers');
    // The breadcrumb renders "TORQUE / Providers" — Providers text exists in breadcrumb
    const providersElements = screen.getAllByText('Providers');
    // At least one is the breadcrumb (font-medium class)
    const breadcrumb = providersElements.find(el => el.className.includes('font-medium'));
    expect(breadcrumb).toBeInTheDocument();
  });

  it('shows keyboard shortcut hint', () => {
    renderLayout();
    expect(screen.getByText('?')).toBeInTheDocument();
  });

  it('renders all navigation items from route config', () => {
    renderLayout();
    expect(screen.getByText('Workflows')).toBeInTheDocument();
    expect(screen.getByText('Infrastructure')).toBeInTheDocument();
    expect(screen.getByText('Operations')).toBeInTheDocument();
    expect(screen.getByText('Project Settings')).toBeInTheDocument();
    expect(screen.queryByText('Batches')).toBeNull();
    expect(screen.queryByText('Projects')).toBeNull();
    expect(screen.queryByText('Hosts')).toBeNull();
    expect(screen.queryByText('Budget')).toBeNull();
    expect(screen.queryByText('Models')).toBeNull();
  });

  it('shows breadcrumb for project settings route', () => {
    renderLayout({}, '/settings');
    const settingsElements = screen.getAllByText('Project Settings');
    const breadcrumb = settingsElements.find(el => el.className.includes('font-medium'));
    expect(breadcrumb).toBeInTheDocument();
  });

  it('does not show notification badge when no alerts', () => {
    renderLayout({ failedCount: 0, stuckCount: 0 });
    // The bell icon exists but no count badge
    const bellButton = screen.getByLabelText('Notifications: no alerts');
    expect(bellButton).toBeInTheDocument();
    // No badge number should appear in the bell area
    expect(bellButton.querySelector('.bg-red-500')).toBeNull();
  });

  it('renders collapse button with aria-label in sidebar header', () => {
    renderLayout();
    const collapseBtn = screen.getByLabelText('Collapse sidebar');
    const header = collapseBtn.closest('[data-testid="sidebar-header"]');
    expect(header).toBeInTheDocument();
  });

  it('renders connection indicator in sidebar header', () => {
    renderLayout({ isConnected: true });
    const header = screen.getByTestId('sidebar-header');
    expect(header).toContainElement(screen.getByLabelText('Connection status: connected'));
  });
});
