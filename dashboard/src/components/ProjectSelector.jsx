import { useEffect, useMemo, useState } from 'react';
import { fetchProjects } from './ProjectSelector.helpers';

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
