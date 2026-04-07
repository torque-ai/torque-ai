import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ProjectSelector from './ProjectSelector';

vi.mock('../api', () => ({
  requestV2: vi.fn(),
}));

import { requestV2 } from '../api';

describe('ProjectSelector', () => {
  beforeEach(() => {
    requestV2.mockReset();
  });

  it('loads project options from a markdown passthrough response', async () => {
    requestV2.mockResolvedValue({
      tool: 'list_projects',
      result: [
        '## Projects',
        '',
        '| Project | Tasks | Completed | Failed | Active | Cost |',
        '|---------|-------|-----------|--------|--------|------|',
        '| alpha | 3 | 2 | 1 | 0 | $0.10 |',
      ].join('\n'),
    });

    const handleChange = vi.fn();
    render(<ProjectSelector value="" onChange={handleChange} aria-label="Project selector" />);

    await screen.findByRole('option', { name: 'alpha (3 tasks)' });
    fireEvent.change(screen.getByLabelText('Project selector'), { target: { value: 'alpha' } });

    expect(handleChange).toHaveBeenCalledWith('alpha');
  });

  it('falls back to the secondary endpoint when the first endpoint is empty', async () => {
    requestV2
      .mockResolvedValueOnce({ items: [] })
      .mockResolvedValueOnce({ items: [{ name: 'beta', task_count: 2 }] });

    render(<ProjectSelector value="" onChange={() => {}} aria-label="Project selector" />);

    await waitFor(() => {
      expect(requestV2).toHaveBeenNthCalledWith(1, '/tasks/list-projects');
      expect(requestV2).toHaveBeenNthCalledWith(2, '/projects');
    });
    expect(await screen.findByRole('option', { name: 'beta (2 tasks)' })).toBeInTheDocument();
  });
});
