'use strict';

const DECOMPOSE_CASES = [
  {
    name: 'simple_feature',
    input: {
      feature_name: 'HealthBar',
      feature_description: 'Display a health bar UI element that shows current/max HP with color gradient',
      working_directory: '/project',
      project_structure: 'src/services/, src/types/, src/models/',
    },
    expected_min_tasks: 3,
    expected_max_tasks: 8,
    required_steps: ['types', 'system'],
  },
  {
    name: 'complex_feature',
    input: {
      feature_name: 'TradeSystem',
      feature_description: 'Peer-to-peer trading system with offer/accept/reject flow, inventory validation, trade history, and anti-fraud cooldowns',
      working_directory: '/project',
      project_structure: 'src/services/, src/types/, src/models/, src/services/UserService.ts, src/services/AuthService.ts',
    },
    expected_min_tasks: 4,
    expected_max_tasks: 10,
    required_steps: ['types', 'system', 'tests'],
  },
  {
    name: 'infrastructure_task',
    input: {
      feature_name: 'MetricsCollector',
      feature_description: 'Collect and aggregate performance metrics (FPS, memory, network latency) with configurable sampling rates and export to JSON',
      working_directory: '/project',
    },
    expected_min_tasks: 2,
    expected_max_tasks: 8,
    required_steps: ['system'],
  },
];

const DIAGNOSE_CASES = [
  {
    name: 'typescript_error',
    input: {
      task_description: 'Implement HealthBarSystem',
      error_output: "src/systems/HealthBarSystem.ts(15,5): error TS2304: Cannot find name 'GameEntity'.\nsrc/systems/HealthBarSystem.ts(22,12): error TS2339: Property 'health' does not exist on type 'Entity'.",
      provider: 'codex',
      exit_code: 1,
    },
    expected_action: 'fix_task',
  },
  {
    name: 'timeout_error',
    input: {
      task_description: 'Generate comprehensive test suite',
      error_output: 'Task timed out after 600 seconds. Last output: generating test case 45 of 100...',
      provider: 'ollama',
      exit_code: 1,
    },
    expected_action: 'retry',
  },
  {
    name: 'oom_error',
    input: {
      task_description: 'Refactor large codebase',
      error_output: 'CUDA error: out of memory. Tried to allocate 2.5 GiB. GPU 0 has 8.0 GiB total, 0.3 GiB free.',
      provider: 'ollama',
      exit_code: 1,
    },
    expected_action: 'switch_provider',
  },
];

const REVIEW_CASES = [
  {
    name: 'clean_output',
    input: {
      task_description: 'Create HealthBar types',
      task_output: 'export interface HealthBarConfig { maxHp: number; currentHp: number; width: number; height: number; }\nexport type HealthBarColor = "green" | "yellow" | "red";',
      validation_failures: [],
      file_size_delta_pct: 100,
    },
    expected_decision: 'approve',
  },
  {
    name: 'stub_output',
    input: {
      task_description: 'Implement TradeSystem',
      task_output: 'export class TradeSystem {\n  // TODO: implement\n  trade() { throw new Error("not implemented"); }\n}',
      validation_failures: [{ severity: 'critical', rule: 'stub_detection', details: 'Found TODO and throw not implemented' }],
      file_size_delta_pct: 10,
    },
    expected_decision: 'reject',
  },
];

module.exports = { DECOMPOSE_CASES, DIAGNOSE_CASES, REVIEW_CASES };
