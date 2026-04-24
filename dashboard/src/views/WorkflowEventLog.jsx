import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

export default function WorkflowEventLog() {
  const { id } = useParams();
  const [events, setEvents] = useState([]);
  const [filter, setFilter] = useState('');

  useEffect(() => {
    if (!id) {
      setEvents([]);
      return;
    }

    fetch(`/api/workflows/${id}/events`)
      .then((r) => r.json())
      .then((d) => setEvents(d?.events || []))
      .catch(() => setEvents([]));
  }, [id]);

  const filtered = filter
    ? events.filter(
      (e) => e.event_type?.includes(filter) || e.task_id?.includes(filter)
    )
    : events;

  return (
    <div className="p-4 max-w-5xl">
      <h2 className="text-xl font-semibold mb-2">Event log: {id}</h2>
      <input
        placeholder="filter by event_type or task_id"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="border rounded px-2 py-1 mb-3 w-full max-w-md"
      />
      <table className="w-full text-sm">
        <thead className="bg-gray-100">
          <tr>
            <th className="text-left px-2 py-1 w-12">seq</th>
            <th className="text-left px-2 py-1">type</th>
            <th className="text-left px-2 py-1">task</th>
            <th className="text-left px-2 py-1">payload</th>
            <th className="text-left px-2 py-1">at</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((e) => (
            <tr key={e.event_id} className="border-t">
              <td className="px-2 py-1 font-mono">{e.seq}</td>
              <td className="px-2 py-1 font-mono">{e.event_type}</td>
              <td className="px-2 py-1 font-mono text-xs">{e.task_id || '-'}</td>
              <td className="px-2 py-1 font-mono text-xs max-w-md truncate">{e.payload ? JSON.stringify(e.payload) : ''}</td>
              <td className="px-2 py-1 text-xs text-gray-500">{e.created_at}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
