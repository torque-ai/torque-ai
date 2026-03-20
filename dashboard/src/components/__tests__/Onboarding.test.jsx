import { render, screen, fireEvent } from '@testing-library/react';
import Onboarding from '../Onboarding';

describe('Onboarding', () => {
  it('renders welcome message', () => {
    render(<Onboarding onDismiss={() => {}} />);

    expect(screen.getByText('Welcome to TORQUE')).toBeInTheDocument();
    expect(screen.getByText('Your distributed AI task orchestration platform is ready.')).toBeInTheDocument();
  });

  it('calls onDismiss when button is clicked', () => {
    const onDismiss = vi.fn();
    render(<Onboarding onDismiss={onDismiss} />);

    fireEvent.click(screen.getByRole('button', { name: "Got it — let's go!" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows key features list', () => {
    render(<Onboarding onDismiss={() => {}} />);

    expect(screen.getByText('Key Features')).toBeInTheDocument();
    expect(screen.getByText(/10 providers/i)).toBeInTheDocument();
    expect(screen.getByText(/DAG workflows/i)).toBeInTheDocument();
    expect(screen.getByText(/Smart routing/i)).toBeInTheDocument();
    expect(screen.getByText(/Quality gates/i)).toBeInTheDocument();
  });
});
