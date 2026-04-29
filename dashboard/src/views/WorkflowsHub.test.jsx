import { beforeEach, describe, expect, it, vi } from 'vitest';

const tabMocks = vi.hoisted(() => ({
  workflows: vi.fn(),
  batches: vi.fn(),
  projects: vi.fn(),
}));

vi.mock('./Workflows', () => ({
  default: () => {
    tabMocks.workflows();
    return <div data-testid="workflows-tab">Workflows tab</div>;
  },
}));

vi.mock('./BatchHistory', () => ({
  default: () => {
    tabMocks.batches();
    return <div data-testid="batches-tab">Batches tab</div>;
  },
}));

vi.mock('./PlanProjects', () => ({
  default: () => {
    tabMocks.projects();
    return <div data-testid="projects-tab">Projects tab</div>;
  },
}));

import { screen } from '@testing-library/react';
import { renderWithProviders } from '../test-utils';
import WorkflowsHub from './WorkflowsHub';

describe('WorkflowsHub', () => {
  beforeEach(() => {
    tabMocks.workflows.mockClear();
    tabMocks.batches.mockClear();
    tabMocks.projects.mockClear();
  });

  it('opens the Projects tab directly when the URL hash requests it', async () => {
    renderWithProviders(<WorkflowsHub />, { route: '/workflows#projects' });

    expect(await screen.findByTestId('projects-tab')).toBeInTheDocument();
    expect(tabMocks.projects).toHaveBeenCalledTimes(1);
    expect(tabMocks.workflows).not.toHaveBeenCalled();
  });

  it('defaults to the Workflows tab when no hash is present', async () => {
    renderWithProviders(<WorkflowsHub />, { route: '/workflows' });

    expect(await screen.findByTestId('workflows-tab')).toBeInTheDocument();
    expect(tabMocks.workflows).toHaveBeenCalledTimes(1);
    expect(tabMocks.projects).not.toHaveBeenCalled();
  });
});
