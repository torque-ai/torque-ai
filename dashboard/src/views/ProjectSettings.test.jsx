import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import ProjectSettings from './ProjectSettings';
import { renderWithProviders } from '../test-utils';

function createResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  const headers = new Map([
    ['content-type', contentType],
  ]);

  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key) => headers.get(String(key).toLowerCase()) ?? null,
    },
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('ProjectSettings', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('loads project defaults and posts updated settings', async () => {
    let postedBody = null;

    globalThis.fetch = vi.fn((url, options = {}) => {
      const method = String(options.method || 'GET').toUpperCase();

      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({
          data: [
            { name: 'alpha', task_count: 5, last_active: '2026-01-15T10:30:00Z' },
          ],
        });
      }

      if (url === '/api/v2/tasks/list-project-configs') {
        return createResponse({
          data: [{ project: 'alpha' }],
        });
      }

      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({
          data: {
            default_provider: 'codex',
            default_model: 'gpt-5.3-codex-spark',
            verify_command: 'npm test',
            routing_template_id: 'tmpl-1',
            auto_fix_enabled: 1,
            default_timeout: 45,
          },
        });
      }

      if (url === '/api/v2/routing/templates') {
        return createResponse({
          data: [
            { id: 'tmpl-1', name: 'Quality First', preset: true },
            { id: 'tmpl-2', name: 'Cost Saver', preset: true },
          ],
        });
      }

      if (url === '/api/v2/provider-scores') {
        return createResponse([
          {
            provider: 'codex',
            composite_score: 0.92,
            reliability_score: 0.98,
            quality_score: 0.95,
            speed_score: 0.6,
            avg_cost_usd: 0.12,
            trusted: 1,
          },
        ]);
      }

      if (url === '/api/v2/cost-budgets') {
        return createResponse([
          {
            id: 'budget-1',
            name: 'Main Budget',
            current_spend: 12.5,
            budget_usd: 50,
            period: 'monthly',
          },
        ]);
      }

      if (url === '/api/v2/project-config' && method === 'POST') {
        postedBody = JSON.parse(options.body);
        return createResponse({ data: { ok: true } });
      }

      throw new Error(`Unhandled fetch: ${method} ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });

    await screen.findByText('Current Project Defaults');

    expect(screen.getByDisplayValue('codex')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-5.3-codex-spark')).toBeInTheDocument();
    expect(screen.getByText('Provider Scores')).toBeInTheDocument();
    expect(screen.getByText('Budget Status')).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('codex'), { target: { value: 'deepinfra' } });
    fireEvent.change(screen.getByDisplayValue('gpt-5.3-codex-spark'), { target: { value: 'Qwen/Qwen2.5-72B-Instruct' } });
    fireEvent.change(screen.getByDisplayValue('npm test'), { target: { value: 'npm run verify' } });
    fireEvent.change(screen.getByDisplayValue('45'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Defaults' }));

    await waitFor(() => {
      expect(postedBody).toEqual({
        project: 'alpha',
        default_provider: 'deepinfra',
        default_model: 'Qwen/Qwen2.5-72B-Instruct',
        verify_command: 'npm run verify',
        auto_fix_enabled: true,
        default_timeout: 60,
      });
    });
  });

  it('shows known projects before selection and loads settings from the table', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({
          data: [
            { name: 'alpha', task_count: 4, last_active: '2026-01-16T11:00:00Z' },
            { name: 'beta', task_count: 1, last_active: '2026-01-14T08:00:00Z' },
          ],
        });
      }

      if (url === '/api/v2/tasks/list-project-configs') {
        return createResponse({
          data: [{ project: 'alpha' }],
        });
      }

      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({
          data: {
            default_provider: 'codex',
            default_model: 'gpt-5.3-codex-spark',
            verify_command: 'npm test',
            routing_template_id: null,
            auto_fix_enabled: 1,
            default_timeout: 45,
          },
        });
      }

      if (url === '/api/v2/routing/templates') {
        return createResponse({
          data: [{ id: 'tmpl-1', name: 'System Default', preset: true }],
        });
      }

      if (url === '/api/v2/provider-scores') {
        return createResponse([]);
      }

      if (url === '/api/v2/cost-budgets') {
        return createResponse([]);
      }

      throw new Error(`Unhandled fetch: GET ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings' });

    await screen.findByText('Known Projects');

    expect(screen.getByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'alpha' }));

    await screen.findByText('Current Project Defaults');
    expect(screen.getByDisplayValue('codex')).toBeInTheDocument();
  });

  it('skips optional provider score and budget sections when those endpoints are unavailable', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({
          data: [
            { name: 'beta', task_count: 2, last_active: '2026-01-15T09:00:00Z' },
          ],
        });
      }

      if (url === '/api/v2/tasks/list-project-configs') {
        return createResponse({
          data: [],
        });
      }

      if (url === '/api/v2/project-config?project=beta') {
        return createResponse({
          data: {
            default_provider: 'ollama',
            default_model: 'qwen2.5-coder:32b',
            verify_command: 'npm run build',
            routing_template_id: null,
            auto_fix_enabled: 0,
            default_timeout: 30,
          },
        });
      }

      if (url === '/api/v2/routing/templates') {
        return createResponse({
          data: [{ id: 'tmpl-1', name: 'System Default', preset: true }],
        });
      }

      if (url === '/api/v2/provider-scores' || url === '/api/v2/cost-budgets' || url === '/api/v2/budget/status') {
        return createResponse({ error: 'Not found' }, { status: 404 });
      }

      throw new Error(`Unhandled fetch: GET ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings?project=beta' });

    await screen.findByText('Current Project Defaults');

    expect(screen.queryByText('Provider Scores')).toBeNull();
    expect(screen.queryByText('Budget Status')).toBeNull();
    expect(screen.getByText('Routing Template')).toBeInTheDocument();
  });

  it('fetches provider list and captures factory trust_level on load', async () => {
    let providersFetched = false;
    let factoryFetched = false;

    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
      }
      if (url === '/api/v2/tasks/list-project-configs') {
        return createResponse({ data: [{ project: 'alpha' }] });
      }
      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({
          data: {
            default_provider: 'ollama', default_model: 'qwen3-coder:30b',
            verify_command: '', routing_template_id: null,
            auto_fix_enabled: 0, default_timeout: 30,
          },
        });
      }
      if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
      if (url === '/api/v2/provider-scores') return createResponse([]);
      if (url === '/api/v2/cost-budgets') return createResponse([]);
      if (url === '/api/v2/factory/projects') {
        factoryFetched = true;
        return createResponse({
          data: {
            projects: [{
              id: 'fp-1', name: 'alpha', trust_level: 'guided',
              config_json: JSON.stringify({
                provider_lane_policy: {
                  expected_provider: 'ollama',
                  allowed_providers: ['ollama'],
                  allowed_fallback_providers: [],
                  by_kind: { architect_cycle: 'codex' },
                  enforce_handoffs: true,
                },
              }),
            }],
          },
        });
      }
      if (url === '/api/v2/providers') {
        providersFetched = true;
        return createResponse({
          data: { items: [{ name: 'ollama' }, { name: 'codex' }, { name: 'codex-spark' }] },
        });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });

    await screen.findByText('Factory Lane Policy');
    await waitFor(() => expect(providersFetched).toBe(true));
    await waitFor(() => expect(factoryFetched).toBe(true));
  });
});

describe('FactoryLanePolicyPanel — editor controls', () => {
  let originalFetch;

  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  function mountWithLanePolicy({ lanePolicy, providers = ['ollama', 'codex', 'codex-spark'] } = {}) {
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/v2/tasks/list-projects') {
        return createResponse({ data: [{ name: 'alpha', task_count: 1, last_active: '2026-01-15T10:30:00Z' }] });
      }
      if (url === '/api/v2/tasks/list-project-configs') return createResponse({ data: [{ project: 'alpha' }] });
      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({ data: { default_provider: 'ollama', default_model: '', verify_command: '', routing_template_id: null, auto_fix_enabled: 0, default_timeout: 30 } });
      }
      if (url === '/api/v2/routing/templates') return createResponse({ data: [] });
      if (url === '/api/v2/provider-scores') return createResponse([]);
      if (url === '/api/v2/cost-budgets') return createResponse([]);
      if (url === '/api/v2/factory/projects') {
        return createResponse({
          data: { projects: [{
            id: 'fp-1', name: 'alpha', trust_level: 'guided',
            config_json: JSON.stringify({ provider_lane_policy: lanePolicy }),
          }] },
        });
      }
      if (url === '/api/v2/providers') {
        return createResponse({ data: { items: providers.map((n) => ({ name: n })) } });
      }
      throw new Error(`Unhandled fetch: ${url}`);
    });

    renderWithProviders(<ProjectSettings />, { route: '/settings?project=alpha' });
  }

  it('renders editable per-kind dropdowns with sentinel option', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: { architect_cycle: 'codex' },
        enforce_handoffs: true,
      },
    });

    await screen.findByText('Factory Lane Policy');

    const architectSelect = await screen.findByLabelText('Provider for architect_cycle');
    expect(architectSelect.tagName).toBe('SELECT');
    expect(architectSelect.value).toBe('codex');

    expect(architectSelect.querySelector('option[value=""]')).not.toBeNull();
    expect(architectSelect.querySelector('option[value=""]').textContent).toContain('use default');

    expect(architectSelect.querySelector('option[value="codex"]')).not.toBeNull();
    expect(architectSelect.querySelector('option[value="ollama"]')).not.toBeNull();

    const executeSelect = await screen.findByLabelText('Provider for execute');
    expect(executeSelect.value).toBe('');
  });

  it('renders editable expected_provider with — none — sentinel', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: [],
        allowed_fallback_providers: [],
        by_kind: {},
        enforce_handoffs: false,
      },
    });

    await screen.findByText('Factory Lane Policy');
    const expectedSelect = await screen.findByLabelText('Expected provider');
    expect(expectedSelect.tagName).toBe('SELECT');
    expect(expectedSelect.value).toBe('ollama');
    expect(expectedSelect.querySelector('option[value=""]').textContent).toContain('none');
  });

  it('closes the multi-select when the user clicks outside', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: [],
        allowed_fallback_providers: [],
        by_kind: {},
        enforce_handoffs: false,
      },
    });
    await screen.findByText('Factory Lane Policy');

    // Open the Allowed providers multi-select.
    const button = screen.getAllByLabelText('Allowed providers')[0];
    fireEvent.click(button);
    expect(await screen.findByRole('listbox', { name: 'Allowed providers' })).toBeInTheDocument();

    // Click on a non-listbox region (the panel header).
    fireEvent.mouseDown(screen.getByText('Factory Lane Policy'));

    // Listbox should no longer be in the DOM.
    await waitFor(() => {
      expect(screen.queryByRole('listbox', { name: 'Allowed providers' })).toBeNull();
    });
  });

  function captureSaveBody() {
    let posted = null;
    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
        posted = JSON.parse(options.body);
        return createResponse({ data: { ok: true } });
      }
      return baseFetch(url, options);
    });
    return () => posted;
  }

  it('saves a per-kind dropdown change as a full-policy PUT', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: { architect_cycle: 'codex' },
        enforce_handoffs: true,
      },
    });
    await screen.findByText('Factory Lane Policy');
    const getPosted = captureSaveBody();

    fireEvent.change(screen.getByLabelText('Provider for plan_generation'), { target: { value: 'codex' } });

    await waitFor(() => expect(getPosted()).not.toBeNull());

    expect(getPosted()).toEqual({
      trust_level: 'guided',
      config: {
        provider_lane_policy: {
          expected_provider: 'ollama',
          allowed_providers: ['ollama'],
          allowed_fallback_providers: [],
          by_kind: { architect_cycle: 'codex', plan_generation: 'codex' },
          enforce_handoffs: true,
        },
      },
    });

    // Post-condition: the optimistic update is also visible after the PUT resolved
    // (guards against a future refactor that delays setLanePolicy until after the await)
    expect(screen.getByLabelText('Provider for plan_generation').value).toBe('codex');
  });

  it('selecting — use default — deletes the by_kind key', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: { architect_cycle: 'codex' },
        enforce_handoffs: false,
      },
    });
    await screen.findByText('Factory Lane Policy');
    const getPosted = captureSaveBody();

    fireEvent.change(screen.getByLabelText('Provider for architect_cycle'), { target: { value: '' } });

    await waitFor(() => expect(getPosted()).not.toBeNull());
    expect(getPosted().config.provider_lane_policy.by_kind).toEqual({});
  });

  it('toggling allowed_providers checkbox round-trips the PUT', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: {},
        enforce_handoffs: false,
      },
    });
    await screen.findByText('Factory Lane Policy');
    const getPosted = captureSaveBody();

    // Open the multi-select (the button has aria-label="Allowed providers")
    fireEvent.click(screen.getAllByLabelText('Allowed providers')[0]);

    // Click the codex checkbox inside the popped listbox
    const listbox = await screen.findByRole('listbox', { name: 'Allowed providers' });
    const codexBox = Array.from(listbox.querySelectorAll('label'))
      .find((l) => l.textContent.includes('codex'))
      .querySelector('input[type="checkbox"]');
    fireEvent.click(codexBox);

    await waitFor(() => expect(getPosted()).not.toBeNull());
    expect(getPosted().config.provider_lane_policy.allowed_providers).toEqual(['ollama', 'codex']);
  });

  it('reverts optimistic state when the PUT fails', async () => {
    mountWithLanePolicy({
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        by_kind: {},
        enforce_handoffs: false,
      },
    });
    await screen.findByText('Factory Lane Policy');

    const baseFetch = globalThis.fetch;
    globalThis.fetch = vi.fn((url, options = {}) => {
      if (url === '/api/v2/factory/projects/fp-1/trust' && String(options.method).toUpperCase() === 'PUT') {
        return createResponse({ error: { message: 'boom' } }, { status: 500 });
      }
      return baseFetch(url, options);
    });

    fireEvent.change(screen.getByLabelText('Expected provider'), { target: { value: 'codex' } });

    // Wait until select reverts to ollama (revert path) — give microtasks time.
    await waitFor(() => {
      expect(screen.getByLabelText('Expected provider').value).toBe('ollama');
    });
  });
});
