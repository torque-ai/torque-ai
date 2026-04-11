import { render, screen, fireEvent } from '@testing-library/react';
import Onboarding from '../Onboarding';

describe('Onboarding', () => {
  it('renders the first onboarding step by default', () => {
    render(<Onboarding onDismiss={() => {}} />);

    expect(screen.getByText('Welcome to TORQUE')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Register a Project' })).toBeInTheDocument();
    expect(
      screen.getByText('set_project_defaults({ working_directory: "/path/to/your/project", provider: "codex" })')
    ).toBeInTheDocument();
  });

  it('navigates between onboarding steps', () => {
    render(<Onboarding onDismiss={() => {}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('heading', { name: 'Scan Your Codebase' })).toBeInTheDocument();
    expect(screen.getByText('scan_project({ path: "/path/to/your/project" })')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('heading', { name: 'Register a Project' })).toBeInTheDocument();
  });

  it('calls onDismiss when the final step is completed', () => {
    const onDismiss = vi.fn();
    render(<Onboarding onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(screen.getByRole('heading', { name: 'Submit Your First Task' })).toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
