import { render, screen, fireEvent } from '@testing-library/react';
import WorkflowDAG from './WorkflowDAG';

const baseWorkflow = [
  {
    node_id: 'types',
    id: 't1',
    status: 'completed',
    depends_on: [],
    started_at: '2026-03-01T00:00:00Z',
    completed_at: '2026-03-01T00:01:15Z',
  },
  {
    node_id: 'transform',
    id: 't2',
    status: 'failed',
    depends_on: ['types'],
    started_at: '2026-03-01T00:01:15Z',
    completed_at: '2026-03-01T00:02:20Z',
  },
  {
    node_id: 'system',
    id: 't3',
    status: 'running',
    depends_on: ['transform'],
    started_at: '2026-03-01T00:02:20Z',
  },
  {
    node_id: 'tests',
    id: 't4',
    status: 'queued',
    depends_on: ['system'],
  },
];

const getNodeById = (container, id) => container.querySelector(`[data-testid="dag-node-${id}"]`);
const getStatusColor = (nodeElement) => {
  const statusBar = nodeElement?.querySelector('rect[width="4"]');
  return statusBar?.getAttribute('fill');
};
const getNodeLabel = (nodeElement) => {
  const textNodes = nodeElement?.querySelectorAll('text');
  return textNodes?.[1]?.textContent || '';
};
const getNodeStatusText = (nodeElement) => {
  const textNodes = nodeElement?.querySelectorAll('text');
  return textNodes?.[2]?.textContent || '';
};

describe('WorkflowDAG', () => {
  it('renders SVG and the expected number of node groups for a workflow', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const svg = screen.getByTestId('workflow-dag-svg');
    const nodeGroups = container.querySelectorAll('g[data-testid^="dag-node-"]');

    expect(svg).toBeDefined();
    expect(nodeGroups.length).toBe(baseWorkflow.length);
  });

  it('renders the full set of expected node IDs', () => {
    render(<WorkflowDAG tasks={baseWorkflow} />);
    expect(screen.getByTestId('dag-node-types')).toBeDefined();
    expect(screen.getByTestId('dag-node-transform')).toBeDefined();
    expect(screen.getByTestId('dag-node-system')).toBeDefined();
    expect(screen.getByTestId('dag-node-tests')).toBeDefined();
  });

  it('renders edges between dependent tasks using marker-end paths', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const edges = container.querySelectorAll('path[marker-end]');

    expect(edges.length).toBe(3);
    edges.forEach((path) => {
      expect(path.getAttribute('d')).not.toBe('');
      expect(path.getAttribute('d')).toContain('L');
    });
  });

  it('supports `dependencies` alias alongside `depends_on`', () => {
    const workflow = [
      { node_id: 'ingest', id: 'ingest-id', status: 'completed' },
      { task_id: 'enrich', status: 'running', dependencies: ['ingest'] },
    ];

    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const edges = container.querySelectorAll('path[marker-end]');

    expect(edges.length).toBe(1);
    expect(container.querySelector('[data-testid="dag-node-ingest"]')).toBeDefined();
    expect(container.querySelector('[data-testid="dag-node-enrich"]')).toBeDefined();
  });

  it('calls onOpenDrawer with task id when node is clicked', () => {
    const spy = vi.fn();
    render(<WorkflowDAG tasks={baseWorkflow} onOpenDrawer={spy} />);
    fireEvent.click(screen.getByTestId('dag-node-types'));
    expect(spy).toHaveBeenCalledWith('t1');
  });

  it('maps click to the clicked task object', () => {
    const onNodeClick = vi.fn();
    render(
      <WorkflowDAG
        tasks={baseWorkflow}
        onOpenDrawer={(id) => {
          const task = baseWorkflow.find((t) => t.id === id || t.node_id === id || t.task_id === id);
          onNodeClick(task);
        }}
      />
    );

    fireEvent.click(screen.getByTestId('dag-node-system'));
    expect(onNodeClick).toHaveBeenCalledWith(baseWorkflow[2]);
  });

  it('uses completed color for completed status nodes', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const node = getNodeById(container, 'types');
    expect(getStatusColor(node)).toBe('#16a34a');
  });

  it('uses failed color for failed status nodes', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const node = getNodeById(container, 'transform');
    expect(getStatusColor(node)).toBe('#dc2626');
  });

  it('uses running color for running status nodes', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const node = getNodeById(container, 'system');
    expect(getStatusColor(node)).toBe('#2563eb');
  });

  it('uses queued color for queued status nodes', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const node = getNodeById(container, 'tests');
    expect(getStatusColor(node)).toBe('#475569');
  });

  it('defaults unknown status to queued/gray color', () => {
    const workflow = [{ node_id: 'mystery', id: 'x1', status: 'interrupted' }];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const node = getNodeById(container, 'mystery');
    expect(getStatusColor(node)).toBe('#475569');
  });

  it('renders duration text for completed nodes', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const completedNode = getNodeById(container, 'types');
    const statusText = getNodeStatusText(completedNode);
    expect(statusText).toContain('1m');
    expect(statusText).toContain('15s');
  });

  it('renders status text for non-completed nodes without duration', () => {
    const { container } = render(<WorkflowDAG tasks={baseWorkflow} />);
    const pendingNode = getNodeById(container, 'tests');
    const statusText = getNodeStatusText(pendingNode);
    expect(statusText).toBe('queued');
  });

  it('does not render duration for tasks without both timestamps', () => {
    const workflow = [{ node_id: 'queued', id: 'q1', status: 'queued' }];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const node = getNodeById(container, 'queued');
    expect(getNodeStatusText(node)).toBe('queued');
  });

  it('shows truncated task description for long labels', () => {
    const longDescription = 'This task has an excessively long description that should be truncated';
    const expectedLabel = `${longDescription.slice(0, 24)}…`;
    const tasks = [
      {
        id: 'long',
        description: longDescription,
        status: 'completed',
        started_at: '2026-03-01T00:00:00Z',
        completed_at: '2026-03-01T00:00:00Z',
      },
    ];
    const { container } = render(<WorkflowDAG tasks={tasks} />);
    const node = getNodeById(container, 'long');
    expect(getNodeLabel(node)).toBe(expectedLabel);
    expect(getNodeLabel(node).length).toBe(25);
    expect(getNodeLabel(node)).not.toBe(longDescription);
  });

  it('preserves short task descriptions without truncation', () => {
    const tasks = [
      {
        id: 'short',
        description: 'Compact text',
        status: 'completed',
        started_at: '2026-03-01T00:00:00Z',
        completed_at: '2026-03-01T00:00:00Z',
      },
    ];
    const { container } = render(<WorkflowDAG tasks={tasks} />);
    const node = getNodeById(container, 'short');
    expect(getNodeLabel(node)).toBe('Compact text');
  });

  it('uses task_id for node id when node_id and id are missing', () => {
    const workflow = [{ task_id: 'task-id-fallback', status: 'completed' }];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const node = container.querySelector('[data-testid="dag-node-task-id-fallback"]');

    expect(node).toBeDefined();
    expect(getNodeLabel(node)).toBe('task-id-fallback');
  });

  it('handles empty workflow without crashes', () => {
    const { container } = render(<WorkflowDAG tasks={[]} />);
    expect(screen.getByText('No tasks to visualize')).toBeDefined();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('handles tasks without depends_on as isolated nodes', () => {
    const tasks = [
      { node_id: 'solo', id: 's1', status: 'completed' },
      { node_id: 'solo2', id: 's2', status: 'queued' },
    ];
    const { container } = render(<WorkflowDAG tasks={tasks} />);

    expect(screen.getByTestId('dag-node-solo')).toBeDefined();
    expect(screen.getByTestId('dag-node-solo2')).toBeDefined();
    expect(container.querySelectorAll('path[marker-end]').length).toBe(0);
  });

  it('does not create edges for missing dependency ids', () => {
    const workflow = [
      { node_id: 'exists', id: 'existing-id', status: 'completed' },
      { node_id: 'missing', id: 'missing-id', status: 'running', depends_on: ['not-real-id'] },
    ];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    expect(container.querySelectorAll('path[marker-end]').length).toBe(0);
  });

  it('handles malformed context JSON values without crashing', () => {
    const workflow = [
      {
        node_id: 'bad-context',
        id: 'bad',
        status: 'completed',
        context: '{broken json: true',
      },
    ];

    expect(() => render(<WorkflowDAG tasks={workflow} />)).not.toThrow();
  });

  it('still renders when task list contains only non-completable status states', () => {
    const workflow = [
      { node_id: 'pending', id: 'p1', status: 'pending' },
      { node_id: 'cancelled', id: 'c1', status: 'cancelled' },
      { node_id: 'skipped', id: 's1', status: 'skipped' },
    ];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const nodeGroups = container.querySelectorAll('g[data-testid^="dag-node-"]');

    expect(nodeGroups.length).toBe(3);
    expect(nodeGroups[0]).toBeDefined();
    expect(nodeGroups[1]).toBeDefined();
    expect(nodeGroups[2]).toBeDefined();
  });

  it('renders an edge path for multi-point layout output', () => {
    const workflow = [
      { node_id: 'root', id: 'r', status: 'completed' },
      { node_id: 'mid', id: 'm', status: 'running', depends_on: ['root'] },
      { node_id: 'leaf', id: 'l', status: 'completed', depends_on: ['mid'] },
    ];
    const { container } = render(<WorkflowDAG tasks={workflow} />);
    const paths = container.querySelectorAll('path[marker-end]');

    expect(paths.length).toBe(2);
    expect(Array.from(paths).every((path) => path.getAttribute('d').includes('L'))).toBe(true);
  });
});
