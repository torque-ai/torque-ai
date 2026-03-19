import { screen, waitFor, fireEvent } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import PlanProjects from './PlanProjects';

vi.mock('../api', () => ({
  planProjects: {
    list: vi.fn(),
    get: vi.fn(),
    import: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock('../hooks/useAbortableRequest', () => ({
  useAbortableRequest: () => ({
    execute: (fn) => fn(() => true),
  }),
}));

import { planProjects as projectsApi } from '../api';

const mockProjects = [
  {
    id: 'proj-1',
    name: 'Feature Alpha',
    status: 'active',
    progress: 60,
    total_tasks: 10,
    completed_tasks: 6,
    failed_tasks: 1,
    source_file: 'plan-alpha.md',
  },
  {
    id: 'proj-2',
    name: 'Feature Beta',
    status: 'completed',
    progress: 100,
    total_tasks: 5,
    completed_tasks: 5,
    failed_tasks: 0,
    source_file: 'plan-beta.md',
  },
];

const mockV2ProjectsResponse = mockProjects.map((project) => ({ ...project }));

describe('PlanProjects', () => {
  beforeEach(() => {
    projectsApi.list.mockResolvedValue(mockV2ProjectsResponse);
    projectsApi.pause.mockResolvedValue({});
    projectsApi.resume.mockResolvedValue({});
    projectsApi.retry.mockResolvedValue({});
    projectsApi.delete.mockResolvedValue({});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    projectsApi.list.mockReturnValue(new Promise(() => {}));
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    expect(screen.getByTestId('loading-skeleton')).toBeTruthy();
  });

  it('consumes the v2 unwrapped array response shape', async () => {
    projectsApi.list.mockResolvedValueOnce(mockV2ProjectsResponse);
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(projectsApi.list).toHaveBeenCalled();
      expect(screen.getByText('Feature Alpha')).toBeTruthy();
      expect(screen.queryByText('No projects yet')).toBeNull();
    });
  });

  it('renders heading after loading', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Plan Projects')).toBeTruthy();
    });
  });

  it('displays project names', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Feature Alpha')).toBeTruthy();
      expect(screen.getByText('Feature Beta')).toBeTruthy();
    });
  });

  it('shows project status badges', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('active')).toBeTruthy();
      expect(screen.getByText('completed')).toBeTruthy();
    });
  });

  it('shows progress percentages', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('60%')).toBeTruthy();
      expect(screen.getByText('100%')).toBeTruthy();
    });
  });

  it('shows task counts', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('6/10 tasks')).toBeTruthy();
      expect(screen.getByText('5/5 tasks')).toBeTruthy();
    });
  });

  it('renders Import Plan button', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Import Plan')).toBeTruthy();
    });
  });

  it('renders Pause button for active projects', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Pause')).toBeTruthy();
    });
  });

  it('renders Retry Failed button for projects with failures', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Retry Failed')).toBeTruthy();
    });
  });

  it('shows failed task count', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('1 failed task')).toBeTruthy();
    });
  });

  it('renders search input when projects exist', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByPlaceholderText('Search projects...')).toBeTruthy();
    });
  });

  it('renders status filter tabs', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      // All tab is first
      expect(screen.getAllByText('All').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('Active')).toBeTruthy();
      expect(screen.getByText('Paused')).toBeTruthy();
    });
  });

  it('shows empty state when no projects', async () => {
    projectsApi.list.mockResolvedValue([]);
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('No projects yet')).toBeTruthy();
    });
  });

  it('shows delete confirmation dialog on delete', async () => {
    renderWithProviders(<PlanProjects />, { route: '/projects' });
    await waitFor(() => {
      expect(screen.getByText('Feature Alpha')).toBeTruthy();
    });
    const deleteButtons = screen.getAllByText('Delete');
    fireEvent.click(deleteButtons[0]);
    await waitFor(() => {
      expect(screen.getByText('Delete Project')).toBeTruthy();
      expect(screen.getByText(/Are you sure/)).toBeTruthy();
    });
  });
});
