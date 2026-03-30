'use strict';

const childProcess = require('child_process');
const { setupTestDb, teardownTestDb, rawDb } = require('./vitest-setup');
const { CHECKERS, createGovernanceHooks } = require('../governance/hooks');

function createLoggerMock() {
  const child = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };

  return {
    child: vi.fn(() => child),
    __child: child,
  };
}

function createGovernanceRulesStore(dbHandle) {
  return {
    getActiveRulesForStage(stage) {
      return dbHandle.prepare(`
        SELECT id, name, description, stage, mode, enabled, violation_count, checker_id, config
        FROM governance_rules
        WHERE stage = ?
        ORDER BY name ASC
      `).all(stage);
    },
    incrementViolation(ruleId) {
      dbHandle.prepare(`
        UPDATE governance_rules
        SET violation_count = violation_count + 1
        WHERE id = ?
      `).run(ruleId);
    },
    getRule(ruleId) {
      return dbHandle.prepare('SELECT * FROM governance_rules WHERE id = ?').get(ruleId);
    },
  };
}

function seedRule(overrides = {}) {
  const defaults = {
    id: 'block-visible-provider',
    name: 'Block visible provider',
    description: 'Reject providers that open a visible terminal window.',
    stage: 'task_submit',
    mode: 'block',
    enabled: 1,
    violation_count: 0,
    checker_id: 'checkVisibleProvider',
    config: JSON.stringify({ providers: ['codex'] }),
  };

  const rule = {
    ...defaults,
    ...overrides,
  };

  rawDb().prepare(`
    INSERT INTO governance_rules (
      id, name, description, stage, mode, enabled, violation_count, checker_id, config
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rule.id,
    rule.name,
    rule.description,
    rule.stage,
    rule.mode,
    rule.enabled,
    rule.violation_count,
    rule.checker_id,
    rule.config,
  );

  return rule;
}

describe('governance/hooks', () => {
  let testDir;
  let logger;
  let governanceRules;
  let hooks;

  beforeEach(() => {
    ({ testDir } = setupTestDb('governance-hooks'));
    rawDb().exec(`
      CREATE TABLE IF NOT EXISTS governance_rules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        stage TEXT NOT NULL,
        mode TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        violation_count INTEGER NOT NULL DEFAULT 0,
        checker_id TEXT NOT NULL,
        config TEXT
      );
      DELETE FROM governance_rules;
    `);

    logger = createLoggerMock();
    governanceRules = createGovernanceRulesStore(rawDb());
    hooks = createGovernanceHooks({ governanceRules, logger });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    teardownTestDb();
  });

  describe('evaluate', () => {
    it('checkVisibleProvider blocks codex', () => {
      seedRule({
        id: 'visible-codex',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-1',
        provider: 'codex',
        metadata: JSON.stringify({ intended_provider: 'ollama' }),
      });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0]).toMatchObject({
        rule_id: 'visible-codex',
        checker_id: 'checkVisibleProvider',
        mode: 'block',
        pass: false,
      });
      expect(result.blocked[0].message).toContain('visible terminal window');
      expect(result.warned).toEqual([]);
      expect(result.shadowed).toEqual([]);
      expect(result.allPassed).toBe(false);
    });

    it('checkVisibleProvider blocks claude-cli', () => {
      seedRule({
        id: 'visible-claude',
        config: JSON.stringify({ providers: ['claude-cli'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-2',
        provider: 'claude-cli',
      });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].message).toContain('claude-cli');
      expect(result.allPassed).toBe(false);
    });

    it('checkVisibleProvider passes for ollama', () => {
      seedRule({
        id: 'visible-pass',
        config: JSON.stringify({ providers: ['codex', 'claude-cli'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-3',
        provider: 'ollama',
      });

      expect(result).toEqual({
        blocked: [],
        warned: [],
        shadowed: [],
        allPassed: true,
      });
    });

    it('blocks when intended_provider in metadata is codex', () => {
      seedRule({
        id: 'visible-intended',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-4',
        provider: 'ollama',
        metadata: JSON.stringify({ intended_provider: 'codex' }),
      });

      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].message).toContain('codex');
      expect(result.allPassed).toBe(false);
    });

    it('warn mode allows but adds warning', () => {
      seedRule({
        id: 'visible-warn',
        mode: 'warn',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-5',
        provider: 'codex',
      });

      expect(result.blocked).toEqual([]);
      expect(result.warned).toHaveLength(1);
      expect(result.shadowed).toEqual([]);
      expect(result.allPassed).toBe(true);
      expect(logger.__child.warn).toHaveBeenCalledWith(expect.stringContaining('Governance warning'));
    });

    it('shadow mode allows and logs silently', () => {
      seedRule({
        id: 'visible-shadow',
        mode: 'shadow',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-6',
        provider: 'codex',
      });

      expect(result.blocked).toEqual([]);
      expect(result.warned).toEqual([]);
      expect(result.shadowed).toHaveLength(1);
      expect(result.allPassed).toBe(true);
      expect(logger.__child.info).toHaveBeenCalledWith(expect.stringContaining('Governance shadow result'));
      expect(logger.__child.warn).not.toHaveBeenCalled();
    });

    it('off mode skips evaluation', () => {
      seedRule({
        id: 'visible-off',
        mode: 'off',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-7',
        provider: 'codex',
      });

      expect(result).toEqual({
        blocked: [],
        warned: [],
        shadowed: [],
        allPassed: true,
      });
      expect(governanceRules.getRule('visible-off').violation_count).toBe(0);
    });

    it('violation count increments on failure', () => {
      seedRule({
        id: 'visible-increment',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      hooks.evaluate('task_submit', {
        id: 'task-8',
        provider: 'codex',
      });

      expect(governanceRules.getRule('visible-increment').violation_count).toBe(1);
    });

    it('does not increment on pass', () => {
      seedRule({
        id: 'visible-no-increment',
        config: JSON.stringify({ providers: ['codex'] }),
      });

      hooks.evaluate('task_submit', {
        id: 'task-9',
        provider: 'ollama',
      });

      expect(governanceRules.getRule('visible-no-increment').violation_count).toBe(0);
    });

    it('no rules for stage returns allPassed', () => {
      seedRule({
        id: 'other-stage',
        stage: 'task_cancel',
        checker_id: 'checkInspectedBeforeCancel',
        config: null,
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-10',
        provider: 'codex',
      });

      expect(result).toEqual({
        blocked: [],
        warned: [],
        shadowed: [],
        allPassed: true,
      });
    });

    it('disabled rules are skipped', () => {
      seedRule({
        id: 'visible-disabled',
        enabled: 0,
        config: JSON.stringify({ providers: ['codex'] }),
      });

      const result = hooks.evaluate('task_submit', {
        id: 'task-11',
        provider: 'codex',
      });

      expect(result).toEqual({
        blocked: [],
        warned: [],
        shadowed: [],
        allPassed: true,
      });
      expect(governanceRules.getRule('visible-disabled').violation_count).toBe(0);
    });
  });

  describe('CHECKERS', () => {
    it('checkInspectedBeforeCancel fails when the task was not inspected', () => {
      const result = CHECKERS.checkInspectedBeforeCancel(
        { id: 'cancel-1' },
        { config: null },
        { recentToolCalls: [] },
      );

      expect(result).toEqual({
        pass: false,
        message: 'Check task status before cancelling. Use check_status or get_result first.',
      });
    });

    it('checkInspectedBeforeCancel passes when check_status inspected the same task', () => {
      const result = CHECKERS.checkInspectedBeforeCancel(
        { id: 'cancel-2' },
        { config: null },
        {
          recentToolCalls: [
            { tool_name: 'check_status', args: { task_id: 'cancel-2' } },
            { tool_name: 'check_status', args: { task_id: 'someone-else' } },
          ],
        },
      );

      expect(result).toEqual({ pass: true });
    });

    it('checkInspectedBeforeCancel accepts get_result string arguments', () => {
      const result = CHECKERS.checkInspectedBeforeCancel(
        { id: 'cancel-3' },
        { config: null },
        {
          recentToolCalls: [
            { name: 'get_result', arguments: JSON.stringify({ task_id: 'cancel-3' }) },
          ],
        },
      );

      expect(result).toEqual({ pass: true });
    });

    it('checkPushedBeforeRemote skips local execution tasks', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync');

      const result = CHECKERS.checkPushedBeforeRemote({
        id: 'remote-1',
        working_directory: testDir,
        metadata: JSON.stringify({ remote_execution: false }),
      });

      expect(result).toEqual({ pass: true });
      expect(execSpy).not.toHaveBeenCalled();
    });

    it('checkPushedBeforeRemote fails when unpushed commits exist', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('abc123 Commit\n');

      const result = CHECKERS.checkPushedBeforeRemote({
        id: 'remote-2',
        working_directory: testDir,
        metadata: JSON.stringify({ remote_execution: true }),
      });

      expect(result.pass).toBe(false);
      expect(result.message).toContain('Push to origin/main before remote execution');
      expect(result.unpushed_commits).toContain('abc123');
      expect(execSpy).toHaveBeenCalledWith('git', ['log', 'origin/main..HEAD', '--oneline'], {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
    });

    it('checkPushedBeforeRemote passes when no unpushed commits exist', () => {
      vi.spyOn(childProcess, 'execFileSync').mockReturnValue('   ');

      const result = CHECKERS.checkPushedBeforeRemote({
        id: 'remote-3',
        working_directory: testDir,
        metadata: JSON.stringify({ remote_execution: 'true' }),
      });

      expect(result).toEqual({ pass: true });
    });

    it('checkNoLocalTests returns the detected command', () => {
      const result = CHECKERS.checkNoLocalTests(
        { task_description: 'Run npm exec vitest run server/tests/governance-hooks.test.js' },
        { config: JSON.stringify({ commands: ['vitest', 'jest'] }) },
      );

      expect(result).toMatchObject({
        pass: false,
        detected_command: 'vitest',
      });
      expect(result.message).toContain('vitest');
    });

    it('checkNoLocalTests uses the default command list', () => {
      const result = CHECKERS.checkNoLocalTests(
        { task_description: 'Please run dotnet test for the new package' },
        { config: null },
      );

      expect(result).toMatchObject({
        pass: false,
        detected_command: 'dotnet test',
      });
    });

    it('checkNoLocalTests passes when no test command is present', () => {
      const result = CHECKERS.checkNoLocalTests(
        { task_description: 'Update the workflow DAG and rerun lint' },
        { config: JSON.stringify({ commands: ['vitest', 'pytest'] }) },
      );

      expect(result).toEqual({ pass: true });
    });

    it('checkDiffAfterCodex captures git diff stat for codex providers', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync').mockReturnValue('server/governance/hooks.js | 12 ++++++++----\n');

      const result = CHECKERS.checkDiffAfterCodex({
        id: 'diff-1',
        provider: 'codex',
        working_directory: testDir,
      });

      expect(result).toEqual({
        pass: true,
        diff_stat: 'server/governance/hooks.js | 12 ++++++++----',
      });
      expect(execSpy).toHaveBeenCalledWith('git', ['diff', '--stat', 'HEAD'], {
        cwd: testDir,
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
    });

    it('checkDiffAfterCodex skips non-codex providers', () => {
      const execSpy = vi.spyOn(childProcess, 'execFileSync');

      const result = CHECKERS.checkDiffAfterCodex({
        id: 'diff-2',
        provider: 'ollama',
        working_directory: testDir,
      });

      expect(result).toEqual({ pass: true });
      expect(execSpy).not.toHaveBeenCalled();
    });
  });
});
