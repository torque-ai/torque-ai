const prompt = `You are helping map Torque architecture. Based only on these facts, give 6-8 durable findings and one concise synthesis about how policy-engine task hooks interact with workflow/runtime completion.

Facts:
1) server/policy-engine/task-hooks.js has evaluateAtStage(stage, taskData, options). It exposes helpers for task_submit, task_pre_execute, task_complete, workflow_submit, workflow_run, and manual_review.
2) server/execution/completion-pipeline.js is the post-completion pipeline. It handles terminal hooks, provider usage/health, webhooks, workflow termination, dependency/project progression, output safeguards, and external notifications.
3) server/execution/workflow-runtime.js handleWorkflowTermination(taskId) calls evaluateWorkflowDependencies(taskId, workflowId), unblocks dependents by moving blocked/waiting tasks to queued, applies failure actions, injects dependency outputs, and checks workflow completion.
4) workflow-runtime also has guards/queues around terminal evaluation for workflows, meaning completion handling is serialized per workflow.
5) server/execution/task-finalizer.js is the canonical task finalization path, with ordered stages, earlyExit behavior, retry/failover logic, and only then post-completion.
6) Previous repo findings: governance/policy is often a bridge beside operational subsystems rather than embedded inside them; release governance mainly flows through manual_review.

Question: What is the durable architectural role of policy-engine task hooks relative to finalization, post-completion, and workflow progression? Be concrete and avoid fluff.`;

fetch('http://127.0.0.1:3457/api/v2/inference', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'ollama', prompt, timeout_ms: 60000 })
})
  .then(async (r) => {
    console.log(await r.text());
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
