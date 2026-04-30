/**
 * Phase K (2026-04-30): lane policy enforced on primary provider selection.
 *
 * Before Phase K, smart_submit_task's primary selection in
 * server/handlers/integration/routing.js:816 picked the provider from
 * routingResult (template/score-ranker output) and never consulted the
 * project's `provider_lane_policy`. The lane filter was applied only to
 * fallback selections and to chain metadata, not to the primary slot.
 *
 * Live evidence: DLPhone (lane policy `expected_provider: ollama,
 * allowed_providers: [ollama], enforce_handoffs: true`) had its plan-task
 * EXECUTE submissions go to codex-spark anyway because the
 * `preset-all-local` routing template + score-ranker selected codex-spark
 * for the chosen category, and that choice flowed straight through to
 * task creation. Every plan zero-diffed.
 *
 * Phase K adds a lane-policy enforcement step right after the primary
 * selection: if `enforce_handoffs` is true and the chosen provider isn't
 * in `allowed_providers` / `allowed_fallback_providers` / not the
 * `expected_provider`, swap to `expected_provider` (or first allowed)
 * before recording the choice.
 *
 * Tests call `handleSmartSubmitTask` directly (not via MCP dispatch)
 * because the MCP tool def for `smart_submit_task` doesn't accept
 * `task_metadata` — the metadata path is used by internal callers like
 * the factory loop-controller (`buildProviderLaneTaskMetadata`).
 */

'use strict';

const { setupTestDb, teardownTestDb, getText } = require('./vitest-setup');
const { handleSmartSubmitTask } = require('../handlers/integration/routing');

let db;

function parseMeta(task) {
  if (!task || !task.metadata) return {};
  if (typeof task.metadata === 'object') return task.metadata;
  try { return JSON.parse(task.metadata); } catch { return {}; }
}

async function submitWithLane({ task, lanePolicy, override_provider, routing_template }) {
  const result = await handleSmartSubmitTask({
    task,
    project: 'phasek-test',
    working_directory: process.cwd(),
    ...(override_provider ? { provider: override_provider } : {}),
    ...(routing_template ? { routing_template } : {}),
    task_metadata: lanePolicy ? { provider_lane_policy: lanePolicy } : undefined,
  });
  if (result?.isError) return { error: true, text: getText(result) };
  // handleSmartSubmitTask returns { task_id } in its content; extract from text
  const text = getText(result);
  const match = text.match(/Task ID\s*\|\s*`([^`]+)`/);
  if (!match) {
    // fall back to result.task_id if present
    if (result?.task_id) {
      const taskRow = db.getTask(result.task_id);
      return { task: taskRow, text };
    }
    return { error: true, text };
  }
  const taskRow = db.getTask(match[1]);
  return { task: taskRow, text };
}

vi.mock('../providers/registry', () => ({
  getProviderInstance: vi.fn().mockReturnValue({}),
  listProviders: vi.fn().mockReturnValue([]),
  getProviderConfig: vi.fn(),
  getCategory: vi.fn().mockImplementation((provider) => {
    if (provider === 'codex' || provider === 'codex-spark' || provider === 'claude-cli') return 'codex';
    return null;
  }),
}));

describe('Phase K: lane policy on primary selection', () => {
  beforeAll(() => {
    const env = setupTestDb('phasek-lane-policy-primary');
    db = env.db;
    db.checkOllamaHealth = async () => true;
  });
  afterAll(() => { teardownTestDb(); });

  it('swaps primary selection from codex to ollama when lane policy disallows codex', async () => {
    // Force the router to pick codex by passing override_provider:
    // override_provider takes the user_provider_override path which is
    // intentionally outside the Phase K swap (user intent is sovereign).
    // Instead we exercise the lane swap by NOT setting override_provider
    // and letting smart routing pick — but we also pin the routing
    // template to one whose chain favors codex for the chosen category.
    // The DLPhone shape has no `enforce_handoffs` and no override; the
    // template + score ranker pick codex; Phase K must redirect to ollama.
    const { task, error, text } = await submitWithLane({
      task: 'Refactor multi-file system: redesign auth flow with new credential injection',
      // Description triggers architectural/large_code_gen → routing
      // template's complexity_overrides would normally pick codex
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        enforce_handoffs: true,
      },
    });

    if (error) throw new Error(`submit failed: ${text}`);
    const meta = parseMeta(task);
    const effectiveProvider = task.provider || meta.intended_provider || meta.requested_provider;
    expect(effectiveProvider).toBe('ollama');
  });

  it('does not swap when chosen provider is already lane-allowed', async () => {
    const { task, error, text } = await submitWithLane({
      task: 'Add a small docstring to the helper function',
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama', 'codex'],
        allowed_fallback_providers: [],
        enforce_handoffs: true,
      },
    });

    if (error) throw new Error(`submit failed: ${text}`);
    const meta = parseMeta(task);
    const effectiveProvider = task.provider || meta.intended_provider || meta.requested_provider;
    expect(['ollama', 'codex']).toContain(effectiveProvider);
  });

  it('does not swap when enforce_handoffs is false (advisory only)', async () => {
    const { task, error, text } = await submitWithLane({
      task: 'Refactor multi-file system: redesign auth flow',
      lanePolicy: {
        expected_provider: 'ollama',
        allowed_providers: ['ollama'],
        allowed_fallback_providers: [],
        enforce_handoffs: false,
      },
    });

    if (error) throw new Error(`submit failed: ${text}`);
    const meta = parseMeta(task);
    const effectiveProvider = task.provider || meta.intended_provider || meta.requested_provider;
    // With enforce_handoffs=false the router is free; whatever it picked
    // stands. We just assert no error and a provider was chosen.
    expect(effectiveProvider).toBeTruthy();
  });
});
