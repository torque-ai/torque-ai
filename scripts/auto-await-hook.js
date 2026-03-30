#!/usr/bin/env node
// Auto-Await Hook — PostToolUse hook that instructs Claude to await after task/workflow submission.
// Fires after: run_workflow, submit_task, smart_submit_task
// Outputs additionalContext that Claude sees as instructions to call await_workflow/await_task.
'use strict';

let chunks = [];
process.stdin.on('data', d => chunks.push(d));
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const toolName = input.tool_name || '';
    const response = input.tool_response || {};

    // Extract IDs from various response formats
    // MCP tools return structured data — the ID might be nested
    const responseText = typeof response === 'string' ? response : JSON.stringify(response);

    // Detect workflow submissions
    if (toolName.includes('run_workflow')) {
      const workflowId = response.workflowId || response.workflow_id ||
        (responseText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];

      if (workflowId) {
        console.log(JSON.stringify({
          additionalContext: `HOOK INSTRUCTION: Workflow ${workflowId} started. You MUST now call await_workflow with workflow_id="${workflowId}" and heartbeat_minutes=3 to monitor progress. Do not ask the user — just await.`
        }));
        process.exit(0);
      }
    }

    // Detect task submissions
    if (toolName.includes('submit_task') || toolName.includes('smart_submit_task')) {
      const taskId = response.taskId || response.task_id ||
        (responseText.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];

      if (taskId) {
        console.log(JSON.stringify({
          additionalContext: `HOOK INSTRUCTION: Task ${taskId} submitted. You MUST now call await_task with task_id="${taskId}" and heartbeat_minutes=3 to monitor progress. Do not ask the user — just await.`
        }));
        process.exit(0);
      }
    }

    // No match — no output
    console.log(JSON.stringify({}));
  } catch {
    // Silent failure — don't block Claude
    console.log(JSON.stringify({}));
  }
});
