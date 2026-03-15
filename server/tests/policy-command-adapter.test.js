import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const { setupTestDb, teardownTestDb } = require('./vitest-setup');
const engine = require('../policy-engine/engine');
const { collectCommandPolicyEvidence } = require('../policy-engine/adapters/command');

describe('policy command adapter', () => {
  describe('collectCommandPolicyEvidence', () => {
    it('marks safe commands as satisfied', () => {
      const evidence = collectCommandPolicyEvidence({
        command: 'npx',
        args: ['tsc', '--noEmit'],
        profile: 'safe_verify',
      });

      expect(evidence).toMatchObject({
        type: 'command_profile_valid',
        available: true,
        satisfied: true,
      });
      expect(Object.prototype.hasOwnProperty.call(evidence.value, 'reason')).toBe(true);
      expect(evidence.value.reason).toBeUndefined();
    });

    it('marks shell metacharacters as unsatisfied', () => {
      const evidence = collectCommandPolicyEvidence({
        command: 'npx tsc && npm test',
        profile: 'safe_verify',
      });

      expect(evidence).toMatchObject({
        type: 'command_profile_valid',
        available: true,
        satisfied: false,
      });
      expect(evidence.value.reason).toContain('metacharacter');
    });

    it('returns unavailable evidence when the profile is missing', () => {
      const evidence = collectCommandPolicyEvidence({
        command: 'npx',
        args: ['tsc', '--noEmit'],
      });

      expect(evidence).toEqual({
        type: 'command_profile_valid',
        available: false,
        satisfied: null,
        value: { reason: 'command profile is unavailable' },
      });
    });
  });

  describe('engine integration', () => {
    let db;
    let testDir;

    beforeEach(() => {
      ({ db, testDir } = setupTestDb('policy-command-adapter'));
    });

    afterEach(() => {
      teardownTestDb();
    });

    it('accepts normalized command evidence in the engine requirement format', () => {
      db.savePolicyProfile({
        id: 'command-adapter-profile',
        name: 'Command adapter profile',
        project: null,
        defaults: { mode: 'advisory' },
        project_match: {},
        policy_overrides: {},
        enabled: true,
      });
      db.setProjectMetadata('Torque', 'policy_profile_id', 'command-adapter-profile');
      db.savePolicyRule({
        id: 'command_profile_required',
        name: 'command_profile_required',
        category: 'privacy_security',
        stage: 'task_pre_execute',
        mode: 'advisory',
        priority: 100,
        matcher: {
          target_types_any: ['task'],
        },
        required_evidence: [{ type: 'command_profile_valid' }],
        actions: [{ type: 'emit_violation', severity: 'warning' }],
        override_policy: { allowed: true, reason_codes: ['approved_exception'] },
        enabled: true,
      });
      db.savePolicyBinding({
        id: 'binding-command-adapter',
        profile_id: 'command-adapter-profile',
        policy_id: 'command_profile_required',
        mode_override: null,
        binding_json: {},
        enabled: true,
      });

      const commandEvidence = collectCommandPolicyEvidence({
        command: 'npx',
        args: ['tsc', '--noEmit'],
        profile: 'safe_verify',
      });

      const result = engine.evaluatePolicies({
        stage: 'task_pre_execute',
        target_type: 'task',
        target_id: 'task-command-adapter-1',
        project_id: 'Torque',
        project_path: testDir,
        evidence: {
          command_profile_valid: commandEvidence,
        },
      });

      expect(result.summary).toMatchObject({
        passed: 1,
        failed: 0,
        degraded: 0,
      });
      expect(result.results).toHaveLength(1);
      expect(result.results[0].outcome).toBe('pass');
      expect(result.results[0].evidence.requirements[0]).toEqual(commandEvidence);
    });
  });
});
