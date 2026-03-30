'use strict';

/**
 * Peek Workflow Integration Tests (TQ-B-03)
 *
 * Verifies the integration contract between:
 * 1. peek_diagnose output → evidence sufficiency classification
 * 2. Evidence classification → workflow conditional branching
 * 3. peek_recovery wiring through the tool dispatch system
 *
 * These are unit-level integration tests — they test the data flow contracts
 * between peek handlers, evidence classifiers, and workflow runtime primitives
 * without requiring a live peek server or full workflow execution.
 */

const {
  classifyEvidenceSufficiency,
} = require('../plugins/snapscope/handlers/artifacts');
const {
  injectDependencyOutputs,
  applyContextFrom,
} = require('../execution/workflow-runtime');
const {
  handlePeekRecovery,
  handlePeekRecoveryStatus,
} = require('../plugins/snapscope/handlers/recovery');
const { WPF_FIXTURE } = require('../contracts/peek-fixtures');
const { routeMap, TOOLS } = require('../tools');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('peek workflow integration', () => {
  describe('tool dispatch wiring', () => {
    it('peek_recovery is routed to handlePeekRecovery', () => {
      expect(routeMap.has('peek_recovery')).toBe(true);
      expect(routeMap.get('peek_recovery')).toBe(handlePeekRecovery);
    });

    it('peek_recovery_status is routed to handlePeekRecoveryStatus', () => {
      expect(routeMap.has('peek_recovery_status')).toBe(true);
      expect(routeMap.get('peek_recovery_status')).toBe(handlePeekRecoveryStatus);
    });

    it('tool definitions exist for both recovery tools', () => {
      const toolNames = TOOLS.map(t => t.name);
      expect(toolNames).toContain('peek_recovery');
      expect(toolNames).toContain('peek_recovery_status');
    });

    it('peek_recovery tool definition requires action', () => {
      const def = TOOLS.find(t => t.name === 'peek_recovery');
      expect(def.inputSchema.required).toEqual(['action']);
      expect(def.inputSchema.properties.action).toBeDefined();
      expect(def.inputSchema.properties.params).toBeDefined();
      expect(def.inputSchema.properties.host).toBeDefined();
    });

    it('peek_recovery_status has no required params', () => {
      const def = TOOLS.find(t => t.name === 'peek_recovery_status');
      expect(def.inputSchema.required).toBeUndefined();
      expect(def.inputSchema.properties.host).toBeDefined();
    });
  });

  describe('evidence sufficiency → workflow condition contract', () => {
    it('classifies a complete WPF bundle as sufficient', () => {
      const result = classifyEvidenceSufficiency(clone(WPF_FIXTURE));
      expect(result.sufficient).toBe(true);
    });

    it('classifies a bundle missing capture_data as insufficient', () => {
      const bundle = clone(WPF_FIXTURE);
      bundle.capture_data = null;
      const result = classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('capture_data');
    });

    it('classifies a bundle missing metadata as insufficient', () => {
      const bundle = clone(WPF_FIXTURE);
      bundle.metadata = null;
      const result = classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('metadata');
    });

    it('classifies a bundle missing visual_tree as insufficient', () => {
      const bundle = clone(WPF_FIXTURE);
      bundle.visual_tree = null;
      const result = classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing).toContain('visual_tree');
    });

    it('reports multiple missing fields', () => {
      const bundle = clone(WPF_FIXTURE);
      bundle.capture_data = null;
      bundle.metadata = null;
      const result = classifyEvidenceSufficiency(bundle);
      expect(result.sufficient).toBe(false);
      expect(result.missing.length).toBeGreaterThanOrEqual(2);
      expect(result.missing).toContain('capture_data');
      expect(result.missing).toContain('metadata');
    });
  });

  describe('diagnose output → workflow output injection', () => {
    it('injects diagnose evidence_state into downstream task description', () => {
      const diagnoseOutput = JSON.stringify({
        success: true,
        evidence_state: 'complete',
        evidence_sufficiency: { sufficient: true },
      });
      const desc = 'Analyze UI based on diagnose result: {{diagnose.output}}';
      const depTasks = {
        diagnose: { output: diagnoseOutput, error_output: '', exit_code: 0 },
      };

      const injected = injectDependencyOutputs(desc, depTasks);
      expect(injected).toContain('evidence_state');
      expect(injected).toContain('complete');
    });

    it('injects evidence_sufficiency into downstream task for conditional branching', () => {
      const diagnoseOutput = JSON.stringify({
        success: true,
        evidence_state: 'insufficient',
        evidence_sufficiency: { sufficient: false, missing: ['visual_tree'], confidence: 'low' },
      });

      const desc = 'Check evidence: {{diagnose.output}}';
      const depTasks = {
        diagnose: { output: diagnoseOutput, error_output: '', exit_code: 0 },
      };

      const injected = injectDependencyOutputs(desc, depTasks);
      expect(injected).toContain('sufficient');
      expect(injected).toContain('visual_tree');
    });

    it('supports context_from prepending for multi-step peek workflows', () => {
      const diagnoseOutput = JSON.stringify({ evidence_state: 'complete', sufficient: true });
      const recoveryOutput = JSON.stringify({ success: true, action: 'reset_window_position' });

      const desc = 'Verify final state after recovery';
      const depTasks = {
        diagnose: { output: diagnoseOutput, error_output: '', exit_code: 0 },
        recovery: { output: recoveryOutput, error_output: '', exit_code: 0 },
      };

      const result = applyContextFrom(desc, ['diagnose', 'recovery'], depTasks);
      expect(result).toContain('Prior step results:');
      expect(result).toContain('### diagnose');
      expect(result).toContain('### recovery');
      expect(result).toContain('evidence_state');
      expect(result).toContain('reset_window_position');
      expect(result).toContain('Verify final state after recovery');
    });

    it('handles exit_code injection for failed diagnose steps', () => {
      const desc = 'Diagnose exited with: {{diagnose.exit_code}}, errors: {{diagnose.error_output}}';
      const depTasks = {
        diagnose: { output: '', error_output: 'Connection refused', exit_code: 1 },
      };

      const injected = injectDependencyOutputs(desc, depTasks);
      expect(injected).toContain('exited with: 1');
      expect(injected).toContain('Connection refused');
    });
  });

  describe('peek workflow DAG structure validation', () => {
    it('diagnose → check_evidence → recovery is a valid 3-node DAG pattern', () => {
      // Step 1: diagnose produces a bundle
      const bundle = clone(WPF_FIXTURE);
      bundle.visual_tree = null;
      const sufficiency = classifyEvidenceSufficiency(bundle);

      // Step 2: evidence check shows insufficient
      expect(sufficiency.sufficient).toBe(false);
      expect(sufficiency.missing).toContain('visual_tree');

      // Step 3: recovery decision based on evidence check
      const needsRecovery = !sufficiency.sufficient;
      expect(needsRecovery).toBe(true);

      // The recovery task receives diagnose output via injection
      const diagnoseResult = {
        success: true,
        evidence_state: 'insufficient',
        evidence_sufficiency: sufficiency,
      };
      const recoveryDesc = 'Recover missing evidence: {{diagnose.output}}';
      const depTasks = {
        diagnose: { output: JSON.stringify(diagnoseResult), error_output: '', exit_code: 0 },
      };
      const injected = injectDependencyOutputs(recoveryDesc, depTasks);
      expect(injected).toContain('visual_tree');
      expect(injected).not.toContain('{{diagnose.output}}');
    });

    it('sufficient evidence skips recovery in the conditional DAG pattern', () => {
      const bundle = clone(WPF_FIXTURE);
      const sufficiency = classifyEvidenceSufficiency(bundle);
      expect(sufficiency.sufficient).toBe(true);

      // Recovery should be skipped
      const needsRecovery = !sufficiency.sufficient;
      expect(needsRecovery).toBe(false);
    });

    it('multi-host diagnose outputs can be aggregated via context_from', () => {
      const omenResult = {
        success: true,
        evidence_state: 'complete',
        evidence_sufficiency: { sufficient: true },
      };
      const localResult = {
        success: true,
        evidence_state: 'insufficient',
        evidence_sufficiency: { sufficient: false, missing: ['capture_data'] },
      };

      const desc = 'Compare diagnose results across hosts';
      const depTasks = {
        diagnose_omen: { output: JSON.stringify(omenResult), error_output: '', exit_code: 0 },
        diagnose_local: { output: JSON.stringify(localResult), error_output: '', exit_code: 0 },
      };

      const result = applyContextFrom(desc, ['diagnose_omen', 'diagnose_local'], depTasks);
      expect(result).toContain('### diagnose_omen');
      expect(result).toContain('### diagnose_local');
      expect(result).toContain('Compare diagnose results across hosts');
    });
  });
});
