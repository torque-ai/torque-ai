import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  normalizeActionName,
  normalizeOptionalString,
  normalizeNonNegativeInteger,
  isPlainObject,
  clonePlainObject,
  cloneArray,
  resolveDeletedEntries,
  resolveOriginalWindowPosition,
  resolveThreadState,
  buildNoopPlan,
  RISK_CLASSIFICATION,
  classifyActionRisk,
  validateHighRiskEvidence,
  createRollbackPlan,
  attachRollbackData,
  countPassingResults,
  countFailingResults,
  formatPolicyProof,
} = require('../handlers/peek/rollback');

const LOW_EVIDENCE = ['screenshot_before'];
const MEDIUM_EVIDENCE = ['screenshot_before', 'screenshot_after'];
const HIGH_EVIDENCE = ['screenshot_before', 'screenshot_after', 'user_confirmation'];

describe('server/handlers/peek/rollback', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('normalizeActionName', () => {
    it('trims surrounding whitespace from string actions', () => {
      expect(normalizeActionName('  reset_window_position  ')).toBe('reset_window_position');
    });

    it('returns an empty string for non-string inputs', () => {
      expect(normalizeActionName(null)).toBe('');
      expect(normalizeActionName(42)).toBe('');
      expect(normalizeActionName({ action: 'click' })).toBe('');
    });
  });

  describe('normalizeOptionalString', () => {
    it('returns a trimmed string when content remains', () => {
      expect(normalizeOptionalString('  Task Manager  ')).toBe('Task Manager');
    });

    it('returns null for blank or non-string values', () => {
      expect(normalizeOptionalString('   ')).toBeNull();
      expect(normalizeOptionalString(undefined)).toBeNull();
      expect(normalizeOptionalString(0)).toBeNull();
    });
  });

  describe('normalizeNonNegativeInteger', () => {
    it('returns the original value for valid non-negative integers', () => {
      expect(normalizeNonNegativeInteger(0, 99)).toBe(0);
      expect(normalizeNonNegativeInteger(12, 99)).toBe(12);
    });

    it('returns the fallback for negative or non-integer values', () => {
      expect(normalizeNonNegativeInteger(-1, 7)).toBe(7);
      expect(normalizeNonNegativeInteger(1.5, 7)).toBe(7);
      expect(normalizeNonNegativeInteger('12', 7)).toBe(7);
    });
  });

  describe('isPlainObject', () => {
    it('returns true for plain objects', () => {
      expect(isPlainObject({ key: 'value' })).toBe(true);
    });

    it('returns false for nulls and arrays', () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(['value'])).toBe(false);
      expect(isPlainObject('value')).toBe(false);
    });
  });

  describe('clonePlainObject', () => {
    it('clones a plain object into a new reference', () => {
      const source = { x: 10, nested: { unsafe: true } };
      const clone = clonePlainObject(source);

      expect(clone).toEqual(source);
      expect(clone).not.toBe(source);
    });

    it('returns null for non-plain values', () => {
      expect(clonePlainObject(null)).toBeNull();
      expect(clonePlainObject(['not', 'plain'])).toBeNull();
    });
  });

  describe('cloneArray', () => {
    it('trims string entries, stringifies primitives, and drops blank values', () => {
      expect(cloneArray([' alpha ', 2, false, '', ' beta '])).toEqual(['alpha', '2', 'beta']);
    });

    it('returns an empty array for non-array input', () => {
      expect(cloneArray(null)).toEqual([]);
      expect(cloneArray('alpha')).toEqual([]);
    });
  });

  describe('resolveDeletedEntries', () => {
    it('returns the first non-empty deleted-entry candidate list', () => {
      expect(resolveDeletedEntries({
        deleted_entries: [],
        deletedEntries: ['  cache/a.tmp  ', 'cache/b.tmp'],
        deleted_paths: ['cache/c.tmp'],
      })).toEqual(['cache/a.tmp', 'cache/b.tmp']);
    });

    it('falls back to directory-like scalar fields when no list exists', () => {
      expect(resolveDeletedEntries({
        cachePath: '  C:\\temp\\cache  ',
      })).toEqual(['C:\\temp\\cache']);
    });

    it('returns an empty list when no deleted-entry hints are present', () => {
      expect(resolveDeletedEntries({})).toEqual([]);
    });
  });

  describe('resolveOriginalWindowPosition', () => {
    it('prefers cloned object snapshots when available', () => {
      const original = { x: 10, y: 20, width: 640, height: 480 };
      const resolved = resolveOriginalWindowPosition({ original_position: original });

      expect(resolved).toEqual(original);
      expect(resolved).not.toBe(original);
    });

    it('builds a scalar snapshot from numeric window coordinates', () => {
      expect(resolveOriginalWindowPosition({
        left: 1,
        top: 2,
        right: 301,
        bottom: 202,
        width: 'ignored',
      })).toEqual({
        left: 1,
        top: 2,
        right: 301,
        bottom: 202,
      });
    });

    it('returns null when no position data is available', () => {
      expect(resolveOriginalWindowPosition({ title: 'Calculator' })).toBeNull();
    });
  });

  describe('resolveThreadState', () => {
    it('prefers a cloned object snapshot when provided', () => {
      const state = { wait_reason: 'io', stack_depth: 4 };
      const resolved = resolveThreadState({ thread_state: state });

      expect(resolved).toEqual(state);
      expect(resolved).not.toBe(state);
    });

    it('falls back to named string states', () => {
      expect(resolveThreadState({ stateName: 'blocked' })).toEqual({ state: 'blocked' });
    });

    it('returns null when no thread state is present', () => {
      expect(resolveThreadState({ threadId: 'worker-1' })).toBeNull();
    });
  });

  describe('buildNoopPlan', () => {
    it('creates a non-rollbackable noop plan with merged extra step data', () => {
      expect(buildNoopPlan('close_dialog', 'Dialog cannot be reopened.', 'low', {
        dialog: 'Stuck Dialog',
      })).toEqual({
        action: 'close_dialog',
        rollback_steps: [{
          step: 'noop',
          description: 'Dialog cannot be reopened.',
          dialog: 'Stuck Dialog',
        }],
        can_rollback: false,
        estimated_impact: 'low',
      });
    });
  });

  describe('RISK_CLASSIFICATION', () => {
    it('maps every known action to the expected risk level and evidence requirements', () => {
      const expectations = {
        click: ['low', LOW_EVIDENCE],
        type: ['low', LOW_EVIDENCE],
        scroll: ['low', LOW_EVIDENCE],
        focus_window: ['medium', MEDIUM_EVIDENCE],
        close_window: ['high', HIGH_EVIDENCE],
        send_keys: ['medium', MEDIUM_EVIDENCE],
        restart_process: ['medium', MEDIUM_EVIDENCE],
        clear_temp_cache: ['low', LOW_EVIDENCE],
        reset_window_position: ['low', LOW_EVIDENCE],
        close_dialog: ['low', LOW_EVIDENCE],
        kill_hung_thread: ['high', HIGH_EVIDENCE],
        force_kill_process: ['high', HIGH_EVIDENCE],
        modify_registry_key: ['high', HIGH_EVIDENCE],
        inject_accessibility_hook: ['high', HIGH_EVIDENCE],
      };

      for (const [action, [level, requiredEvidence]] of Object.entries(expectations)) {
        expect(RISK_CLASSIFICATION[action]).toMatchObject({
          level,
          requiredEvidence,
        });
      }
    });

    it('keeps high-risk metadata on the flagged actions', () => {
      expect(RISK_CLASSIFICATION.force_kill_process).toMatchObject({
        requires_approval: true,
        approval_required: true,
        shadow_only: true,
        verification_callback: 'verify_process_killed',
        rollback_plan: 'Restart process from saved state',
      });
      expect(RISK_CLASSIFICATION.modify_registry_key).toMatchObject({
        verification_callback: 'verify_registry_restored',
        rollback_plan: 'Restore registry key from backup',
      });
      expect(RISK_CLASSIFICATION.inject_accessibility_hook).toMatchObject({
        verification_callback: 'verify_hook_injected',
        rollback_plan: 'Remove injected hook and restore original state',
      });
    });

    it('freezes the top-level map and nested classifications', () => {
      expect(Object.isFrozen(RISK_CLASSIFICATION)).toBe(true);
      expect(Object.isFrozen(RISK_CLASSIFICATION.force_kill_process)).toBe(true);
    });
  });

  describe('classifyActionRisk', () => {
    it('returns trimmed low-risk classifications without internal metadata flags', () => {
      expect(classifyActionRisk('  clear_temp_cache  ')).toEqual({
        level: 'low',
        requiredEvidence: LOW_EVIDENCE,
      });
    });

    it('returns trimmed high-risk classifications without approval metadata leakage', () => {
      expect(classifyActionRisk(' force_kill_process ')).toEqual({
        level: 'high',
        requiredEvidence: HIGH_EVIDENCE,
      });
      expect(classifyActionRisk('force_kill_process')).not.toHaveProperty('verification_callback');
    });

    it('defaults unknown actions to the high-risk evidence set', () => {
      expect(classifyActionRisk('unsupported_action')).toEqual({
        level: 'high',
        requiredEvidence: HIGH_EVIDENCE,
      });
    });
  });

  describe('validateHighRiskEvidence', () => {
    it('accepts complete dedicated evidence for force_kill_process using camelCase aliases', () => {
      expect(validateHighRiskEvidence('force_kill_process', {
        processName: 'stuck-app.exe',
        pid: 0,
        killReason: 'operator confirmed hang',
      })).toEqual({
        sufficient: true,
        missing: [],
      });
    });

    it('accepts falsey but defined registry values as sufficient evidence', () => {
      expect(validateHighRiskEvidence('modify_registry_key', {
        registryPath: 'HKCU\\Software\\Torque\\Mode',
        originalValue: 0,
        newValue: false,
      })).toEqual({
        sufficient: true,
        missing: [],
      });
    });

    it('reports blank strings and missing high-risk evidence fields', () => {
      expect(validateHighRiskEvidence('inject_accessibility_hook', {
        target_process: 'reader.exe',
        hook_type: '   ',
      })).toEqual({
        sufficient: false,
        missing: ['hook_type', 'injection_method'],
      });
    });

    it('falls back to the action risk evidence set for non-specialized actions', () => {
      expect(validateHighRiskEvidence('focus_window', {
        screenshot_before: 'before.png',
      })).toEqual({
        sufficient: false,
        missing: ['screenshot_after'],
      });
    });

    it('uses the unknown-action high-risk evidence set for unrecognized actions', () => {
      expect(validateHighRiskEvidence('custom_action', {
        screenshotBefore: 'before.png',
        screenshotAfter: 'after.png',
        userConfirmation: true,
      })).toEqual({
        sufficient: true,
        missing: [],
      });
    });

    it('marks every required field missing when params is not a plain object', () => {
      expect(validateHighRiskEvidence('force_kill_process', null)).toEqual({
        sufficient: false,
        missing: ['process_name', 'pid', 'kill_reason'],
      });
    });
  });

  describe('createRollbackPlan', () => {
    it('builds a restart_process noop rollback plan', () => {
      expect(createRollbackPlan(' restart_process ', {
        processName: '  notepad.exe  ',
      })).toEqual({
        action: 'restart_process',
        rollback_steps: [{
          step: 'noop',
          description: 'Process restarts cannot be rolled back after execution.',
          process_name: 'notepad.exe',
        }],
        can_rollback: false,
        estimated_impact: 'medium',
      });
    });

    it('builds a clear_temp_cache logging plan from deleted-entry aliases', () => {
      expect(createRollbackPlan('clear_temp_cache', {
        deletedEntries: ['  cache/a.tmp ', 'cache/b.tmp'],
      })).toEqual({
        action: 'clear_temp_cache',
        rollback_steps: [{
          step: 'log_deleted_entries',
          description: 'Record deleted cache entries for operator review.',
          deleted_entries: ['cache/a.tmp', 'cache/b.tmp'],
        }],
        can_rollback: false,
        estimated_impact: 'medium',
      });
    });

    it('builds a reset_window_position restore plan from previousPosition aliases', () => {
      expect(createRollbackPlan('reset_window_position', {
        windowTitle: '  Calculator  ',
        previousPosition: { x: 10, y: 20, width: 320, height: 240 },
      })).toEqual({
        action: 'reset_window_position',
        rollback_steps: [{
          step: 'restore_window_position',
          description: 'Restore the original window position captured before recovery.',
          window: 'Calculator',
          original_position: { x: 10, y: 20, width: 320, height: 240 },
        }],
        can_rollback: true,
        estimated_impact: 'low',
      });
    });

    it('builds a close_dialog noop rollback plan', () => {
      expect(createRollbackPlan('close_dialog', {
        dialogTitle: '  Confirm Exit  ',
      })).toEqual({
        action: 'close_dialog',
        rollback_steps: [{
          step: 'noop',
          description: 'Closed dialogs are not reopened automatically.',
          dialog: 'Confirm Exit',
        }],
        can_rollback: false,
        estimated_impact: 'low',
      });
    });

    it('builds a kill_hung_thread plan with derived thread state', () => {
      expect(createRollbackPlan('kill_hung_thread', {
        threadId: 'thread-9',
        stateName: 'blocked',
      })).toEqual({
        action: 'kill_hung_thread',
        rollback_steps: [{
          step: 'log_thread_state',
          description: 'Capture the terminated thread context for postmortem analysis.',
          thread_id: 'thread-9',
          thread_state: { state: 'blocked' },
        }],
        can_rollback: false,
        estimated_impact: 'high',
      });
    });

    it('builds a force_kill_process plan with verification callback metadata', () => {
      expect(createRollbackPlan('force_kill_process', {
        processName: ' frozen-app.exe ',
        pid: -2,
        killReason: '  watchdog timeout  ',
      })).toEqual({
        action: 'force_kill_process',
        rollback_steps: [{
          step: 'log_process_termination',
          description: 'Record terminated process details for operator review and potential restart.',
          process_name: 'frozen-app.exe',
          pid: null,
          kill_reason: 'watchdog timeout',
        }],
        can_rollback: false,
        estimated_impact: 'high',
        rollback_plan: 'Restart process from saved state',
        verification_callback: 'verify_process_killed',
      });
    });

    it('builds a modify_registry_key restore plan and preserves null defaults', () => {
      expect(createRollbackPlan('modify_registry_key', {
        registryPath: ' HKCU\\Software\\Torque\\Flag ',
      })).toEqual({
        action: 'modify_registry_key',
        rollback_steps: [{
          step: 'restore_registry_value',
          description: 'Restore the original registry value before modification.',
          registry_path: 'HKCU\\Software\\Torque\\Flag',
          original_value: null,
          new_value: null,
        }],
        can_rollback: true,
        estimated_impact: 'high',
        rollback_plan: 'Restore registry key from backup',
        verification_callback: 'verify_registry_restored',
      });
    });

    it('builds an inject_accessibility_hook removal plan and exposes verification metadata', () => {
      expect(createRollbackPlan('inject_accessibility_hook', {
        targetProcess: ' reader.exe ',
        hookType: ' uia ',
        injectionMethod: ' remote_thread ',
      })).toEqual({
        action: 'inject_accessibility_hook',
        rollback_steps: [{
          step: 'remove_accessibility_hook',
          description: 'Remove the injected accessibility hook from the target process.',
          target_process: 'reader.exe',
          hook_type: 'uia',
          injection_method: 'remote_thread',
        }],
        can_rollback: true,
        estimated_impact: 'high',
        rollback_plan: 'Remove injected hook and restore original state',
        verification_callback: 'verify_hook_injected',
      });
    });

    it('falls back to manual follow-up for unknown actions', () => {
      expect(createRollbackPlan(' custom_action ', {
        ignored: true,
      })).toEqual({
        action: 'custom_action',
        rollback_steps: [{
          step: 'log_manual_follow_up',
          description: 'No predefined rollback plan exists for this recovery action.',
        }],
        can_rollback: false,
        estimated_impact: 'medium',
      });
    });
  });

  describe('attachRollbackData', () => {
    it('returns a cloned audit entry with the supplied rollback plan', () => {
      const auditEntry = { action_name: 'clear_temp_cache', success: true };
      const rollbackPlan = createRollbackPlan('clear_temp_cache', {
        deleted_paths: ['cache/a.tmp'],
      });
      const attached = attachRollbackData(auditEntry, rollbackPlan);

      expect(attached).toEqual({
        action_name: 'clear_temp_cache',
        success: true,
        rollback_plan: rollbackPlan,
      });
      expect(attached).not.toBe(auditEntry);
      expect(auditEntry).not.toHaveProperty('rollback_plan');
    });

    it('preserves an existing rollback plan when no new plan is supplied', () => {
      const existingPlan = createRollbackPlan('close_dialog', { title: 'Stuck Dialog' });

      expect(attachRollbackData({
        action_name: 'close_dialog',
        rollback_plan: existingPlan,
      })).toEqual({
        action_name: 'close_dialog',
        rollback_plan: existingPlan,
      });
    });

    it('returns a minimal object with rollback_plan null for non-object entries', () => {
      expect(attachRollbackData(null)).toEqual({
        rollback_plan: null,
      });
    });
  });

  describe('countPassingResults', () => {
    it('counts only pass outcomes', () => {
      expect(countPassingResults([
        { outcome: 'pass' },
        { outcome: 'fail' },
        { outcome: 'pass' },
        { outcome: 'warn' },
      ])).toBe(2);
    });
  });

  describe('countFailingResults', () => {
    it('counts only fail outcomes', () => {
      expect(countFailingResults([
        { outcome: 'pass' },
        { outcome: 'fail' },
        { outcome: 'fail' },
        { outcome: 'warn' },
      ])).toBe(2);
    });
  });

  describe('formatPolicyProof', () => {
    it('formats explicit summary values and includes suppressed results in the detail list', () => {
      expect(formatPolicyProof({
        created_at: '2026-03-10T18:30:00.000Z',
        total_results: 3,
        summary: {
          passed: 1,
          warned: 1,
          failed: 2,
          blocked: 1,
        },
        results: [
          {
            policy_id: 'policy-pass',
            outcome: 'pass',
            mode: 'advisory',
            evidence: { ok: true },
          },
          {
            policy_id: 'policy-warn',
            outcome: 'fail',
            mode: 'warn',
            evidence: { reason: 'advisory' },
          },
        ],
        suppressed_results: [
          {
            policy_id: 'policy-block',
            outcome: 'fail',
            mode: 'block',
            evidence: { approval_recorded: false },
          },
        ],
      })).toEqual({
        evaluated_at: '2026-03-10T18:30:00.000Z',
        policies_checked: 3,
        passed: 1,
        warned: 1,
        failed: 2,
        blocked: 1,
        mode: 'block',
        details: [
          {
            policy_id: 'policy-pass',
            result: 'pass',
            evidence: { ok: true },
          },
          {
            policy_id: 'policy-warn',
            result: 'fail',
            evidence: { reason: 'advisory' },
          },
          {
            policy_id: 'policy-block',
            result: 'fail',
            evidence: { approval_recorded: false },
          },
        ],
      });
    });

    it('computes counts from visible and suppressed results when summary values are absent', () => {
      expect(formatPolicyProof({
        evaluated_at: '2026-03-11T00:00:00.000Z',
        results: [
          { policy_id: 'pass-1', outcome: 'pass', mode: 'advisory' },
          { policy_id: 'warn-1', outcome: 'fail', mode: 'warn' },
        ],
        suppressed_results: [
          { policy_id: 'warn-2', outcome: 'fail', mode: 'advisory' },
          { policy_id: 'block-1', outcome: 'fail', mode: 'block' },
        ],
      })).toEqual({
        evaluated_at: '2026-03-11T00:00:00.000Z',
        policies_checked: 4,
        passed: 1,
        warned: 2,
        failed: 3,
        blocked: 1,
        mode: 'block',
        details: [
          {
            policy_id: 'pass-1',
            result: 'pass',
            evidence: null,
          },
          {
            policy_id: 'warn-1',
            result: 'fail',
            evidence: null,
          },
          {
            policy_id: 'warn-2',
            result: 'fail',
            evidence: null,
          },
          {
            policy_id: 'block-1',
            result: 'fail',
            evidence: null,
          },
        ],
      });
    });

    it('forces shadow mode when the evaluation ran in shadow mode', () => {
      expect(formatPolicyProof({
        shadow: true,
        results: [
          { policy_id: 'block-1', outcome: 'fail', mode: 'block' },
        ],
      }).mode).toBe('shadow');
    });

    it('falls back to advisory mode when no block results exist', () => {
      expect(formatPolicyProof({
        results: [
          { policy_id: 'warn-1', outcome: 'fail', mode: 'warn' },
          { policy_id: 'pass-1', outcome: 'pass', mode: 'advisory' },
        ],
      }).mode).toBe('advisory');
    });

    it('normalizes malformed detail entries and falls back to the current timestamp', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-12T12:34:56.000Z'));

      expect(formatPolicyProof({
        total_results: -1,
        results: [
          'ignore-me',
          {
            outcome: '   ',
          },
        ],
        suppressed_results: [
          {
            policy_id: '  ',
            outcome: null,
          },
        ],
      })).toEqual({
        evaluated_at: '2026-03-12T12:34:56.000Z',
        policies_checked: 2,
        passed: 0,
        warned: 0,
        failed: 0,
        blocked: 0,
        mode: 'advisory',
        details: [
          {
            policy_id: 'unknown',
            result: 'unknown',
            evidence: null,
          },
          {
            policy_id: 'unknown',
            result: 'unknown',
            evidence: null,
          },
        ],
      });
    });
  });
});
