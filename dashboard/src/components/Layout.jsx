import { useState, useEffect, useRef } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import ErrorBoundary from './ErrorBoundary';
import ChangePasswordModal from './ChangePasswordModal';
// SessionSwitcher removed — multi-session switching no longer needed
// EconomyIndicator removed — economy mode replaced by routing templates
// HealthDots removed — connection status moved to sidebar header

const ROUTE_NAMES = {
  '/': 'Kanban',
  '/history': 'History',
  '/workflows': 'Workflows',
  '/providers': 'Providers',
  '/infrastructure': 'Infrastructure',
  '/operations': 'Operations',
  '/approvals': 'Approvals',
  '/factory': 'Factory',
  '/factory/intake': 'Factory',
  '/factory/health': 'Factory',
  '/factory/decisions': 'Factory',
  '/factory/policy': 'Factory',
  '/settings': 'Project Settings',
};

// Simple SVG icons as components
const KanbanIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7m0 10a2 2 0 002 2h2a2 2 0 002-2V7a2 2 0 00-2-2h-2a2 2 0 00-2 2" />
  </svg>
);

const HistoryIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const ChartIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
  </svg>
);

const FolderIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
  </svg>
);

const HostIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M5 12h14M5 12a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v4a2 2 0 01-2 2M5 12a2 2 0 00-2 2v4a2 2 0 002 2h14a2 2 0 002-2v-4a2 2 0 00-2-2m-2-4h.01M17 16h.01" />
  </svg>
);

const BatchIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
  </svg>
);

const WorkflowIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M4 6h4m-4 0a2 2 0 110-4 2 2 0 010 4zm0 0v6m0 0a2 2 0 100 4 2 2 0 000-4zm12-6h4m-4 0a2 2 0 110-4 2 2 0 010 4zm0 0v6m0 0a2 2 0 100 4 2 2 0 000-4zm-6-6h4m-4 0a2 2 0 110-4 2 2 0 010 4zm0 0v12m0 0a2 2 0 100 4 2 2 0 000-4z" />
  </svg>
);

const ModelIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
  </svg>
);

const ScheduleIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
  </svg>
);

const BudgetIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const ApprovalIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
  </svg>
);

const CoordIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const StrategicIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
  </svg>
);

const FactoryIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
  </svg>
);

const SettingsIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
      d="M11.983 5.333c.464-1.209 2.171-1.209 2.635 0a1.724 1.724 0 002.591.924c1.104-.664 2.312.544 1.648 1.648a1.724 1.724 0 00.924 2.591c1.209.464 1.209 2.171 0 2.635a1.724 1.724 0 00-.924 2.591c.664 1.104-.544 2.312-1.648 1.648a1.724 1.724 0 00-2.591.924c-.464 1.209-2.171 1.209-2.635 0a1.724 1.724 0 00-2.591-.924c-1.104.664-2.312-.544-1.648-1.648a1.724 1.724 0 00-.924-2.591c-1.209-.464-1.209-2.171 0-2.635a1.724 1.724 0 00.924-2.591c-.664-1.104.544-2.312 1.648-1.648a1.724 1.724 0 002.591-.924z" />
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
  </svg>
);

const CollapseIcon = ({ collapsed }) => (
  <svg className={`w-4 h-4 transition-transform ${collapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 19l-7-7 7-7m8 14l-7-7 7-7" />
  </svg>
);

const BellIcon = () => (
  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
  </svg>
);

const navItems = [
  { to: '/', icon: KanbanIcon, label: 'Kanban' },
  { to: '/history', icon: HistoryIcon, label: 'History' },
  { to: '/workflows', icon: WorkflowIcon, label: 'Workflows' },
  { to: '/providers', icon: ChartIcon, label: 'Providers' },
  { to: '/infrastructure', icon: HostIcon, label: 'Infrastructure' },
  { to: '/operations', icon: StrategicIcon, label: 'Operations' },
  { to: '/approvals', icon: ApprovalIcon, label: 'Approvals' },
  { to: '/factory', icon: FactoryIcon, label: 'Factory' },
  { to: '/settings', icon: SettingsIcon, label: 'Project Settings' },
];

function NavItem({ to, icon, label, collapsed, badgeCount = 0 }) {
  const IconComponent = icon;
  const showBadge = badgeCount > 0;
  const badgeLabel = badgeCount > 99 ? '99+' : String(badgeCount);
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={collapsed ? label : undefined}
      className={({ isActive }) =>
        `relative flex items-center justify-between gap-3 px-4 ${collapsed ? 'md:justify-center md:px-2 md:gap-0' : ''} py-2.5 rounded-lg transition-all text-sm ${
          isActive
            ? 'bg-blue-600/20 text-blue-400 font-medium border border-blue-500/30'
            : 'text-slate-400 hover:bg-slate-700/50 hover:text-white border border-transparent'
        }`
      }
    >
      <span className={`flex min-w-0 items-center gap-3 ${collapsed ? 'md:gap-0' : ''}`}>
        <IconComponent />
        <span className={collapsed ? 'md:hidden' : ''}>{label}</span>
      </span>
      {showBadge && (
        <>
          <span className={`inline-flex min-w-6 items-center justify-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-semibold text-amber-300 ${collapsed ? 'md:hidden' : ''}`}>
            {badgeLabel}
          </span>
          <span className={`absolute right-1.5 top-1.5 min-w-5 items-center justify-center rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 ${collapsed ? 'hidden md:flex' : 'hidden'}`}>
            {badgeLabel}
          </span>
        </>
      )}
    </NavLink>
  );
}

function getInitialCollapsed() {
  try {
    return localStorage.getItem('torque-sidebar-collapsed') === 'true';
  } catch {
    return false;
  }
}

function PausedFactoryBanner() {
  const navigate = useNavigate();
  const [pausedProjects, setPausedProjects] = useState([]);
  const [dismissedKey, setDismissedKey] = useState('');

  useEffect(() => {
    let active = true;

    async function loadPausedProjects() {
      try {
        const csrfToken = window.__torqueCsrf;
        const response = await fetch('/api/v2/factory/projects', {
          credentials: 'same-origin',
          ...(csrfToken ? { headers: { 'X-CSRF-Token': csrfToken } } : {}),
        });
        if (!response.ok) throw new Error('Failed to load factory projects');

        const data = await response.json();
        const paused = Array.isArray(data?.projects)
          ? data.projects.filter((project) => project?.status === 'paused')
          : [];

        if (active) setPausedProjects(paused);
      } catch {
        if (active) setPausedProjects([]);
      }
    }

    loadPausedProjects();
    const intervalId = setInterval(loadPausedProjects, 30000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  const currentKey = pausedProjects
    .map((project) => String(project.id))
    .sort()
    .join(',');

  useEffect(() => {
    if (dismissedKey && dismissedKey !== currentKey) setDismissedKey('');
  }, [currentKey, dismissedKey]);

  if (!pausedProjects.length || dismissedKey === currentKey) return null;

  const pausedNames = pausedProjects
    .map((project) => project.name || project.id)
    .join(', ');

  return (
    <div className="bg-amber-500/10 border-b border-amber-500/30 text-amber-200 text-xs px-4 md:px-6 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate">Factory paused: {pausedNames}</span>
        <button
          type="button"
          onClick={() => navigate('/factory')}
          className="text-amber-100 hover:text-white transition-colors"
        >
          View Factory
        </button>
      </div>
      <button
        type="button"
        onClick={() => setDismissedKey(currentKey)}
        className="text-amber-300 hover:text-amber-100 p-1"
        aria-label="Dismiss paused factory banner"
      >
        X
      </button>
    </div>
  );
}

function getSecurityWarningFromStatus(payload) {
  const status = payload?.data && typeof payload.data === 'object' ? payload.data : payload;
  const warning = status?.security_warning || status?.security?.warning;
  return typeof warning === 'string' && warning.trim() ? warning.trim() : null;
}

function SecurityWarningBanner() {
  const [warning, setWarning] = useState(null);

  useEffect(() => {
    let active = true;

    async function loadSecurityStatus() {
      try {
        const response = await fetch('/api/v2/system/status', { credentials: 'same-origin' });
        if (!response.ok) throw new Error('Failed to load system status');
        const data = await response.json();
        if (active) setWarning(getSecurityWarningFromStatus(data));
      } catch {
        if (active) setWarning(null);
      }
    }

    loadSecurityStatus();
    const intervalId = setInterval(loadSecurityStatus, 60000);

    return () => {
      active = false;
      clearInterval(intervalId);
    };
  }, []);

  if (!warning) return null;

  return (
    <div className="bg-red-500/10 border-b border-red-500/30 text-red-100 text-xs px-4 md:px-6 py-2" role="status">
      {warning}
    </div>
  );
}


export default function Layout({ isConnected, isReconnecting, failedCount = 0, stuckCount = 0, pendingApprovalCount = 0 }) {
  const [collapsed, setCollapsed] = useState(getInitialCollapsed);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [showStatus, setShowStatus] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const userMenuRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const currentRoute = ROUTE_NAMES[location.pathname] || '';
  const alertCount = failedCount + stuckCount;

  // Close mobile sidebar on route change
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMobileOpen(false);
  }, [location.pathname]);

  // Close user menu on click outside
  useEffect(() => {
    if (!showUserMenu) return;
    function handleClick(e) {
      if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setShowUserMenu(false);
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showUserMenu]);

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem('torque-sidebar-collapsed', String(next)); } catch { /* ignore */ }
      return next;
    });
  }

  return (
    <div className="flex min-h-screen w-full">
      {/* Mobile sidebar overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/50 backdrop-blur-sm z-30 md:hidden animate-fade-in"
          role="button"
          tabIndex={0}
          aria-label="Close sidebar"
          onClick={() => setMobileOpen(false)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') setMobileOpen(false); }}
        />
      )}

      {/* Sidebar: on mobile fixed overlay w-60; on desktop static with collapse */}
      <aside className={`w-60 ${collapsed ? 'md:w-16' : 'md:w-60'} bg-slate-900/80 border-r border-slate-800 flex flex-col backdrop-blur-sm transition-all duration-200 fixed inset-y-0 left-0 z-40 md:static ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0`}>
        {/* Header: Logo + Connection + Collapse */}
        <div data-testid="sidebar-header" className={`p-4 ${collapsed ? 'md:p-3' : ''} border-b border-slate-800 relative`}>
          <div className={`flex items-center ${collapsed ? 'md:flex-col md:gap-2' : 'justify-between'}`}>
            <div className={collapsed ? 'md:hidden' : ''}>
              <h1 className="text-xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent tracking-tight">
                TORQUE
              </h1>
              <p className="text-[11px] text-slate-500 mt-0.5 tracking-wide">Task Orchestration</p>
            </div>
            {collapsed && (
              <span className="hidden md:block text-lg font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">T</span>
            )}
            <div className={`flex items-center gap-2 ${collapsed ? 'md:gap-1.5' : ''}`}>
              <button
                onClick={() => setShowStatus((s) => !s)}
                title={isConnected ? 'Connected' : isReconnecting ? 'Reconnecting' : 'Disconnected'}
                aria-label={isConnected ? 'Connection status: connected' : isReconnecting ? 'Connection status: reconnecting' : 'Connection status: disconnected'}
                className="p-1 rounded hover:bg-slate-700/50 transition-colors"
              >
                <span
                  aria-hidden="true"
                  className={`block w-2 h-2 rounded-full shrink-0 ${
                    isConnected ? 'bg-green-500 pulse-dot' : isReconnecting ? 'bg-yellow-500 animate-pulse' : 'bg-red-500'
                  }`}
                />
              </button>
              <button
                onClick={toggleCollapsed}
                className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-700/50 transition-colors hidden md:flex items-center justify-center"
                title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
                aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              >
                <CollapseIcon collapsed={collapsed} />
              </button>
            </div>
          </div>
          {/* Connection status text - expanded sidebar only */}
          <span className={`text-slate-400 text-xs mt-1 block ${collapsed ? 'md:hidden' : ''}`}>
            {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting...' : 'Disconnected'}
          </span>
          {/* Status panel popover - now drops down from header */}
          {showStatus && (
            <div className="absolute top-full left-2 right-2 mt-2 bg-slate-800 border border-slate-700 rounded-lg p-3 shadow-lg z-50">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-xs font-semibold text-white">System Status</h4>
                <button onClick={() => setShowStatus(false)} className="text-slate-500 hover:text-white" aria-label="Close status panel">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">WebSocket</span>
                  <span className={isConnected ? 'text-green-400' : isReconnecting ? 'text-yellow-400' : 'text-red-400'}>
                    {isConnected ? 'Connected' : isReconnecting ? 'Reconnecting' : 'Disconnected'}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Failed tasks</span>
                  <span className={failedCount > 0 ? 'text-red-400' : 'text-slate-300'}>{failedCount}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-slate-400">Stuck tasks</span>
                  <span className={stuckCount > 0 ? 'text-amber-400' : 'text-slate-300'}>{stuckCount}</span>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-3 space-y-1">
          {navItems.map((item) => (
            <NavItem
              key={item.to}
              {...item}
              collapsed={collapsed}
              badgeCount={item.to === '/approvals' ? pendingApprovalCount : 0}
            />
          ))}
        </nav>

      </aside>

      {/* Main content */}
      <main className="flex-1 bg-slate-900 overflow-auto flex flex-col min-w-0">
        <SecurityWarningBanner />
        <PausedFactoryBanner />
        {/* Top bar with breadcrumb and notification bell */}
        <div className="flex items-center justify-between px-4 md:px-6 py-3 border-b border-slate-800/50">
          <div className="flex items-center gap-2 text-sm">
            {/* Hamburger - mobile only */}
            <button
              onClick={() => setMobileOpen(true)}
              className="md:hidden p-1.5 -ml-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              aria-label="Open navigation menu"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <span className="text-slate-500">TORQUE</span>
            {currentRoute && (
              <>
                <span className="text-slate-600">/</span>
                <span className="text-slate-300 font-medium">{currentRoute}</span>
              </>
            )}
          </div>
          <div className="flex items-center gap-3">
            {/* Keyboard shortcut hint */}
            <span className="text-slate-600 text-xs hidden md:block">
              Press <kbd className="px-1 py-0.5 bg-slate-800 border border-slate-700 rounded text-[10px] font-mono">?</kbd> for shortcuts
            </span>
            {/* Notification bell */}
            <button
              onClick={() => navigate('/history?status=failed')}
              className="relative p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
              title={alertCount > 0 ? `${failedCount} failed, ${stuckCount} stuck` : 'No alerts'}
              aria-label={alertCount > 0 ? `Notifications: ${alertCount} alert${alertCount !== 1 ? 's' : ''} (${failedCount} failed, ${stuckCount} stuck)` : 'Notifications: no alerts'}
            >
              <BellIcon />
              {alertCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-red-500 text-white text-[9px] font-bold rounded-full flex items-center justify-center">
                  {alertCount > 9 ? '9+' : alertCount}
                </span>
              )}
            </button>
            {/* User menu */}
            <div className="relative" ref={userMenuRef}>
              <button
                onClick={() => setShowUserMenu(prev => !prev)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                title="Account"
                aria-label="Account menu"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </button>
              {showUserMenu && (
                <div className="absolute right-0 mt-2 w-48 bg-slate-800 border border-slate-700 rounded-lg shadow-lg py-1 z-50">
                  <button
                    onClick={() => { setShowUserMenu(false); setShowChangePassword(true); }}
                    className="w-full text-left px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 hover:text-white transition-colors"
                  >
                    Change Password
                  </button>
                  <hr className="border-slate-700 my-1" />
                  <button
                    onClick={async () => {
                      setShowUserMenu(false);
                      try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }); } catch {
                        // Best-effort logout; force a reload even if the request fails.
                      }
                      window.__torqueCsrf = null;
                      window.location.reload();
                    }}
                    className="w-full text-left px-4 py-2 text-sm text-red-400 hover:bg-slate-700 hover:text-red-300 transition-colors"
                  >
                    Sign Out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex-1 overflow-auto">
          <ErrorBoundary>
            <Outlet />
          </ErrorBoundary>
        </div>
      </main>

      {showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}
    </div>
  );
}
