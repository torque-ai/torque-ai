import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ToastProvider } from './components/Toast';

export function renderWithProviders(ui, { route = '/', ...options } = {}) {
  function Wrapper({ children }) {
    return (
      <MemoryRouter initialEntries={[route]}>
        <ToastProvider>
          {children}
        </ToastProvider>
      </MemoryRouter>
    );
  }
  return render(ui, { wrapper: Wrapper, ...options });
}

export function mockFetch(data, options = {}) {
  const { status = 200, ok = true, headers = { 'content-type': 'application/json' } } = options;
  return vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: (key) => headers[key.toLowerCase()] || null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
    clone: () => ({
      ok,
      status,
      headers: { get: (key) => headers[key.toLowerCase()] || null },
      json: () => Promise.resolve(data),
      text: () => Promise.resolve(JSON.stringify(data)),
    }),
  });
}
