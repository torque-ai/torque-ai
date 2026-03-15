import { render, screen } from '@testing-library/react';
import StatCard from './StatCard';

describe('StatCard', () => {
  it('renders label and value', () => {
    render(<StatCard label="Total Tasks" value={42} />);
    expect(screen.getByText('Total Tasks')).toBeTruthy();
    expect(screen.getByText('42')).toBeTruthy();
  });

  it('renders subtext when provided', () => {
    render(<StatCard label="Tasks" value={10} subtext="Last 7 days" />);
    expect(screen.getByText('Last 7 days')).toBeTruthy();
  });

  it('does not render subtext when not provided', () => {
    const { container } = render(<StatCard label="Tasks" value={10} />);
    // subtext element has class text-xs mt-1 — should not exist
    const subtextElements = container.querySelectorAll('p.text-xs');
    expect(subtextElements.length).toBe(0);
  });

  it('renders positive trend indicator', () => {
    const { container } = render(<StatCard label="Rate" value="95%" trend={5} />);
    // trend > 0 shows green text with percentage
    const trendEl = container.querySelector('.text-green-400');
    expect(trendEl).toBeTruthy();
    expect(trendEl.textContent).toContain('5');
  });

  it('renders negative trend indicator', () => {
    const { container } = render(<StatCard label="Rate" value="80%" trend={-3} />);
    // trend < 0 shows red text
    const trendEl = container.querySelector('.text-red-400');
    expect(trendEl).toBeTruthy();
    expect(trendEl.textContent).toContain('3');
  });

  it('renders zero trend with right arrow', () => {
    const { container } = render(<StatCard label="Rate" value="90%" trend={0} />);
    // trend === 0 shows green text (>= 0 is green)
    const trendEl = container.querySelector('.text-green-400');
    expect(trendEl).toBeTruthy();
    expect(trendEl.textContent).toContain('0');
  });

  it('applies gradient class when gradient prop provided', () => {
    const { container } = render(<StatCard label="Tasks" value={5} gradient="blue" />);
    expect(container.firstChild.className).toContain('stat-gradient-blue');
  });

  it('renders icon when provided', () => {
    render(<StatCard label="Tasks" value={5} icon="F" />);
    expect(screen.getByText('F')).toBeTruthy();
  });

  it('does not render trend element when trend is undefined', () => {
    const { container } = render(<StatCard label="Rate" value="100%" />);
    // No trend span should exist
    const baselineDiv = container.querySelector('.flex.items-baseline.gap-2');
    // Only the value <p> element, no trend <span>
    expect(baselineDiv.children.length).toBe(1);
  });

  it('applies non-gradient styling when gradient not provided', () => {
    const { container } = render(<StatCard label="Tasks" value={5} />);
    expect(container.firstChild.className).toContain('bg-slate-800');
  });
});
