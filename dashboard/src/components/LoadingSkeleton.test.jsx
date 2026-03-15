import { render, screen } from '@testing-library/react';
import LoadingSkeleton from './LoadingSkeleton';

describe('LoadingSkeleton', () => {
  it('renders with default 3 lines', () => {
    render(<LoadingSkeleton />);
    const skeleton = screen.getByTestId('loading-skeleton');
    expect(skeleton.children.length).toBe(3);
  });

  it('renders specified number of lines', () => {
    render(<LoadingSkeleton lines={5} />);
    const skeleton = screen.getByTestId('loading-skeleton');
    expect(skeleton.children.length).toBe(5);
  });

  it('applies custom height to bars', () => {
    render(<LoadingSkeleton lines={2} height={24} />);
    const skeleton = screen.getByTestId('loading-skeleton');
    const bars = skeleton.children;
    expect(bars[0].style.height).toBe('24px');
    expect(bars[1].style.height).toBe('24px');
  });

  it('uses animate-pulse class', () => {
    render(<LoadingSkeleton />);
    const skeleton = screen.getByTestId('loading-skeleton');
    expect(skeleton.className).toContain('animate-pulse');
  });

  it('uses bg-slate-700 on bars', () => {
    render(<LoadingSkeleton lines={1} />);
    const skeleton = screen.getByTestId('loading-skeleton');
    expect(skeleton.children[0].className).toContain('bg-slate-700');
  });
});
