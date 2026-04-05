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

      if (url === '/api/v2/project-config?project=alpha') {
        return createResponse({
          data: {
            default_provider: 'codex',
            default_model: 'gpt-5.3-codex-spark',
            verify_command: 'npm test',
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

      if (url === '/api/v2/routing/active') {
        return createResponse({
          data: {
            explicit: true,
            template: { id: 'tmpl-1', name: 'Quality First' },
          },
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

  it('skips optional provider score and budget sections when those endpoints are unavailable', async () => {
    globalThis.fetch = vi.fn((url) => {
      if (url === '/api/project-config?project=beta') {
        return createResponse({
          default_provider: 'ollama',
          default_model: 'qwen2.5-coder:32b',
          verify_command: 'npm run build',
          auto_fix_enabled: 0,
          default_timeout: 30,
        });
      }

      if (url === '/api/v2/routing/templates') {
        return createResponse({
          data: [{ id: 'tmpl-1', name: 'System Default', preset: true }],
        });
      }

      if (url === '/api/v2/routing/active') {
        return createResponse({
          data: {
            explicit: false,
            template: { id: 'tmpl-1', name: 'System Default' },
          },
        });
      }

      if (url === '/api/provider-scores' || url === '/api/cost-budgets' || url === '/api/v2/budget/status') {
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
});
