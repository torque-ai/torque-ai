'use strict';

const PROMPT_TEMPLATE = `You are augmenting a plan task with a verify command.
Project verify command: {{verify_command}}
Task: {{task_description}}

Return JSON: { "verify": "<one-line verify command>" }
Use the project's verify_command as the basis. Be specific about what success looks like.`;

function hasAcceptanceCriterion(task) {
  if (!task) return false;
  if (typeof task.verify === 'string' && task.verify.trim()) return true;
  if (typeof task.assert === 'string' && task.assert.trim()) return true;
  // Description-level signals: contains "run X and assert Y" or "test command:"
  if (typeof task.description === 'string') {
    if (/\b(verify|assert|expect)\b.*(?:passes?|succeeds?|equals?|=)/i.test(task.description)) return true;
    if (/\btest\s+command:/i.test(task.description)) return true;
  }
  return false;
}

function deterministicVerify(verifyCommand) {
  return 'Run `' + verifyCommand + '` and assert no new failures.';
}

async function augment(plan, projectConfig, deps = {}) {
  const result = { plan, augmented: 0, fallback: 0 };
  if (!plan || !Array.isArray(plan.tasks)) return result;
  const verify = projectConfig && typeof projectConfig.verify_command === 'string' && projectConfig.verify_command.trim();
  if (!verify) {
    if (deps.logger) deps.logger.warn('[codex-fallback-3] augmenter skipped: no verify_command on project');
    return result;
  }

  const log = deps.logger || { info() {}, warn() {} };
  const newTasks = [];

  for (const task of plan.tasks) {
    if (hasAcceptanceCriterion(task)) {
      newTasks.push(task);
      continue;
    }

    let augmentedTask = null;
    if (deps.groqClient) {
      try {
        const response = await deps.groqClient(PROMPT_TEMPLATE
          .replace('{{verify_command}}', verify)
          .replace('{{task_description}}', task.description || ''));
        // Validate response shape — expect { verify: string } or { tasks: [{ verify: string }] }.
        let verifyText = null;
        if (response && typeof response.verify === 'string') verifyText = response.verify;
        else if (response && Array.isArray(response.tasks) && response.tasks[0] && typeof response.tasks[0].verify === 'string') {
          verifyText = response.tasks[0].verify;
        }
        if (verifyText && verifyText.trim()) {
          augmentedTask = { ...task, verify: verifyText.trim() };
        }
      } catch (err) {
        log.warn('[codex-fallback-3] augmenter Groq call failed', { error: err.message });
      }
    }

    if (!augmentedTask) {
      augmentedTask = { ...task, verify: deterministicVerify(verify) };
      result.fallback += 1;
    }

    result.augmented += 1;
    newTasks.push(augmentedTask);
  }

  result.plan = { ...plan, tasks: newTasks };
  return result;
}

module.exports = { augment, hasAcceptanceCriterion, deterministicVerify };
