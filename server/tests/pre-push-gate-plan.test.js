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

  it('runs direct-import server tests for isolated leaf server source changes', () => {
    const plan = planFromFiles([
      'server/factory/scout-provider-resolver.js',
      'server/factory/provider-lane-policy.js',
    ]);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([
      'tests/provider-lane-policy-by-kind.test.js',
      'tests/scout-provider-resolver.test.js',
    ]);
    expect(plan.run_perf).toBe(false);
    expect(plan.run_audit).toBe(true);
    expect(plan.run_dashboard).toBe(false);
  });

  it('keeps central server modules on the full server suite', () => {
    const plan = planFromFiles(['server/task-manager.js']);

    expect(plan.mode).toBe('affected');
    expect(plan.run_server).toBe(true);
    expect(plan.server_args).toEqual([]);
    expect(plan.run_perf).toBe(true);
    expect(plan.run_audit).toBe(true);
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

  describe('audit_strict trigger', () => {
    it('flips audit_strict on for changes under server/db/', () => {
      const plan = planFromFiles(['server/db/analytics.js']);

      expect(plan.run_audit).toBe(true);
      expect(plan.audit_strict).toBe(true);
      expect(plan.summary).toContain('strict');
    });

    it('flips audit_strict on for changes under server/handlers/', () => {
      const plan = planFromFiles(['server/handlers/factory-handlers.js']);

      expect(plan.audit_strict).toBe(true);
    });

    it('flips audit_strict on for changes under server/factory/', () => {
      const plan = planFromFiles(['server/factory/scout-provider-resolver.js']);

      expect(plan.audit_strict).toBe(true);
    });

    it('does NOT flip audit_strict for nested-only paths', () => {
      // audit-db-queries.js scans top-level .js only (no recursion). A
      // change in a subdirectory of one of the audited dirs is therefore
      // not in scope and shouldn't trigger strict mode.
      const plan = planFromFiles(['server/handlers/advanced/some-deep-handler.js']);

      expect(plan.audit_strict).toBe(false);
    });

    it('does NOT flip audit_strict for server tests under audited dirs', () => {
      const plan = planFromFiles(['server/tests/factory-handlers.test.js']);

      expect(plan.audit_strict).toBe(false);
    });

    it('does NOT flip audit_strict for documentation-only changes', () => {
      const plan = planFromFiles(['README.md']);

      expect(plan.audit_strict).toBe(false);
      expect(plan.run_audit).toBe(false);
    });

    it('forces audit_strict on for full-gate triggers', () => {
      const plan = planFromFiles(['server/package-lock.json']);

      expect(plan.full).toBe(true);
      expect(plan.audit_strict).toBe(true);
    });

    it('exposes audit_strict via shell assignments', () => {
      const plan = planFromFiles(['server/db/analytics.js']);
      const shell = toShell(plan);

      expect(shell).toContain(`GATE_AUDIT_STRICT='1'`);
    });

    it('emits GATE_AUDIT_STRICT=0 when run_audit is false', () => {
      const plan = planFromFiles(['README.md']);
      const shell = toShell(plan);

      expect(shell).toContain(`GATE_AUDIT_STRICT='0'`);
    });

    it('changes the plan hash when audit_strict toggles', () => {
      // Same files except for triggering audit_strict — proves the hash
      // (and thus the coord_suite cache key) takes audit_strict into
      // account. Otherwise stale cached gate runs from before this
      // change could replay over a strict-required push.
      const handler = planFromFiles(['server/handlers/factory-handlers.js']);
      const test = planFromFiles(['server/tests/factory-handlers.test.js']);

      expect(handler.audit_strict).toBe(true);
      expect(test.audit_strict).toBe(false);
      expect(handler.hash).not.toBe(test.hash);
    });
  });
});
