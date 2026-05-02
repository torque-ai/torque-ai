'use strict';

const fs = require('fs');
const path = require('path');

describe('Phase X4: non-quality reject paths route to needs_replan, not rejected', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'factory', 'loop-controller.js'),
    'utf8',
  );

  describe('routeWorkItemToNeedsReplan helper', () => {
    it('exists as a function', () => {
      expect(src).toMatch(/function routeWorkItemToNeedsReplan\(workItem,/);
    });

    it('writes needs_replan status and persists last_rejection_reason in origin_json', () => {
      // Phase X5 + the stale-plan-file fix expanded the helper; slice up
      // to the next top-level function declaration so the assertion stays
      // robust to future growth.
      const fnIdx = src.indexOf('function routeWorkItemToNeedsReplan');
      const nextFnIdx = src.indexOf('\nfunction ', fnIdx + 1);
      const body = src.slice(fnIdx, nextFnIdx > 0 ? nextFnIdx : fnIdx + 12000);
      expect(body).toMatch(/'needs_replan'/);
      expect(body).toMatch(/last_rejection_reason:/);
      expect(body).toMatch(/last_rejected_at:/);
    });
  });

  describe('removed terminal-rejection reject_reasons', () => {
    // Each of these used to write status:'rejected' with the named reason.
    // Phase X4 routes them to needs_replan. The strings themselves still
    // appear (now as the reason passed to routeWorkItemToNeedsReplan), but
    // they should NEVER co-occur with status:'rejected'.
    const previouslyTerminalReasons = [
      'plan_quality_gate_rejected_after_2_attempts',
      'replan_generation_failed',
    ];

    for (const reason of previouslyTerminalReasons) {
      it(`'${reason}' is no longer paired with status:'rejected'`, () => {
        // Look for any remaining `status:'rejected'` ... `reject_reason:'<reason>'`
        // pattern in close proximity (within ~120 chars). This catches any
        // lingering legacy code paths I missed.
        const escapedReason = reason.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const bad = new RegExp(`status:\\s*'rejected'[\\s\\S]{0,200}reject_reason:\\s*'${escapedReason}`);
        expect(src).not.toMatch(bad);
      });
    }

    it("'cannot_generate_plan: <error>' (parse/timeout path) no longer pairs with status:'rejected'", () => {
      // The cannot_generate_plan EXECUTE-stage path used to write
      // status:'rejected' with reject_reason: `cannot_generate_plan: ${msg}`.
      const bad = /status:\s*'rejected'[\s\S]{0,200}reject_reason:\s*`cannot_generate_plan:/;
      expect(src).not.toMatch(bad);
    });

    it("'empty_branch_after_execute' no longer pairs with status:'rejected'", () => {
      const bad = /status:\s*'rejected'[\s\S]{0,200}reject_reason:\s*'empty_branch_after_execute'/;
      expect(src).not.toMatch(bad);
    });
  });

  describe('decision-log action renames', () => {
    // The new action names make it clear in the decision log that we're
    // routing, not abandoning. Operators reading the dashboard see the
    // policy shift directly.
    const expectedActions = [
      'plan_quality_routed_to_needs_replan_after_intrabatch_retries',
      'cannot_generate_plan_routed_to_needs_replan',
      'empty_branch_routed_to_needs_replan',
      'verify_empty_branch_routed_to_needs_replan',
    ];

    for (const action of expectedActions) {
      it(`emits '${action}' decision`, () => {
        expect(src).toContain(action);
      });
    }
  });

  describe('return values reflect needs_replan routing', () => {
    it('next_state for converted paths is PRIORITIZE (not IDLE)', () => {
      // The converted paths must hand control back to PRIORITIZE so the
      // needs_replan item can be re-picked. IDLE would skip that.
      // Spot-check the LLM-semantic intra-batch retry path.
      const fnIdx = src.indexOf('plan_quality_routed_to_needs_replan_after_intrabatch_retries');
      expect(fnIdx).toBeGreaterThan(-1);
      const after = src.slice(fnIdx, fnIdx + 1500);
      expect(after).toMatch(/next_state:\s*LOOP_STATES\.PRIORITIZE/);
    });

    it('cannot_generate_plan path returns next_state PRIORITIZE', () => {
      const fnIdx = src.indexOf('cannot_generate_plan_routed_to_needs_replan');
      expect(fnIdx).toBeGreaterThan(-1);
      const after = src.slice(fnIdx, fnIdx + 1000);
      expect(after).toMatch(/next_state:\s*LOOP_STATES\.PRIORITIZE/);
    });
  });

  describe('legitimate terminal rejections preserved', () => {
    it("'cannot_generate_plan: no description' STAYS terminal (no replan possible without description)", () => {
      // This is the one cannot_generate_plan variant where replan can't
      // help — the work item has no description to plan from. Phase X4
      // intentionally does NOT convert it.
      expect(src).toMatch(/status:\s*'rejected'[\s\S]{0,200}cannot_generate_plan: no description/);
    });
  });
});
