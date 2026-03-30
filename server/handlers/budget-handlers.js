'use strict';
const { defaultContainer } = require('../container');

async function handleGetBudgetStatus(args) {
  try {
    const budgetWatcher = defaultContainer.get('budgetWatcher');
    if (!budgetWatcher) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Budget watcher not initialized' }) }] };
    }
    if (args.provider) {
      const result = budgetWatcher.checkBudgetThresholds(args.provider);
      return { content: [{ type: 'text', text: JSON.stringify(result || { message: 'No budget configured for this provider' }) }] };
    }
    const budgets = budgetWatcher.getActiveBudgets();
    return { content: [{ type: 'text', text: JSON.stringify({ budgets }) }] };
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Budget status error: ${err.message}` }] };
  }
}

module.exports = { handleGetBudgetStatus };
