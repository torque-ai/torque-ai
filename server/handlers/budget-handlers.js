'use strict';
const { defaultContainer } = require('../container');

async function handleGetBudgetStatus(args) {
  try {
    const budgetWatcher = defaultContainer.get('budgetWatcher');
    if (!budgetWatcher) {
      const data = { count: 0, budgets: [], error: 'Budget watcher not initialized' };
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredData: { count: 0, budgets: [] },
      };
    }
    if (args.provider) {
      const result = budgetWatcher.checkBudgetThresholds(args.provider);
      const budgets = result ? [result] : [];
      const data = {
        count: budgets.length,
        budgets,
        ...(result ? {} : { message: 'No budget configured for this provider' }),
      };
      return {
        content: [{ type: 'text', text: JSON.stringify(data) }],
        structuredData: { count: data.count, budgets },
      };
    }
    const budgets = budgetWatcher.getActiveBudgets();
    const normalizedBudgets = Array.isArray(budgets) ? budgets : [];
    const data = { count: normalizedBudgets.length, budgets: normalizedBudgets };
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredData: data,
    };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Budget status error: ${err.message}` }] };
  }
}

module.exports = { handleGetBudgetStatus };
