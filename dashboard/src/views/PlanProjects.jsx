import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { planProjects as projectsApi } from '../api';
import { useToast } from '../components/Toast';
import { useAbortableRequest } from '../hooks/useAbortableRequest';

const STATUS_TABS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
];

const STATUS_COLORS = {
  active: 'bg-blue-500',
  paused: 'bg-yellow-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
};

const TASK_STATUS_COLORS = {
  queued: 'bg-slate-500',
  running: 'bg-blue-500',
  waiting: 'bg-purple-500',
  blocked: 'bg-orange-500',
  completed: 'bg-green-500',
  failed: 'bg-red-500',
};

function normalizeProjectsList(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.items)) return data.items;
  if (Array.isArray(data?.projects)) return data.projects;
  return [];
}

function ProgressBar({ progress, className = '' }) {
  return (
    <div className={`w-full bg-slate-700 rounded-full h-2 ${className}`}>
      <div
        className="bg-green-500 h-2 rounded-full transition-all duration-300"
        style={{ width: `${progress}%` }}
      />
    </div>
  );
}

function ProjectCard({ project, onSelect, onAction }) {
  const statusColor = STATUS_COLORS[project.status] || 'bg-slate-500';

  return (
    <div
      onClick={() => onSelect(project.id)}
      className="bg-slate-800 rounded-lg p-4 cursor-pointer hover:bg-slate-700 transition-colors"
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex-1">
          <h3 className="text-lg font-medium text-white">{project.name}</h3>
          {project.source_file && (
            <p className="text-xs text-slate-400 truncate">{project.source_file}</p>
          )}
        </div>
        <span className={`px-2 py-1 rounded text-xs text-white ${statusColor}`}>
          {project.status}
        </span>
      </div>

      <div className="mb-3">
        <div className="flex justify-between text-sm text-slate-400 mb-1">
          <span>{project.completed_tasks}/{project.total_tasks} tasks</span>
          <span>{project.progress}%</span>
        </div>
        <ProgressBar progress={project.progress} />
      </div>

      {project.failed_tasks > 0 && (
        <p className="text-sm text-red-400 mb-2">
          {project.failed_tasks} failed task{project.failed_tasks > 1 ? 's' : ''}
        </p>
      )}

      <div className="flex gap-2 mt-3">
        {project.status === 'active' && (
          <button
            onClick={(e) => { e.stopPropagation(); onAction(project.id, 'pause'); }}
            className="px-3 py-1 bg-yellow-600 hover:bg-yellow-500 text-white text-sm rounded transition-colors"
          >
            Pause
          </button>
        )}
        {project.status === 'paused' && (
          <button
            onClick={(e) => { e.stopPropagation(); onAction(project.id, 'resume'); }}
            className="px-3 py-1 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded transition-colors"
          >
            Resume
          </button>
        )}
        {project.failed_tasks > 0 && (
          <button
            onClick={(e) => { e.stopPropagation(); onAction(project.id, 'retry'); }}
            className="px-3 py-1 bg-orange-600 hover:bg-orange-500 text-white text-sm rounded transition-colors"
          >
            Retry Failed
          </button>
        )}
        <button
          onClick={(e) => { e.stopPropagation(); onAction(project.id, 'delete'); }}
          className="px-3 py-1 bg-red-600/30 hover:bg-red-600 text-red-300 hover:text-white text-sm rounded transition-colors ml-auto"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

function TaskRow({ task }) {
  const statusColor = TASK_STATUS_COLORS[task.status] || 'bg-slate-500';

  return (
    <div className="flex items-center gap-3 py-2 border-b border-slate-700 last:border-0">
      <span className={`w-2 h-2 rounded-full ${statusColor}`} />
      <span className="text-slate-400 text-sm w-8">#{task.sequence_number}</span>
      <p className="flex-1 text-white text-sm truncate">{task.task_description}</p>
      <span className="text-xs text-slate-400">{task.status}</span>
      {task.depends_on && task.depends_on.length > 0 && (
        <span className="text-xs text-slate-500">
          depends on: {task.depends_on.map((dep) => `#${dep}`).join(', ')}
        </span>
      )}
    </div>
  );
}

function ProjectDetail({ projectId, onBack, onAction }) {
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(true);
  const { execute } = useAbortableRequest();

  useEffect(() => {
    loadProject();
  }, [projectId]);

  function loadProject() {
    setLoading(true);
    execute(async (isCurrent) => {
      try {
        const data = await projectsApi.get(projectId);
        if (!isCurrent()) return;
        setProject(data);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load project:', err);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }

  if (loading) {
    return <div className="p-6 text-slate-400">Loading project...</div>;
  }

  if (!project) {
    return <div className="p-6 text-red-400">Project not found</div>;
  }

  const statusColor = STATUS_COLORS[project.status] || 'bg-slate-500';

  return (
    <div className="p-6">
      <button
        onClick={onBack}
        className="text-slate-400 hover:text-white mb-4 flex items-center gap-2"
      >
        <span>&larr;</span> Back to Projects
      </button>

      <div className="bg-slate-800 rounded-lg p-6 mb-6">
        <div className="flex items-start justify-between gap-4 mb-4">
          <div>
            <h2 className="text-2xl font-bold text-white">{project.name}</h2>
            {project.source_file && (
              <p className="text-sm text-slate-400">{project.source_file}</p>
            )}
          </div>
          <span className={`px-3 py-1 rounded text-sm text-white ${statusColor}`}>
            {project.status}
          </span>
        </div>

        <div className="grid grid-cols-4 gap-4 mb-4">
          <div>
            <p className="text-slate-400 text-sm">Total Tasks</p>
            <p className="text-xl font-bold text-white">{project.total_tasks}</p>
          </div>
          <div>
            <p className="text-slate-400 text-sm">Completed</p>
            <p className="text-xl font-bold text-green-400">{project.completed_tasks}</p>
          </div>
          <div>
            <p className="text-slate-400 text-sm">Failed</p>
            <p className="text-xl font-bold text-red-400">{project.failed_tasks}</p>
          </div>
          <div>
            <p className="text-slate-400 text-sm">Progress</p>
            <p className="text-xl font-bold text-white">{project.progress}%</p>
          </div>
        </div>

        <ProgressBar progress={project.progress} className="mb-4" />

        <div className="flex gap-2">
          {project.status === 'active' && (
            <button
              onClick={() => onAction(project.id, 'pause')}
              className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 text-white rounded transition-colors"
            >
              Pause Project
            </button>
          )}
          {project.status === 'paused' && (
            <button
              onClick={() => onAction(project.id, 'resume')}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
            >
              Resume Project
            </button>
          )}
          {project.failed_tasks > 0 && (
            <button
              onClick={() => onAction(project.id, 'retry')}
              className="px-4 py-2 bg-orange-600 hover:bg-orange-500 text-white rounded transition-colors"
            >
              Retry Failed Tasks
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-800 rounded-lg p-6">
        <h3 className="text-lg font-medium text-white mb-4">Tasks</h3>
        <div className="divide-y divide-slate-700">
          {project.tasks?.map((task) => (
            <TaskRow key={task.task_id} task={task} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ImportModal({ onClose, onImport }) {
  const [planContent, setPlanContent] = useState('');
  const [projectName, setProjectName] = useState('');
  const [workingDirectory, setWorkingDirectory] = useState('');
  const [preview, setPreview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handlePreview() {
    if (!planContent.trim()) {
      setError('Please paste a plan first');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await projectsApi.import({
        plan_content: planContent,
        project_name: projectName || undefined,
        working_directory: workingDirectory || undefined,
        dry_run: true,
      });
      setPreview(result);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCreate() {
    setLoading(true);
    setError(null);
    try {
      const result = await projectsApi.import({
        plan_content: planContent,
        project_name: projectName || undefined,
        working_directory: workingDirectory || undefined,
        dry_run: false,
      });
      onImport(result);
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-slate-800 rounded-lg p-6 w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center mb-4">
          <h2 className="text-xl font-bold text-white">Import Plan</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-white text-2xl">
            &times;
          </button>
        </div>

        {error && (
          <div className="bg-red-900/50 border border-red-500 rounded p-3 mb-4">
            <p className="text-red-300 text-sm">{error}</p>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm text-slate-400 mb-1">Project Name (optional)</label>
            <input
              type="text"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              placeholder="My Project"
              className="w-full bg-slate-700 text-white rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Working Directory (optional)</label>
            <input
              type="text"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
              placeholder="/path/to/project"
              className="w-full bg-slate-700 text-white rounded px-3 py-2"
            />
          </div>

          <div>
            <label className="block text-sm text-slate-400 mb-1">Plan Content (Markdown)</label>
            <textarea
              value={planContent}
              onChange={(e) => setPlanContent(e.target.value)}
              placeholder="Paste your implementation plan here..."
              rows={10}
              className="w-full bg-slate-700 text-white rounded px-3 py-2 font-mono text-sm"
            />
          </div>

          {preview && (
            <div className="bg-slate-900 rounded p-4">
              <h3 className="text-white font-medium mb-2">Preview: {preview.task_count} tasks</h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {preview.tasks?.map((task, i) => (
                  <div key={i} className="text-sm">
                    <span className="text-slate-400">#{task.seq}</span>
                    <span className="text-white ml-2">{task.description?.substring(0, 60)}...</span>
                    {task.depends_on?.length > 0 && (
                      <span className="text-slate-500 ml-2">
                        (depends on: {task.depends_on.join(', ')})
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handlePreview}
              disabled={loading}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors disabled:opacity-50"
            >
              {loading ? 'Processing...' : 'Preview'}
            </button>
            {preview && (
              <button
                onClick={handleCreate}
                disabled={loading}
                className="px-4 py-2 bg-green-600 hover:bg-green-500 text-white rounded transition-colors disabled:opacity-50"
              >
                Create Project
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function PlanProjects() {
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedProject, setSelectedProject] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [statusFilter, setStatusFilter] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const searchTimerRef = useRef(null);

  const toast = useToast();
  const { execute } = useAbortableRequest();

  const handleSearchChange = useCallback((value) => {
    setSearchInput(value);
    clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => setSearch(value), 300);
  }, []);

  useEffect(() => {
    return () => clearTimeout(searchTimerRef.current);
  }, []);

  useEffect(() => {
    loadProjects();
    const interval = setInterval(loadProjects, 5000);
    return () => clearInterval(interval);
  }, []);

  function loadProjects() {
    execute(async (isCurrent) => {
      try {
        const data = await projectsApi.list();
        if (!isCurrent()) return;
        setProjects(normalizeProjectsList(data));
      } catch (err) {
        if (!isCurrent()) return;
        console.error('Failed to load projects:', err);
        toast.error('Failed to load projects');
      } finally {
        if (isCurrent()) setLoading(false);
      }
    });
  }

  async function handleAction(projectId, action) {
    if (action === 'delete') {
      setDeleteConfirm(projectId);
      return;
    }
    try {
      if (action === 'pause') {
        await projectsApi.pause(projectId);
      } else if (action === 'resume') {
        await projectsApi.resume(projectId);
      } else if (action === 'retry') {
        await projectsApi.retry(projectId);
      }
      toast.success(`Project ${action} successful`);
      loadProjects();
    } catch (err) {
      console.error(`Action ${action} failed:`, err);
      toast.error(`${action} failed: ${err.message}`);
    }
  }

  async function confirmDelete() {
    if (!deleteConfirm) return;
    try {
      await projectsApi.delete(deleteConfirm);
      toast.success('Project deleted');
      loadProjects();
    } catch (err) {
      console.error('Delete failed:', err);
      toast.error(`Delete failed: ${err.message}`);
    } finally {
      setDeleteConfirm(null);
    }
  }

  const filteredProjects = useMemo(() => {
    let filtered = projects;
    if (statusFilter) {
      filtered = filtered.filter((p) => p.status === statusFilter);
    }
    if (search) {
      const q = search.toLowerCase();
      filtered = filtered.filter((p) =>
        p.name?.toLowerCase().includes(q) || p.source_file?.toLowerCase().includes(q)
      );
    }
    return filtered;
  }, [projects, statusFilter, search]);

  if (selectedProject) {
    return (
      <ProjectDetail
        projectId={selectedProject}
        onBack={() => setSelectedProject(null)}
        onAction={handleAction}
      />
    );
  }

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-full">
        <p className="text-slate-400">Loading projects...</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold text-white">Plan Projects</h1>
        <button
          onClick={() => setShowImport(true)}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
        >
          Import Plan
        </button>
      </div>

      {/* Search + status filter tabs */}
      {projects.length > 0 && (
        <div className="mb-6 space-y-3">
          <input
            type="text"
            placeholder="Search projects..."
            value={searchInput}
            onChange={(e) => handleSearchChange(e.target.value)}
            className="w-full bg-slate-800/60 border border-slate-700/50 rounded-lg px-4 py-2 text-white text-sm placeholder-slate-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
          <div className="flex gap-1">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.value}
                onClick={() => setStatusFilter(tab.value)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                  statusFilter === tab.value
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-800/60 text-slate-400 hover:text-white hover:bg-slate-700/60'
                }`}
              >
                {tab.label}
                {tab.value && (
                  <span className="ml-1.5 text-[10px] opacity-70">
                    {projects.filter((p) => p.status === tab.value).length}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400 mb-4">No projects yet</p>
          <button
            onClick={() => setShowImport(true)}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
          >
            Import Your First Plan
          </button>
        </div>
      ) : filteredProjects.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-slate-400">No projects match your filters</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredProjects.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              onSelect={setSelectedProject}
              onAction={handleAction}
            />
          ))}
        </div>
      )}

      {/* Delete confirmation dialog */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-slate-800 rounded-lg p-6 max-w-sm w-full">
            <h3 className="text-lg font-semibold text-white mb-2">Delete Project</h3>
            <p className="text-slate-400 text-sm mb-4">
              Are you sure you want to delete this project? This cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                className="px-4 py-2 bg-slate-600 hover:bg-slate-500 text-white rounded text-sm transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded text-sm transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {showImport && (
        <ImportModal
          onClose={() => setShowImport(false)}
          onImport={() => {
            loadProjects();
          }}
        />
      )}
    </div>
  );
}
