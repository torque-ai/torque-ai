const prompt = `You are helping map Torque architecture. Based only on the facts below, identify whether there are important duplicated lifecycle engines beyond the already-known split between direct inference and orchestrated task execution. Give 6-8 durable findings and one concise synthesis.

Facts:
1) Direct inference uses server/api/v2-inference.js with its own async runner and execution-plan attempts, while orchestrated tasks use task-manager, queue/startup/finalizer, and workflow-runtime.
2) Workflow-runtime adds its own dependency unblocking, failure-action handling, and terminal workflow evaluation guards on top of task terminalization.
3) Policy task execution hooks govern submission/pre-execute and react to completion, but completion policy is more sidecar than finalizer authority.
4) Remote test routing in server/plugins/remote-agents/remote-test-routing.js is a separate execution lane for verification commands, with health-aware remote-vs-local fallback and workstation auto-discovery for codex providers.
5) Scheduling and approvals have their own persistent state machines: scheduled_tasks with next_run_at/run_count and approval_requests with pending/approved/rejected plus task approval_status.
6) Release governance and manual review are another policy/review lane beside the main runtime.

Question: What additional lifecycle engines or quasi-engines matter most here beyond inference vs task orchestration? Be concrete and avoid fluff.`;
fetch('http://127.0.0.1:3457/api/v2/inference', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'ollama', prompt, timeout_ms: 60000 })
}).then(async r => {
  console.log(await r.text());
}).catch(e => {
  console.error(e);
  process.exit(1);
});
