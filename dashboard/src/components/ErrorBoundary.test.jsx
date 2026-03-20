import { render, renderHook, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import ErrorBoundary from './ErrorBoundary';

function ThrowingComponent({ shouldThrow = true }) {
  if (shouldThrow) {
    throw new Error('Test render error');
  }
  return <div>Normal content</div>;
}

function ThrowGeneric() {
  throw new Error('');
}

function ControlledBoundary({ shouldThrow }) {
  return (
    <ErrorBoundary>
      <ThrowingComponent shouldThrow={shouldThrow} />
    </ErrorBoundary>
  );
}

function HookRuleViolationChild({ addExtraHook }) {
  const [baseline] = useState('baseline');

  if (addExtraHook) {
    // eslint-disable-next-line react-hooks/rules-of-hooks
    const [unstable] = useState('unstable');
    return <div>Hook rule child {baseline} {unstable}</div>;
  }

  return <div>Hook rule child {baseline}</div>;
}

function UpdateParentStateInRenderChild({ onRequestUpdate }) {
  onRequestUpdate();
  return <div>Render-time state update child</div>;
}

function RenderTimeStateUpdateBoundary() {
  const [updated, setUpdated] = useState(false);

  return (
    <ErrorBoundary>
      <UpdateParentStateInRenderChild
        onRequestUpdate={() => {
          if (!updated) {
            setUpdated(true);
          }
        }}
      />
    </ErrorBoundary>
  );
}

function NestedBoundaryHarness({ innerThrows = true, outerSiblingThrows = false }) {
  return (
    <ErrorBoundary>
      <div>Outer boundary safe start</div>
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={innerThrows} />
      </ErrorBoundary>
      <div>Outer boundary safe end</div>
      {outerSiblingThrows && <ThrowingComponent />}
    </ErrorBoundary>
  );
}

// Suppress console.error for expected error boundary logs
const originalConsoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    if (typeof args[0] === 'string' && (
      args[0].includes('Dashboard error:') ||
      args[0].includes('The above error occurred') ||
      args[0].includes('Error: Uncaught')
    )) {
      return;
    }
    originalConsoleError(...args);
  });
});
afterAll(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders children when no error occurs', () => {
    render(
      <ErrorBoundary>
        <div>Child content</div>
      </ErrorBoundary>
    );
    expect(screen.getByText('Child content')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('displays the error message', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Test render error')).toBeInTheDocument();
  });

  it('renders Try Again button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Try Again')).toBeInTheDocument();
  });

  it('shows complete fallback UI with accessible heading and button', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeInTheDocument();
    expect(screen.getByText('Test render error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  it('does not render normal child content while fallback is shown', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.queryByText('Normal content')).toBeNull();
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('recovers when Try Again is clicked and error is resolved', () => {
    const { rerender } = render(
      <ControlledBoundary shouldThrow={true} />
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      rerender(<ControlledBoundary shouldThrow={false} />);
    });

    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('keeps fallback UI after Try Again when child still throws', () => {
    render(
      <ControlledBoundary shouldThrow={true} />
    );
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
  });

  it('uses renderHook-driven control for boundary throw state and recovery', () => {
    const { result } = renderHook(() => useState(false));
    const { rerender } = render(
      <ControlledBoundary shouldThrow={result.current[0]} />
    );

    expect(screen.getByText('Normal content')).toBeInTheDocument();

    act(() => {
      result.current[1](true);
    });
    rerender(<ControlledBoundary shouldThrow={result.current[0]} />);
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      result.current[1](false);
    });
    rerender(<ControlledBoundary shouldThrow={result.current[0]} />);

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });

    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('shows fallback message for error without message', () => {
    render(
      <ErrorBoundary>
        <ThrowGeneric />
      </ErrorBoundary>
    );
    expect(screen.getByText('An unexpected error occurred')).toBeInTheDocument();
  });

  it('captures hook rule violations in a child component', () => {
    const { rerender } = render(
      <ErrorBoundary>
        <HookRuleViolationChild addExtraHook={false} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Hook rule child baseline')).toBeInTheDocument();

    act(() => {
      rerender(
        <ErrorBoundary>
          <HookRuleViolationChild addExtraHook />
        </ErrorBoundary>
      );
    });

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText(/Rendered (more|fewer) hooks than/)).toBeInTheDocument();
  });

  it('captures state update errors from children during render', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <RenderTimeStateUpdateBoundary />
    );

    expect(screen.getByText('Render-time state update child')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(
      consoleSpy.mock.calls.some((call) => call.some(
        (arg) => typeof arg === 'string' && arg.includes('Cannot update a component')
      ))
    ).toBe(true);

    consoleSpy.mockRestore();
  });

  it('keeps outer boundary content when only inner boundary child throws', () => {
    render(
      <NestedBoundaryHarness innerThrows={true} outerSiblingThrows={false} />
    );
    expect(screen.getByText('Outer boundary safe start')).toBeInTheDocument();
    expect(screen.getByText('Outer boundary safe end')).toBeInTheDocument();
    expect(screen.getAllByText('Something went wrong')).toHaveLength(1);
  });

  it('escapes to outer boundary when sibling outside inner boundary throws', () => {
    render(
      <NestedBoundaryHarness innerThrows={false} outerSiblingThrows={true} />
    );
    expect(screen.getAllByText('Something went wrong')).toHaveLength(1);
    expect(screen.queryByText('Outer boundary safe start')).toBeNull();
    expect(screen.queryByText('Outer boundary safe end')).toBeNull();
  });

  it('recovers an inner boundary while outer boundary remains stable', () => {
    const { rerender } = render(
      <NestedBoundaryHarness innerThrows />
    );

    expect(screen.getByText('Outer boundary safe start')).toBeInTheDocument();
    expect(screen.getByText('Outer boundary safe end')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
      rerender(<NestedBoundaryHarness innerThrows={false} />);
    });

    expect(screen.queryByText('Something went wrong')).toBeNull();
    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('supports multiple recover-and-throw cycles on the same boundary', () => {
    const { rerender } = render(
      <ControlledBoundary shouldThrow={false} />
    );

    expect(screen.getByText('Normal content')).toBeInTheDocument();

    act(() => {
      rerender(<ControlledBoundary shouldThrow />);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      rerender(<ControlledBoundary shouldThrow={false} />);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });

    expect(screen.getByText('Normal content')).toBeInTheDocument();

    act(() => {
      rerender(<ControlledBoundary shouldThrow />);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      rerender(<ControlledBoundary shouldThrow={false} />);
    });
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    });

    expect(screen.getByText('Normal content')).toBeInTheDocument();
  });

  it('logs error and component stack from componentDidCatch', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );

    const logCall = consoleSpy.mock.calls.find((call) => call[0] === 'Dashboard error:');

    expect(logCall).toBeTruthy();
    expect(logCall[1]).toBeInstanceOf(Error);
    expect(logCall[1].message).toBe('Test render error');
    expect(logCall[2]).toContain('ThrowingComponent');
    consoleSpy.mockRestore();
  });

  it('logs component stack for hook-order violation details', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { rerender } = render(
      <ErrorBoundary>
        <HookRuleViolationChild addExtraHook={false} />
      </ErrorBoundary>
    );

    act(() => {
      rerender(
        <ErrorBoundary>
          <HookRuleViolationChild addExtraHook />
        </ErrorBoundary>
      );
    });

    const logCall = consoleSpy.mock.calls.find((call) => call[0] === 'Dashboard error:');

    expect(logCall).toBeTruthy();
    expect(logCall[1]).toBeInstanceOf(Error);
    expect(logCall[2]).toContain('HookRuleViolationChild');
    consoleSpy.mockRestore();
  });

  it('re-mounts boundary state when key changes', () => {
    const { rerender } = render(
      <ErrorBoundary key="first">
        <ThrowingComponent />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    act(() => {
      rerender(
        <ErrorBoundary key="second">
          <ThrowingComponent shouldThrow={false} />
        </ErrorBoundary>
      );
    });
    expect(screen.getByText('Normal content')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).toBeNull();
  });

  it('isolates failures between sibling error boundaries', () => {
    render(
      <div>
        <ErrorBoundary>
          <ThrowingComponent />
        </ErrorBoundary>
        <ErrorBoundary>
          <div>Sibling boundary healthy content</div>
        </ErrorBoundary>
      </div>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByText('Sibling boundary healthy content')).toBeInTheDocument();
  });

  it('keeps fallback UI after repeated reset clicks if child still throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent />
      </ErrorBoundary>
    );
    const retryButton = screen.getByRole('button', { name: /try again/i });

    act(() => {
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
      fireEvent.click(retryButton);
    });

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
