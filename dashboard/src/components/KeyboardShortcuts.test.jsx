import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ShortcutHelpOverlay, useKeyboardShortcuts } from './KeyboardShortcuts';

// Test helper component that uses the hook
function ShortcutTestHelper({ onRefresh }) {
  const { showHelp, setShowHelp, pendingG } = useKeyboardShortcuts({ onRefresh });
  return (
    <div>
      <span data-testid="show-help">{showHelp ? 'true' : 'false'}</span>
      <span data-testid="pending-g">{pendingG ? 'true' : 'false'}</span>
      {showHelp && <ShortcutHelpOverlay onClose={() => setShowHelp(false)} />}
    </div>
  );
}

function renderWithRouter(ui, route = '/') {
  return render(<MemoryRouter initialEntries={[route]}>{ui}</MemoryRouter>);
}

describe('ShortcutHelpOverlay', () => {
  it('renders keyboard shortcuts title', () => {
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
  });

  it('displays shortcut descriptions', () => {
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={() => {}} />
      </MemoryRouter>
    );
    expect(screen.getByText('Show keyboard shortcuts')).toBeInTheDocument();
    expect(screen.getByText('Focus search field')).toBeInTheDocument();
    expect(screen.getByText('Close drawer / modal')).toBeInTheDocument();
    expect(screen.getByText('Go to Kanban')).toBeInTheDocument();
    expect(screen.getByText('Go to History')).toBeInTheDocument();
  });

  it('renders close button', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={onClose} />
      </MemoryRouter>
    );
    // Close button renders the x character
    const closeBtn = screen.getByText('\u00d7');
    expect(closeBtn).toBeInTheDocument();
  });

  it('calls onClose when close button clicked', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={onClose} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText('\u00d7'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose on Escape key', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={onClose} />
      </MemoryRouter>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when backdrop clicked', () => {
    const onClose = vi.fn();
    const { container } = render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={onClose} />
      </MemoryRouter>
    );
    // The backdrop is the outermost fixed div
    const backdrop = container.querySelector('.fixed.inset-0');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not close when modal content clicked', () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <ShortcutHelpOverlay onClose={onClose} />
      </MemoryRouter>
    );
    // Click on the title inside the modal
    fireEvent.click(screen.getByText('Keyboard Shortcuts'));
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('useKeyboardShortcuts', () => {
  it('starts with showHelp false', () => {
    renderWithRouter(<ShortcutTestHelper />);
    expect(screen.getByTestId('show-help').textContent).toBe('false');
  });

  it('toggles showHelp on ? key', () => {
    renderWithRouter(<ShortcutTestHelper />);
    act(() => {
      fireEvent.keyDown(window, { key: '?', shiftKey: true });
    });
    expect(screen.getByTestId('show-help').textContent).toBe('true');
  });
});
