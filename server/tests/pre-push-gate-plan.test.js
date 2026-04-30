'use strict';

import { describe, it, expect } from 'vitest';

const { planFromFiles, toShell } = require('../../scripts/pre-push-gate-plan');

describe('pre-push gate planner', () => {
  it('skips heavy phases for documentation-only changes', () => {
    const plan = planFromFiles(['docs/runbooks/gate.md', 'README.md'], {
      base: 'base',
      head: 'head',
    });

    expect(plan.mode).toBe('docs-only');
    expect(plan.run_dashboard).toBe(false);
    expect(plan.run_server).toBe(false);
    expect(plan.run_perf).toBe(false);
    expect(plan.run_audit).toBe(false);
  });

  it('runs only touched dashboard tests for dashboard test-only changes', () => {
    const plan = planFromFiles(['dashboard/src/views/factory/FactoryView.test.jsx']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_dashboard).toBe(true);
    expect(plan.dashboard_args).toEqual(['src/views/factory/FactoryView.test.jsx']);
    expect(plan.run_server).toBe(false);
    expect(plan.run_perf).toBe(false);
  });

  it('runs the dashboard suite for non-test dashboard source changes', () => {
    const plan = planFromFiles(['dashboard/src/App.jsx']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_dashboard).toBe(true);
    expect(plan.dashboard_args).toEqual([]);
    expect(plan.run_server).toBe(false);
  });

  it('runs the dashboard suite for untested shared dashboard modules', () => {
    const plan = planFromFiles(['dashboard/src/views/factory/shared.jsx']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_dashboard).toBe(true);
    expect(plan.dashboard_args).toEqual([]);
    expect(plan.run_server).toBe(false);
  });

  it('runs direct dashboard tests for isolated dashboard source changes', () => {
    const plan = planFromFiles([
      'dashboard/src/components/StatCard.jsx',
      'dashboard/src/utils/ansiToHtml.js',
    ]);

    expect(plan.mode).toBe('affected');
    expect(plan.run_dashboard).toBe(true);
    expect(plan.dashboard_args).toEqual([
      'src/components/StatCard.test.jsx',
      'src/utils/ansiToHtml.test.js',
    ]);
    expect(plan.run_server).toBe(false);
    expect(plan.run_perf).toBe(false);
  });

  it('runs only touched server tests for server test-only changes', () => {
    const plan = planFromFiles([
      'server/tests/task-operations.test.js',
      'server/plugins/auth/tests/auth-plugin.test.js',
    ]);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([
      'plugins/auth/tests/auth-plugin.test.js',
      'tests/task-operations.test.js',
    ]);
    expect(plan.run_dashboard).toBe(false);
    expect(plan.run_perf).toBe(false);
    expect(plan.run_audit).toBe(false);
  });

  it('runs server, perf, and audit for server implementation changes', () => {
    const plan = planFromFiles(['server/handlers/factory-handlers.js']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([]);
    expect(plan.run_perf).toBe(true);
    expect(plan.run_audit).toBe(true);
    expect(plan.run_dashboard).toBe(false);
  });

  it('runs isolated plugin test suites for plugin implementation changes', () => {
    const plan = planFromFiles(['server/plugins/auth/key-manager.js']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([
      'plugins/auth/tests/auth-plugin.test.js',
      'plugins/auth/tests/config-injector.test.js',
      'plugins/auth/tests/key-manager.test.js',
      'plugins/auth/tests/middleware.test.js',
      'plugins/auth/tests/user-session.test.js',
    ]);
    expect(plan.run_perf).toBe(false);
    expect(plan.run_audit).toBe(true);
    expect(plan.summary).toContain('server affected tests');
  });

  it('runs exact eslint rule tests for isolated eslint rule implementation changes', () => {
    const plan = planFromFiles(['server/eslint-rules/no-heavy-test-imports.js']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual(['eslint-rules/no-heavy-test-imports.test.js']);
    expect(plan.run_perf).toBe(false);
    expect(plan.run_audit).toBe(false);
  });

  it('runs the full server suite when implementation and test files change together', () => {
    const plan = planFromFiles([
      'server/handlers/factory-handlers.js',
      'server/tests/factory-handlers.test.js',
    ]);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([]);
    expect(plan.run_perf).toBe(true);
    expect(plan.run_audit).toBe(true);
  });

  it('runs only perf for perf harness changes', () => {
    const plan = planFromFiles(['server/perf/metrics/db-list-tasks.js']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(false);
    expect(plan.run_perf).toBe(true);
    expect(plan.run_audit).toBe(false);
  });

  it('fails closed to the full gate for dependency and hook changes', () => {
    const plan = planFromFiles(['server/package-lock.json', 'scripts/pre-push-hook']);

    expect(plan.mode).toBe('full');
    expect(plan.run_dashboard).toBe(true);
    expect(plan.run_server).toBe(true);
    expect(plan.run_perf).toBe(true);
    expect(plan.run_audit).toBe(true);
    expect(plan.server_args).toEqual([]);
    expect(plan.dashboard_args).toEqual([]);
  });

  it('fails closed for unclassified root paths and unsafe path characters', () => {
    const plan = planFromFiles(['.github/workflows/ci.yml', 'server/tests/bad name.test.js']);

    expect(plan.mode).toBe('full');
    expect(plan.summary).toContain('unclassified path');
    expect(plan.summary).toContain('unsafe path');
  });

  it('includes the plan shape in the coordinator suite name', () => {
    const docs = planFromFiles(['README.md'], { base: 'a', head: 'b' });
    const server = planFromFiles(['server/handlers/tasks.js'], { base: 'a', head: 'b' });

    expect(docs.coord_suite).toMatch(/^gate-docs-only-[0-9a-f]{12}$/);
    expect(server.coord_suite).toMatch(/^gate-affected-[0-9a-f]{12}$/);
    expect(docs.coord_suite).not.toBe(server.coord_suite);
  });

  it('emits shell assignments consumed by scripts/pre-push-hook', () => {
    const plan = planFromFiles(['server/tests/task-operations.test.js']);
    const shell = toShell(plan);

    expect(shell).toContain('GATE_RUN_SERVER=');
    expect(shell).toContain('GATE_SERVER_TEST_ARGS=');
    expect(shell).toContain('tests/task-operations.test.js');
    expect(shell).toContain(`GATE_COORD_SUITE='${plan.coord_suite}'`);
  });
});
