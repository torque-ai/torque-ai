import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import StarvationBanner from './StarvationBanner';

describe('StarvationBanner', () => {
  it('renders when project is STARVED', () => {
    render(
      <StarvationBanner
        project={{
          id: 'p1',
          name: 'sample',
          loop_state: 'STARVED',
          loop_last_action_at: '2026-04-20T20:00:00Z',
          consecutive_empty_cycles: 5,
        }}
      />,
    );
    expect(screen.getByText(/sample is starved/i)).toBeInTheDocument();
    expect(screen.getByText(/5 empty cycles/i)).toBeInTheDocument();
  });

  it('renders nothing when project is not STARVED', () => {
    const { container } = render(
      <StarvationBanner
        project={{ id: 'p2', name: 'healthy', loop_state: 'EXECUTE' }}
      />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when project is null/undefined', () => {
    const { container } = render(<StarvationBanner project={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('treats missing consecutive_empty_cycles as 0', () => {
    render(
      <StarvationBanner
        project={{ id: 'p3', name: 'starved-no-counter', loop_state: 'STARVED' }}
      />,
    );
    expect(screen.getByText(/0 empty cycles/i)).toBeInTheDocument();
  });
});
