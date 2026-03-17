import { useState, useCallback, useRef, useMemo, useEffect, lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Routes, Route } from 'react-router-dom';
import Layout from './components/Layout';
import TaskDetailDrawer from './components/TaskDetailDrawer';
import { ToastProvider } from './components/Toast';
import { useKeyboardShortcuts, ShortcutHelpOverlay } from './components/KeyboardShortcuts';
import Onboarding from './components/Onboarding';
import Kanban from './views/Kanban';
import { useWebSocket } from './websocket';
import { hosts as hostsApi } from './api';
import ErrorBoundary from './components/ErrorBoundary';
import { useTick } from './hooks/useTick';

// Code-split secondary routes — only loaded when visited
const History = lazy(() => import('./views/History'));
const Providers = lazy(() => import('./views/Providers'));
const PlanProjects = lazy(() => import('./views/PlanProjects'));
const Hosts = lazy(() => import('./views/Hosts'));
const BatchHistory = lazy(() => import('./views/BatchHistory'));
const Budget = lazy(() => import('./views/Budget'));
const Models = lazy(() => import('./views/Models'));
const Workflows = lazy(() => import('./views/Workflows'));
const Schedules = lazy(() => import('./views/Schedules'));
const Approvals = lazy(() => import('./views/Approvals'));
const Coordination = lazy(() => import('./views/Coordination'));
const FreeTier = lazy(() => import('./views/FreeTier'));
const Strategic = lazy(() => import('./views/Strategic'));

function mergeTaskUpdates(prevTasks, incomingTasks) {
  const updates = new Map(
    (incomingTasks || [])
      .filter((task) => task?.id)
      .map((task) => [task.id, task])
  );

  if (updates.size === 0) {
    return prevTasks;
  }

  const merged = prevTasks.map((task) => {
    const update = updates.get(task.id);
    if (!update) {
      return task;
    }
    updates.delete(task.id);
    return { ...task, ...update };
  });

  if (updates.size > 0) {
    merged.push(...updates.values());
  }

  return merged;
}

function applyTaskLifecycleEvent(prevTasks, eventData) {
  if (!eventData?.taskId || !eventData?.status) {
    return prevTasks;
  }

  let didUpdate = false;
  const nextTasks = prevTasks.map((task) => {
    if (task.id !== eventData.taskId) {
      return task;
    }

    didUpdate = true;
    return {
      ...task,
      status: eventData.status,
      exit_code: eventData.exitCode ?? task.exit_code,
    };
  });

  return didUpdate ? nextTasks : prevTasks;
}

function AppInner() {
  const [tasks, setTasks] = useState([]);
  const [drawerTaskId, setDrawerTaskId] = useState(null);
  const [isOnboardingDismissed, setIsOnboardingDismissed] = useState(() => {
    try {
      return localStorage.getItem('torque-onboarding-dismissed') === 'true';
    } catch {
      return false;
    }
  });
  const [hostActivity, setHostActivity] = useState(null);
  const [streamingOutput, setStreamingOutput] = useState([]); // live output chunks from WebSocket
  const [statsVersion, setStatsVersion] = useState(0);
  const [tasksTick, setTasksTick] = useState(0);
  const [wsStats, setWsStats] = useState(null);
  const [workflowTick, setWorkflowTick] = useState(0);
  const [drawerRefreshTick, setDrawerRefreshTick] = useState(0);
  const drawerTaskIdRef = useRef(null);
  drawerTaskIdRef.current = drawerTaskId;
  const relativeTimeTick = useTick(30000);
  // eslint-disable-next-line react-hooks/purity, react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [relativeTimeTick]);

  // Handle WebSocket messages
  const handleMessage = useCallback((message) => {
    switch (message.event) {
      case 'task:created':
        setTasks((prev) => {
          if (!message.data?.id) {
            return prev;
          }
          return [message.data, ...prev.filter((task) => task.id !== message.data.id)];
        });
        setTasksTick((v) => v + 1);
        break;
      case 'tasks:batch-updated':
        setTasks((prev) => mergeTaskUpdates(prev, message.data));
        setTasksTick((v) => v + 1);
        break;
      case 'task:event':
        setTasks((prev) => applyTaskLifecycleEvent(prev, message.data));
        setTasksTick((v) => v + 1);
        if (message.data?.taskId === drawerTaskIdRef.current) {
          setDrawerRefreshTick((v) => v + 1);
        }
        break;
      case 'task:deleted':
        setTasks((prev) => prev.filter((t) => t.id !== message.data.taskId));
        setTasksTick((v) => v + 1);
        break;
      case 'hosts:activity-updated':
        setHostActivity(message.data);
        break;
      case 'stats:updated':
        setStatsVersion((v) => v + 1);
        setWsStats(message.data);
        break;
      case 'workflow:updated':
        setWorkflowTick((v) => v + 1);
        break;
      case 'task:output':
        // Forward streamed output to the drawer if it's for the open task
        if (message.data?.taskId === drawerTaskIdRef.current) {
          setStreamingOutput((prev) => [...prev, message.data.chunk]);
        }
        break;
      default:
        break;
    }
  }, []);

  const { isConnected, isReconnecting, instanceId, shortId, subscribe, unsubscribe } = useWebSocket(handleMessage);

  // Poll host activity via REST as fallback — WebSocket delivers hosts:activity-updated in real-time
  useEffect(() => {
    const controller = new AbortController();
    const poll = () => {
      hostsApi.activity({ signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setHostActivity(data);
        })
        .catch(() => {});
    };
    poll();
    const id = setInterval(poll, 60000);
    return () => {
      controller.abort();
      clearInterval(id);
    };
  }, []);

  const openDrawer = useCallback((taskId) => {
    setStreamingOutput([]);
    setDrawerTaskId(taskId);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerTaskId(null);
    setStreamingOutput([]);
  }, []);

  const dismissOnboarding = useCallback(() => {
    try {
      localStorage.setItem('torque-onboarding-dismissed', 'true');
    } catch {
      // ignore storage failures in restricted environments
    }
    setIsOnboardingDismissed(true);
  }, []);

  // Keyboard shortcuts (must be inside BrowserRouter for useNavigate)
  const { showHelp, setShowHelp } = useKeyboardShortcuts();

  // Derive alert counts for notification bell
  const failedCount = useMemo(() => tasks.filter((t) => t.status === 'failed').length, [tasks]);
  const runningCount = useMemo(() => tasks.filter((t) => t.status === 'running').length, [tasks]);
  const stuckCount = useMemo(() => {
    return tasks.filter((t) => t.status === 'running' && t.started_at && (now - new Date(t.started_at).getTime()) > 30 * 60 * 1000).length;
  }, [tasks, now]);

  // Dynamic page title
  useEffect(() => {
    const parts = [];
    if (runningCount > 0) parts.push(`${runningCount} running`);
    if (failedCount > 0) parts.push(`${failedCount} failed`);
    document.title = parts.length > 0 ? `TORQUE (${parts.join(', ')})` : 'TORQUE';
    return () => { document.title = 'TORQUE'; };
  }, [runningCount, failedCount]);

  // Dynamic favicon badge
  useEffect(() => {
    let link = document.querySelector("link[rel~='icon']");
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 32;
    const ctx = canvas.getContext('2d');
    // Base icon: "T" on dark background
    ctx.fillStyle = '#1e293b';
    ctx.beginPath(); ctx.arc(16, 16, 16, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3b82f6';
    ctx.font = 'bold 20px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('T', 16, 17);
    // Badge dot
    if (failedCount > 0) {
      ctx.fillStyle = '#ef4444';
      ctx.beginPath(); ctx.arc(26, 6, 6, 0, Math.PI * 2); ctx.fill();
    } else if (runningCount > 0) {
      ctx.fillStyle = '#22c55e';
      ctx.beginPath(); ctx.arc(26, 6, 5, 0, Math.PI * 2); ctx.fill();
    }
    link.href = canvas.toDataURL('image/png');
  }, [runningCount, failedCount]);

  return (
    <>
      <ErrorBoundary>
        <Suspense fallback={<div className="flex items-center justify-center h-screen text-slate-400">Loading...</div>}>
          <Routes>
            <Route element={<Layout isConnected={isConnected} isReconnecting={isReconnecting} failedCount={failedCount} stuckCount={stuckCount} instanceId={instanceId} shortId={shortId} />}>
              <Route
                index
                element={
                  <>
                    <Kanban tasks={tasks} onOpenDrawer={openDrawer} hostActivity={hostActivity} statsVersion={statsVersion} tasksTick={tasksTick} wsStats={wsStats} />
                    {!isOnboardingDismissed && tasks.length === 0 && (
                      <Onboarding onDismiss={dismissOnboarding} />
                    )}
                  </>
                }
              />
              <Route path="projects" element={<PlanProjects />} />
              <Route path="history" element={<History onOpenDrawer={openDrawer} relativeTimeTick={relativeTimeTick} />} />
              <Route path="batches" element={<BatchHistory onOpenDrawer={openDrawer} workflowTick={workflowTick} tasksTick={tasksTick} relativeTimeTick={relativeTimeTick} />} />
              <Route path="workflows" element={<Workflows onOpenDrawer={openDrawer} relativeTimeTick={relativeTimeTick} />} />
              <Route path="providers" element={<Providers statsVersion={statsVersion} tasksTick={tasksTick} />} />
              <Route path="models" element={<Models />} />
              <Route path="hosts" element={<Hosts hostActivity={hostActivity} />} />
              <Route path="workstations" element={<Navigate to="/hosts" replace />} />
              <Route path="budget" element={<Budget />} />
              <Route path="schedules" element={<Schedules />} />
              <Route path="approvals" element={<Approvals />} />
              <Route path="coordination" element={<Coordination />} />
              <Route path="free-tier" element={<FreeTier />} />
              <Route path="strategic" element={<Strategic />} />
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>

      {drawerTaskId && (
        <ErrorBoundary>
          <TaskDetailDrawer
            taskId={drawerTaskId}
            onClose={closeDrawer}
            subscribe={subscribe}
            unsubscribe={unsubscribe}
            streamingOutput={streamingOutput}
            refreshTick={drawerRefreshTick}
            relativeTimeTick={relativeTimeTick}
          />
        </ErrorBoundary>
      )}

      {showHelp && <ShortcutHelpOverlay onClose={() => setShowHelp(false)} />}
    </>
  );
}

function App() {
  return (
    <ToastProvider>
      <BrowserRouter>
        <AppInner />
      </BrowserRouter>
    </ToastProvider>
  );
}

export default App;
