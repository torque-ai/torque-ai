import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { tasks as tasksApi, taskLogs, providers as providersApi } from '../api';
import { useToast } from './Toast';
import { STATUS_BG_COLORS } from '../constants';
import LoadingSkeleton from './LoadingSkeleton';
import { parseAnsi } from '../utils/ansiToHtml';
import { getRelevantModel } from '../utils/providerModels';
import { formatDurationMs } from '../utils/formatters';
import { format } from 'date-fns';

function formatTime(iso) {
  if (!iso) return '-';
  try { return format(new Date(iso), 'MMM d, yyyy HH:mm:ss'); }
  catch { return String(iso); }
}

const STATUS_COLORS = {
  queued: STATUS_BG_COLORS.queued,
  running: STATUS_BG_COLORS.running,
  completed: STATUS_BG_COLORS.completed,
  failed: STATUS_BG_COLORS.failed,
  pending_provider_switch: STATUS_BG_COLORS.pending_provider_switch,
};

const COMMON_PROVIDER_OPTIONS = [
  'codex',
  'claude-cli',
  'ollama',
  'ollama-cloud',
  'anthropic',
  'cerebras',
  'groq',
  'deepinfra',
  'hyperbolic',
  'google-ai',
  'openrouter',
];

function buildProviderOptions(providerList, currentProvider) {
  const liveProviders = new Map(
    (Array.isArray(providerList) ? providerList : [])
      .map((entry) => {
        const provider = typeof entry === 'string' ? entry : entry?.provider;
        if (!provider) return null;
        return [
          provider,
          {
            value: provider,
            label: provider,
            enabled: typeof entry === 'object' ? entry.enabled !== false : true,
          },
        ];
      })
      .filter(Boolean)
  );

  const orderedProviders = [...COMMON_PROVIDER_OPTIONS];
  if (currentProvider && !orderedProviders.includes(currentProvider)) {
    orderedProviders.push(currentProvider);
  }

  return orderedProviders.map((provider) => liveProviders.get(provider) || {
    value: provider,
    label: provider,
    enabled: true,
  });
}

function isMeaningfulOutputChunk(chunk) {
  return getOutputChunkText(chunk) !== '';
}

function normalizeOutputChunks(source) {
  const nextOutput = source?.output;
  if (Array.isArray(nextOutput)) return nextOutput.filter(isMeaningfulOutputChunk);
  if (typeof nextOutput === 'string') return nextOutput ? [nextOutput] : [];
  if (nextOutput != null) return isMeaningfulOutputChunk(nextOutput) ? [nextOutput] : [];

  const legacyOutput = source?.output_chunks;
  if (Array.isArray(legacyOutput)) return legacyOutput.filter(isMeaningfulOutputChunk);
  if (typeof legacyOutput === 'string') return legacyOutput ? [legacyOutput] : [];
  if (legacyOutput != null) return isMeaningfulOutputChunk(legacyOutput) ? [legacyOutput] : [];

  return [];
}

function getOutputChunkText(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk === 'object') {
    if (typeof chunk.content === 'string') return chunk.content;
    if (typeof chunk.text === 'string') return chunk.text;
    return JSON.stringify(chunk);
  }
  return '';
}

function normalizeTextValue(value) {
  return typeof value === 'string' ? value : '';
}

function normalizeTaskLogs(logData, taskData) {
  const fallbackOutput = normalizeOutputChunks(taskData);
  const fallbackErrorOutput = normalizeTextValue(taskData?.error_output);

  if (logData && typeof logData === 'object' && !Array.isArray(logData)) {
    const output = normalizeOutputChunks(logData);
    const errorOutput = normalizeTextValue(logData.error_output);
    const timeline = Array.isArray(logData.logs)
      ? logData.logs.filter(Boolean)
      : Array.isArray(logData.timeline)
        ? logData.timeline.filter(Boolean)
        : [];
    return {
      timeline,
      output: output.length > 0 ? output : fallbackOutput,
      errorOutput: errorOutput || fallbackErrorOutput,
    };
  }

  if (Array.isArray(logData)) {
    return {
      timeline: logData,
      output: fallbackOutput,
      errorOutput: fallbackErrorOutput,
    };
  }

  return {
    timeline: [],
    output: fallbackOutput,
    errorOutput: fallbackErrorOutput,
  };
}

function getTaskDescription(taskData) {
  return taskData?.description || taskData?.task_description || '';
}

function getTaskHostLabel(taskData) {
  return taskData?.ollama_host_name || taskData?.ollama_host_id || '';
}

export default function TaskDetailDrawer({ taskId, onClose, subscribe, unsubscribe, streamingOutput = [], refreshTick = 0, relativeTimeTick = 0 }) {
  const [task, setTask] = useState(null);
  const [logs, setLogs] = useState([]);
  const [output, setOutput] = useState([]);
  const [errorOutput, setErrorOutput] = useState('');
  const [providerList, setProviderList] = useState([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [reassigning, setReassigning] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const toast = useToast();
  const outputEndRef = useRef(null);
  const mountedRef = useRef(true);
  const loadRequestIdRef = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const now = useMemo(() => Date.now(), [relativeTimeTick]);
  const providerOptions = useMemo(
    () => buildProviderOptions(providerList, task?.provider),
    [providerList, task?.provider]
  );

  const loadTask = useCallback(async () => {
    if (!taskId) return;
    const requestId = ++loadRequestIdRef.current;
    const isCurrentRequest = () => mountedRef.current && loadRequestIdRef.current === requestId;

    try {
      const [taskData, logData] = await Promise.all([
        tasksApi.get(taskId),
        taskLogs.get(taskId).catch(() => null),
      ]);
      if (!isCurrentRequest()) return;
      const normalizedLogs = normalizeTaskLogs(logData, taskData);
      setTask(taskData);
      setLogs(normalizedLogs.timeline);
      setOutput(normalizedLogs.output);
      setErrorOutput(normalizedLogs.errorOutput);
    } catch (err) {
      if (!isCurrentRequest()) return;
      console.error('Failed to load task:', err);
      toast.error('Failed to load task details');
    } finally {
      if (isCurrentRequest()) {
        setLoading(false);
      }
    }
  }, [taskId, toast]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      loadRequestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    if (refreshTick <= 0) setLoading(true);
    loadTask();
  }, [taskId, refreshTick, loadTask]);

  useEffect(() => {
    if (taskId && subscribe) {
      subscribe(taskId);
    }
    return () => {
      if (taskId && unsubscribe) {
        unsubscribe(taskId);
      }
    };
  }, [taskId, subscribe, unsubscribe]);

  useEffect(() => {
    if (task?.status !== 'queued') {
      setProviderList([]);
      return undefined;
    }

    let active = true;

    providersApi.list()
      .then((data) => {
        if (!active) return;
        setProviderList(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        console.error('Failed to load providers:', err);
        if (active) setProviderList([]);
      });

    return () => {
      active = false;
    };
  }, [task?.status]);

  useEffect(() => {
    if (task?.status !== 'queued') {
      setSelectedProvider('');
      return;
    }

    const defaultProvider = task?.provider
      || providerOptions.find((option) => option.enabled)?.value
      || providerOptions[0]?.value
      || '';

    setSelectedProvider(defaultProvider);
  }, [task?.id, task?.status, task?.provider, providerOptions]);

  // Close on Escape key
  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleAction(action) {
    try {
      let successMessage = 'Action completed';
      if (action === 'retry') {
        await tasksApi.retry(taskId);
        successMessage = 'Task queued for retry';
      } else if (action === 'cancel') {
        await tasksApi.cancel(taskId);
        successMessage = 'Task cancelled';
      } else if (action === 'approve-switch') {
        await tasksApi.approveSwitch(taskId);
        successMessage = 'Switch approved';
      } else if (action === 'reject-switch') {
        await tasksApi.rejectSwitch(taskId);
        successMessage = 'Switch rejected';
      }
      toast.success(successMessage);
      await loadTask();
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
      toast.error(`${action} failed: ${err.message}`);
    }
  }

  async function handleReassignProvider() {
    if (!taskId || !selectedProvider || selectedProvider === task?.provider) return;

    setReassigning(true);
    try {
      await tasksApi.reassignProvider(taskId, selectedProvider);
      toast.success(`Provider reassigned to ${selectedProvider}`);
      await loadTask();
    } catch (err) {
      console.error('Reassign failed:', err);
      toast.error(`Reassign failed: ${err.message}`);
    } finally {
      setReassigning(false);
    }
  }

  function exportTaskJSON() {
    const json = JSON.stringify(task, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `task-${taskId.substring(0, 8)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 100);
  }

  if (!taskId) return null;

  const elapsed = task?.started_at
    ? (task.completed_at ? new Date(task.completed_at) : new Date(now)) - new Date(task.started_at)
    : null;
  const taskDescription = getTaskDescription(task);
  const taskHostLabel = getTaskHostLabel(task);
  const hasGpuStatus = typeof task?.gpu_active === 'boolean';

  return (
    <>
      {/* Overlay */}
      <div
        className="fixed inset-0 drawer-overlay z-40 animate-fade-in"
        role="button"
        tabIndex={0}
        aria-label="Close task details"
        onClick={onClose}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClose(); }}
      />

      {/* Drawer */}
      <div className="fixed right-0 top-0 bottom-0 w-[520px] max-w-full bg-slate-900 border-l border-slate-700 z-50 animate-slide-in-right flex flex-col" role="dialog" aria-modal="true" aria-label={`Task details for ${taskId?.substring(0, 8) || 'unknown'}`}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-slate-700">
          <div className="flex items-center gap-3 min-w-0">
            <span className={`w-3 h-3 rounded-full flex-shrink-0 ${STATUS_COLORS[task?.status] || 'bg-gray-500'} ${task?.status === 'running' ? 'pulse-dot' : ''}`} />
            <span className="text-white font-semibold truncate">
              #{taskId?.substring(0, 8)}
            </span>
            <button
              onClick={() => {
                navigator.clipboard.writeText(taskId)
                  .then(() => toast.success('Copied task ID'))
                  .catch(() => toast.error('Failed to copy — clipboard access denied'));
              }}
              className="text-slate-500 hover:text-slate-300 transition-colors"
              title="Copy full task ID"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
          </div>
          <div className="flex items-center gap-1">
            {task && (
              <button
                onClick={exportTaskJSON}
                className="text-slate-500 hover:text-slate-300 p-1.5 rounded-lg hover:bg-slate-800 transition-colors"
                title="Export as JSON"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </button>
            )}
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-colors"
              aria-label="Close task details"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {loading ? (
          <div className="flex-1 p-6">
            <LoadingSkeleton lines={5} />
          </div>
        ) : task ? (
          <>
            {/* Tabs */}
            <div className="flex border-b border-slate-700">
              {['overview', 'output', 'diff', 'timeline'].map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`flex-1 px-4 py-3 text-sm font-medium capitalize transition-colors ${
                    activeTab === tab
                      ? 'text-blue-400 border-b-2 border-blue-400'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-5">
              {activeTab === 'overview' && (
                <div className="space-y-5">
                  {/* Description */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="heading-sm">Description</h4>
                      {taskDescription && (
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(taskDescription)
                              .then(() => toast.success('Description copied'))
                              .catch(() => toast.error('Failed to copy description'));
                          }}
                          className="text-slate-500 hover:text-slate-300 transition-colors"
                          title="Copy description"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                          </svg>
                        </button>
                      )}
                    </div>
                    <p className="text-white text-sm leading-relaxed">
                      {taskDescription || 'No description'}
                    </p>
                  </div>

                  {/* Metadata grid */}
                  <div className="grid grid-cols-2 gap-3">
                    <MetaItem label="Status" value={task.status?.replace(/_/g, ' ')} />
                    <MetaItem label="Provider" value={task.provider || 'codex'} />
                    <MetaItem label="Model" value={getRelevantModel(task.provider, task.model) || '-'} />
                    <MetaItem label="Host" value={taskHostLabel || '-'} />
                    {task.status === 'running' && hasGpuStatus && (
                      <MetaItem
                        label="GPU"
                        value={task.gpu_active ? 'Active' : 'Idle'}
                      />
                    )}
                    <MetaItem label="Duration" value={formatDurationMs(elapsed)} />
                    <MetaItem label="Created" value={formatTime(task.created_at)} />
                    <MetaItem label="Started" value={formatTime(task.started_at)} />
                    <MetaItem label="Completed" value={formatTime(task.completed_at)} />
                    {task.quality_score != null && (
                      <MetaItem label="Quality Score" value={task.quality_score} />
                    )}
                    {task.retry_count > 0 && (
                      <MetaItem label="Retries" value={task.retry_count} />
                    )}
                    {task.priority != null && task.priority !== 0 && (
                      <MetaItem label="Priority" value={task.priority} />
                    )}
                  </div>

                  {/* Working directory */}
                  {task.working_directory && (
                    <div>
                      <h4 className="heading-sm mb-2">Working Directory</h4>
                      <code className="text-xs text-slate-300 bg-slate-800 px-2 py-1 rounded block truncate" title={task.working_directory}>
                        {task.working_directory}
                      </code>
                    </div>
                  )}

                  {/* Tags */}
                  {task.tags && task.tags.length > 0 && (
                    <div>
                      <h4 className="heading-sm mb-2">Tags</h4>
                      <div className="flex flex-wrap gap-1.5">
                        {task.tags.map((tag) => (
                          <span key={tag} className="px-2 py-0.5 bg-indigo-600/30 text-indigo-300 rounded text-xs">
                            {tag}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Error output */}
                  {task.error_output && (
                    <CollapsibleSection title="Error" defaultOpen={true}>
                      <pre className="bg-red-950/30 border border-red-900/50 rounded-lg p-3 text-red-300 text-xs overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
                        {task.error_output}
                      </pre>
                    </CollapsibleSection>
                  )}

                  {/* Actions */}
                  <div className="flex flex-wrap items-center gap-2 pt-2">
                    {task.status === 'failed' && (
                      <ActionButton label="Retry" onClick={() => handleAction('retry')} color="blue" />
                    )}
                    {['completed', 'cancelled'].includes(task.status) && (
                      <ActionButton label="Resubmit" onClick={() => handleAction('retry')} color="blue" />
                    )}
                    {['queued', 'running'].includes(task.status) && (
                      <ActionButton label="Cancel" onClick={() => handleAction('cancel')} color="red" />
                    )}
                    {task.status === 'pending_provider_switch' && (
                      <>
                        <ActionButton label="Approve Switch" onClick={() => handleAction('approve-switch')} color="orange" />
                        <ActionButton label="Reject Switch" onClick={() => handleAction('reject-switch')} color="red" />
                      </>
                    )}
                    {task.status === 'queued' && providerOptions.length > 0 && (
                      <div className="flex items-center gap-2">
                        <select
                          aria-label="Reassign provider"
                          value={selectedProvider}
                          onChange={(e) => setSelectedProvider(e.target.value)}
                          className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-blue-500"
                        >
                          {providerOptions.map((option) => (
                            <option key={option.value} value={option.value} disabled={!option.enabled}>
                              {option.label}{!option.enabled ? ' (disabled)' : ''}
                            </option>
                          ))}
                        </select>
                        <ActionButton
                          label={reassigning ? 'Reassigning...' : 'Reassign'}
                          onClick={handleReassignProvider}
                          color="blue"
                          disabled={reassigning || !selectedProvider || selectedProvider === task.provider}
                        />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {activeTab === 'output' && (
                <OutputTab
                  output={output}
                  errorOutput={errorOutput}
                  streamingOutput={streamingOutput}
                  outputEndRef={outputEndRef}
                  toast={toast}
                />
              )}

              {activeTab === 'diff' && (
                <DiffTab taskId={taskId} toast={toast} />
              )}

              {activeTab === 'timeline' && (
                <div className="space-y-0">
                  {task.created_at && <TimelineEntry label="Created" time={task.created_at} color="bg-slate-400" now={now} />}
                  {task.started_at && (
                    <TimelineEntry
                      label="Started"
                      time={task.started_at}
                      color="bg-blue-400"
                      durationFrom={task.created_at}
                      durationLabel="Wait time"
                      now={now}
                    />
                  )}
                  {logs.map((log, i) => (
                    <TimelineEntry
                      key={`log-${log.created_at || log.timestamp || i}-${log.event || log.type || i}`}
                      label={log.event || log.type || 'Log'}
                      time={log.created_at || log.timestamp}
                      detail={log.message || log.detail}
                      color="bg-slate-400"
                      now={now}
                    />
                  ))}
                  {task.completed_at && (
                    <TimelineEntry
                      label={task.status === 'failed' ? 'Failed' : task.status === 'cancelled' ? 'Cancelled' : 'Completed'}
                      time={task.completed_at}
                      color={task.status === 'failed' ? 'bg-red-400' : task.status === 'cancelled' ? 'bg-amber-400' : 'bg-green-400'}
                      durationFrom={task.started_at}
                      durationLabel="Run time"
                      now={now}
                      isLast
                    />
                  )}
                  {!task.completed_at && task.status === 'running' && (
                    <TimelineEntry
                      label="Running..."
                      time={null}
                      color="bg-blue-400 animate-pulse"
                      durationFrom={task.started_at}
                      durationLabel="Elapsed"
                      now={now}
                      isLast
                    />
                  )}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <p className="text-slate-400">Task not found</p>
          </div>
        )}
      </div>
    </>
  );
}

function CollapsibleSection({ title, defaultOpen = true, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 w-full mb-2 group"
      >
        <svg className={`w-3 h-3 text-slate-500 transition-transform ${open ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <h4 className="heading-sm group-hover:text-white transition-colors">{title}</h4>
      </button>
      {open && children}
    </div>
  );
}

function MetaItem({ label, value }) {
  return (
    <div className="bg-slate-800/50 rounded-lg p-3">
      <p className="text-xs text-slate-500 mb-1">{label}</p>
      <p className="text-sm text-white font-medium capitalize">{value}</p>
    </div>
  );
}

function ActionButton({ label, onClick, color, disabled = false }) {
  const colors = {
    blue: 'bg-blue-600 hover:bg-blue-500',
    red: 'bg-red-600 hover:bg-red-500',
    orange: 'bg-orange-600 hover:bg-orange-500',
  };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 rounded-lg text-white text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${colors[color] || colors.blue}`}
    >
      {label}
    </button>
  );
}

function OutputTab({ output, errorOutput = '', streamingOutput, outputEndRef, toast }) {
  const [followMode, setFollowMode] = useState(true);
  const stdoutRef = useRef(null);
  const allChunks = useMemo(() => [...(output || []), ...(streamingOutput || [])], [output, streamingOutput]);
  const isStreaming = streamingOutput.length > 0;
  const stdoutText = useMemo(() => allChunks.filter(c => !c.isStderr).map(c => getOutputChunkText(c)).join(''), [allChunks]);
  const stderrText = normalizeTextValue(errorOutput);
  const lineCount = [stdoutText, stderrText].filter(Boolean).join('\n').split('\n').length;
  const stderrLineCount = stderrText ? stderrText.split('\n').length : 0;
  const hasStdout = allChunks.length > 0;
  const hasStderr = stderrText.length > 0;

  // Auto-scroll when new streaming output arrives (gated on followMode)
  useEffect(() => {
    if (followMode && stdoutRef.current) {
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    }
  }, [streamingOutput, followMode]);

  const handleOutputScroll = useCallback((e) => {
    const el = e.target;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (!atBottom && followMode) setFollowMode(false);
  }, [followMode]);

  function copyOutput() {
    const text = [
      stdoutText,
      hasStderr ? `[stderr]\n${stderrText}` : '',
    ].filter(Boolean).join('\n\n');
    navigator.clipboard.writeText(text)
      .then(() => toast?.success('Output copied'))
      .catch(() => toast?.error('Failed to copy output'));
  }

  if (!hasStdout && !hasStderr) {
    return <p className="text-slate-500 text-sm text-center py-8">No output available</p>;
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        {isStreaming ? (
          <div className="flex items-center gap-2 text-xs text-blue-400">
            <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
            Streaming live output...
          </div>
        ) : (
          <span className="text-xs text-slate-500">{lineCount} lines</span>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setFollowMode(!followMode)}
            className={`text-xs px-2 py-1 rounded ${followMode ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-400'}`}
          >
            {followMode ? 'Follow: ON' : 'Follow: OFF'}
          </button>
          <button
            onClick={() => {
              if (stdoutRef.current) {
                stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
              }
              setFollowMode(true);
            }}
            className="text-slate-400 hover:text-white text-xs transition-colors"
            title="Scroll to bottom"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
          <button
            onClick={copyOutput}
            className="text-slate-400 hover:text-white text-xs flex items-center gap-1 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
            Copy
          </button>
        </div>
      </div>
      <div className="space-y-4">
        {hasStdout && (
          <pre ref={stdoutRef} onScroll={handleOutputScroll} className="bg-gray-900 text-gray-100 rounded-lg p-4 text-sm overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[60vh] overflow-y-auto">
            {allChunks.map((chunk, i) => {
              const segments = parseAnsi(getOutputChunkText(chunk));
              return (
                <span key={`chunk-${i}`}>
                  {segments.map((seg, j) => (
                    <span key={`seg-${i}-${j}`} style={seg.style}>{seg.text}</span>
                  ))}
                </span>
              );
            })}
          </pre>
        )}
        {hasStderr && (
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium uppercase tracking-wide text-red-400">stderr</span>
              <span className="text-xs text-slate-500">{stderrLineCount} lines</span>
            </div>
            <pre className="bg-red-950/30 border border-red-900/50 text-red-200 rounded-lg p-4 text-sm overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed max-h-[32vh] overflow-y-auto">
              {parseAnsi(stderrText).map((seg, i) => (
                <span key={`stderr-${i}`} style={seg.style}>{seg.text}</span>
              ))}
            </pre>
          </div>
        )}
        <span ref={outputEndRef} />
      </div>
    </div>
  );
}

function coerceLineCount(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function normalizeDiff(diff) {
  if (!diff) {
    return {
      sections: [],
      filesChanged: 0,
      linesAdded: 0,
      linesRemoved: 0,
      copyText: '',
    };
  }

  const changes = Array.isArray(diff.changes) ? diff.changes.filter(Boolean) : [];

  if (changes.length > 0) {
    const sections = changes.map((change, index) => ({
      key: `${change.file || change.file_path || 'change'}-${index}`,
      file: change.file || change.file_path || `Change ${index + 1}`,
      action: change.action || change.change_type || null,
      patch: typeof change.patch === 'string'
        ? change.patch
        : typeof change.diff_content === 'string'
          ? change.diff_content
          : '',
      additions: coerceLineCount(change.lines_added ?? change.additions),
      deletions: coerceLineCount(change.lines_removed ?? change.deletions),
    }));
    const filesChanged = coerceLineCount(diff.files_changed);
    const linesAdded = diff.lines_added != null
      ? coerceLineCount(diff.lines_added)
      : sections.reduce((sum, section) => sum + section.additions, 0);
    const linesRemoved = diff.lines_removed != null
      ? coerceLineCount(diff.lines_removed)
      : sections.reduce((sum, section) => sum + section.deletions, 0);

    return {
      sections,
      filesChanged: filesChanged > 0 ? filesChanged : sections.length,
      linesAdded,
      linesRemoved,
      copyText: sections
        .map((section) => (
          section.patch
            ? [section.file, section.patch].filter(Boolean).join('\n')
            : [
                section.file,
                section.action ? `Action: ${section.action}` : '',
                `+${section.additions} -${section.deletions}`,
              ].filter(Boolean).join('\n')
        ))
        .join('\n\n'),
    };
  }

  if (typeof diff.diff_content === 'string' && diff.diff_content.length > 0) {
    return {
      sections: [{
        key: 'legacy-diff',
        file: null,
        patch: diff.diff_content,
        additions: coerceLineCount(diff.lines_added),
        deletions: coerceLineCount(diff.lines_removed),
      }],
      filesChanged: diff.files_changed ?? 0,
      linesAdded: coerceLineCount(diff.lines_added),
      linesRemoved: coerceLineCount(diff.lines_removed),
      copyText: diff.diff_content,
    };
  }

  return {
    sections: [],
    filesChanged: 0,
    linesAdded: 0,
    linesRemoved: 0,
    copyText: '',
  };
}

function getDiffLineColor(line) {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'text-green-400';
  if (line.startsWith('-') && !line.startsWith('---')) return 'text-red-400';
  if (line.startsWith('@@')) return 'text-cyan-400';
  if (line.startsWith('diff ') || line.startsWith('index ')) return 'text-slate-500';
  if (line.startsWith('---') || line.startsWith('+++')) return 'text-yellow-400';
  return 'text-slate-400';
}

function DiffPatch({ patch }) {
  return (
    <pre className="bg-slate-950 p-4 text-sm font-mono leading-relaxed max-h-[60vh] overflow-y-auto overflow-x-auto">
      {patch.split('\n').map((line, i) => (
        <div key={`diff-${i}`} className={`${getDiffLineColor(line)} whitespace-pre`}>
          {line}
        </div>
      ))}
    </pre>
  );
}

function DiffTab({ taskId, toast }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestIdRef.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!taskId) return;
    const requestId = ++requestIdRef.current;
    const isCurrentRequest = () => mountedRef.current && requestIdRef.current === requestId;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setDiff(null);
    tasksApi.diff(taskId)
      .then((data) => {
        if (!isCurrentRequest()) return;
        setDiff(data);
      })
      .catch((err) => {
        if (!isCurrentRequest()) return;
        console.error('Failed to load diff:', err);
        toast?.error('Failed to load diff');
      })
      .finally(() => {
        if (isCurrentRequest()) {
          setLoading(false);
        }
      });
  }, [taskId, toast]);

  if (loading) {
    return <p className="text-slate-500 text-sm text-center py-8">Loading diff...</p>;
  }

  const normalizedDiff = normalizeDiff(diff);

  if (normalizedDiff.sections.length === 0) {
    return <p className="text-slate-500 text-sm text-center py-8">No diff available for this task</p>;
  }

  function copyDiff() {
    navigator.clipboard.writeText(normalizedDiff.copyText)
      .then(() => toast?.success('Diff copied'))
      .catch(() => toast?.error('Failed to copy diff'));
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500">
            {normalizedDiff.filesChanged} file{normalizedDiff.filesChanged !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-green-400">+{normalizedDiff.linesAdded}</span>
          <span className="text-xs text-red-400">-{normalizedDiff.linesRemoved}</span>
          {diff?.status === 'reviewed' && (
            <span className="text-[10px] bg-green-900/50 text-green-400 px-1.5 py-0.5 rounded">Reviewed</span>
          )}
        </div>
        <button
          onClick={copyDiff}
          className="text-slate-400 hover:text-white text-xs flex items-center gap-1 transition-colors"
          aria-label="Copy diff to clipboard"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
          Copy
        </button>
      </div>
      <div className="space-y-4">
        {normalizedDiff.sections.map((section) => (
          <div key={section.key} className="border border-slate-800 rounded-lg overflow-hidden">
            {section.file && (
              <div className="flex items-center justify-between gap-3 px-3 py-2 bg-slate-900/70 border-b border-slate-800">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="text-xs text-slate-200 font-medium break-all">{section.file}</span>
                  {section.action && (
                    <span className="text-[10px] uppercase tracking-wide bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded shrink-0">
                      {section.action}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-green-400">+{section.additions}</span>
                  <span className="text-xs text-red-400">-{section.deletions}</span>
                </div>
              </div>
            )}
            {section.patch ? (
              <DiffPatch patch={section.patch} />
            ) : (
              <div className="px-4 py-3 text-sm text-slate-500">No inline patch available from v2 diff endpoint</div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function TimelineEntry({ label, time, detail, isLast, color = 'bg-blue-500', durationFrom, durationLabel, now }) {
  // eslint-disable-next-line react-hooks/purity -- intentional: wall-clock time for duration display
  if (now === undefined) now = Date.now();
  const dur = durationFrom && time
    ? new Date(time) - new Date(durationFrom)
    : durationFrom && !time
      ? now - new Date(durationFrom).getTime()
      : null;

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={`w-2.5 h-2.5 rounded-full ${color} mt-1.5 flex-shrink-0`} />
        {!isLast && <div className="w-px flex-1 bg-slate-700 my-1" />}
      </div>
      <div className="pb-4 min-w-0">
        <div className="flex items-center gap-2">
          <p className="text-sm text-white font-medium">{label}</p>
          {dur != null && dur > 0 && (
            <span className="text-[10px] text-slate-500 bg-slate-800 px-1.5 py-0.5 rounded">
              {durationLabel}: {formatDurationMs(dur)}
            </span>
          )}
        </div>
        {time && <p className="text-xs text-slate-400">{formatTime(time)}</p>}
        {detail && <p className="text-xs text-slate-500 mt-1">{detail}</p>}
      </div>
    </div>
  );
}
