'use strict';

function matches(rule, ctx) {
  const match = rule?.match || {};

  if (match.tool && match.tool !== ctx.tool) return false;
  if (match.args_prefix) {
    for (const [key, value] of Object.entries(match.args_prefix)) {
      const actualValue = ctx.args?.[key];
      if (typeof actualValue !== 'string' || !actualValue.startsWith(value)) return false;
    }
  }

  return true;
}

function createApprovalPolicy({ rules = [] } = {}) {
  if (!Array.isArray(rules)) throw new Error('approvalPolicy: rules must be an array');

  return {
    async evaluate(ctx) {
      for (const rule of rules) {
        if (!matches(rule, ctx)) continue;
        if (rule.action === 'modify') {
          return {
            action: 'modify',
            args: typeof rule.rewrite === 'function' ? rule.rewrite(ctx) : ctx.args,
          };
        }
        return { action: rule.action };
      }

      return { action: 'approve' };
    },
    rules,
  };
}

module.exports = { createApprovalPolicy };
