import { useEffect, useMemo, useState } from 'react';
import { requestV2 } from '../api';

function splitTableLine(line) {
  return String(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

function toTableKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value.replace(/[^0-9.-]+/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'configured'].includes(normalized)) return true;
    if (['false', 'no', '0', 'not configured'].includes(normalized)) return false;
  }
  return undefined;
}

export function parseMarkdownTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = 0; index < lines.length - 1; index += 1) {
    if (!lines[index].startsWith('|') || !lines[index + 1].startsWith('|')) continue;

    const headers = splitTableLine(lines[index]);
    const separator = splitTableLine(lines[index + 1]);
    const isSeparator = separator.length > 0 && separator.every((cell) => /^:?-{3,}:?$/.test(cell));
    if (!headers.length || !isSeparator) continue;

    const rows = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const line = lines[rowIndex];
      if (!line.startsWith('|')) break;
      const cells = splitTableLine(line);
      if (!cells.length) continue;

      const row = {};
      headers.forEach((header, cellIndex) => {
        row[toTableKey(header)] = cells[cellIndex] ?? '';
      });
      rows.push(row);
    }

    return rows;
  }

  return [];
}

function normalizeProject(project) {
  if (!project || typeof project !== 'object') return null;

  const name = String(project.name || project.project || project.project_name || '').trim();
  if (!name) return null;

  return {
    ...project,
    name,
    task_count: Math.max(
      0,
      Math.round(
        toNumber(
          project.task_count
          ?? project.taskcount
          ?? project.tasks
          ?? project.total_tasks
        )
      )
    ),
    completed_count: Math.max(0, Math.round(toNumber(project.completed_count ?? project.completed))),
    failed_count: Math.max(0, Math.round(toNumber(project.failed_count ?? project.failed))),
    active_count: Math.max(0, Math.round(toNumber(project.active_count ?? project.active))),
    total_cost: toNumber(project.total_cost ?? project.cost),
    last_active: project.last_active || project.last_task_at || project.updated_at || project.created_at || null,
    first_task_at: project.first_task_at || null,
    has_config: toBoolean(project.has_config ?? project.configured ?? project.hasConfig),
  };
}

export function normalizeProjectListPayload(payload) {
  const listCandidates = [
    payload,
    payload?.data,
    payload?.data?.items,
    payload?.data?.projects,
    payload?.items,
    payload?.projects,
  ];

  for (const candidate of listCandidates) {
    if (!Array.isArray(candidate)) continue;

    const normalized = [];
    const seen = new Set();

    candidate.forEach((entry) => {
      const project = normalizeProject(entry);
      if (!project || seen.has(project.name)) return;
      seen.add(project.name);
      normalized.push(project);
    });

    if (normalized.length > 0) return normalized;
  }

  const parsedTable = parseMarkdownTable(
    typeof payload === 'string'
      ? payload
      : payload?.result || payload?.data?.result || ''
  );

  if (!parsedTable.length) return [];

  const normalized = [];
  const seen = new Set();

  parsedTable.forEach((entry) => {
    const project = normalizeProject(entry);
    if (!project || seen.has(project.name)) return;
    seen.add(project.name);
    normalized.push(project);
  });

  return normalized;
}

export async function fetchProjects() {
  const endpoints = ['/tasks/list-projects', '/projects'];

  for (const endpoint of endpoints) {
    try {
      const payload = await requestV2(endpoint);
      const projects = normalizeProjectListPayload(payload);
      if (projects.length > 0) return projects;
    } catch {
      // Try the next endpoint.
    }
  }

  return [];
}

export default function ProjectSelector({
  value,
  onChange,
  onProjectsLoaded,
  placeholder = 'All projects',
  className = '',
  ...props
}) {
  const [projects, setProjects] = useState([]);

  useEffect(() => {
    let cancelled = false;

    fetchProjects()
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        onProjectsLoaded?.(list);
      })
      .catch(() => {
        if (cancelled) return;
        setProjects([]);
        onProjectsLoaded?.([]);
      });

    return () => {
      cancelled = true;
    };
  }, [onProjectsLoaded]);

  const options = useMemo(() => {
    if (!value || projects.some((project) => project.name === value)) {
      return projects;
    }

    return [{ name: value, task_count: 0 }, ...projects];
  }, [projects, value]);

  return (
    <select
      value={value || ''}
      onChange={(event) => onChange?.(event.target.value || null)}
      className={`rounded-lg border border-slate-700/50 bg-slate-800/60 px-4 py-2 text-sm text-white focus:border-blue-500 focus:outline-none ${className}`.trim()}
      {...props}
    >
      <option value="">{placeholder}</option>
      {options.map((project) => (
        <option key={project.name} value={project.name}>
          {project.name} ({project.task_count || 0} tasks)
        </option>
      ))}
    </select>
  );
}
