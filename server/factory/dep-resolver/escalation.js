'use strict';

const ESCALATION_TIMEOUT_MS = 90_000;

async function escalate({ project, workItem, originalError, resolverError, resolverPrompt, manifestExcerpt, timeoutMs = ESCALATION_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('../internal-task-submit');
  const { handleAwaitTask } = require('../../handlers/workflow/await');
  const taskCore = require('../../db/task-core');

  const prompt = buildEscalationPrompt({ originalError, resolverError, resolverPrompt, manifestExcerpt });
  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'reasoning',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submission?.task_id || null;
  } catch (_e) {
    return { action: 'pause', reason: 'escalation_llm_unavailable: submit_threw' };
  }
  if (!taskId) return { action: 'pause', reason: 'escalation_llm_unavailable: no_task_id' };

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (_e) {
    return { action: 'pause', reason: 'escalation_llm_unavailable: await_threw' };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') {
    return { action: 'pause', reason: 'escalation_llm_unavailable: task_not_completed' };
  }

  const raw = String(task.output || '').trim();
  if (!raw) return { action: 'pause', reason: 'escalation_llm_unavailable: empty_output' };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const action = parsed.action === 'retry' ? 'retry' : parsed.action === 'pause' ? 'pause' : null;
    if (!action) return { action: 'pause', reason: 'escalation_llm_unavailable: invalid_action' };
    const reason = typeof parsed.reason === 'string' ? parsed.reason.trim() : '';
    if (action === 'retry') {
      const revised = typeof parsed.revised_prompt === 'string' ? parsed.revised_prompt.trim() : '';
      if (!revised) return { action: 'pause', reason: 'escalation_llm_unavailable: retry_without_prompt' };
      return { action: 'retry', revisedPrompt: revised, reason: reason || 'llm_retry' };
    }
    return { action: 'pause', reason: reason || 'llm_pause' };
  } catch (_e) {
    void _e;
    return { action: 'pause', reason: 'escalation_llm_unavailable: unparseable_json' };
  }
}

function buildEscalationPrompt({ originalError, resolverError, resolverPrompt, manifestExcerpt }) {
  return `A software factory tried to resolve a missing dependency but the resolver task failed.

Original verify error:
${(originalError || '').slice(0, 3000)}

Resolver task the factory submitted:
${(resolverPrompt || '').slice(0, 2000)}

Resolver task's error output:
${(resolverError || '').slice(0, 3000)}

Relevant manifest excerpt:
${(manifestExcerpt || '(none)').slice(0, 2000)}

Decide whether the factory should retry resolution with corrected instructions or pause for operator attention.

Return ONLY valid JSON:
{"action":"retry"|"pause","revised_prompt":"<new resolver instructions>"|null,"reason":"<one-sentence diagnostic>"}

- "retry" — you can identify a concrete correction (wrong package name, alternate install command, need uv instead of pip, etc.) that would make the resolver succeed. Provide the revised resolver prompt.
- "pause" — the issue is not resolvable without operator context (private registry, genuine version conflict, environment mismatch).
`;
}

module.exports = { escalate, ESCALATION_TIMEOUT_MS };
