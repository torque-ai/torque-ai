import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StarvationBanner } from './StarvationBanner';

describe('StarvationBanner', () => {
  it('renders STARVED project state with empty cycle count', () => {
    render(
      <StarvationBanner
        project={{
          name: 'torque-public',
          loop_state: 'STARVED',
          consecutive_empty_cycles: 4,
        }}
      />
    );

    expect(screen.getByRole('status', { name: /torque-public factory loop starved/i })).toBeInTheDocument();
    expect(screen.getByText('Factory loop starved')).toBeInTheDocument();
    expect(screen.getByText(/4 empty cycles/i)).toBeInTheDocument();
    expect(screen.getByText('STARVED')).toBeInTheDocument();
  });

  it('stays hidden for non-starved projects', () => {
    const { container } = render(<StarvationBanner project={{ name: 'torque-public', loop_state: 'IDLE' }} />);

    expect(container).toBeEmptyDOMElement();
  });
});
