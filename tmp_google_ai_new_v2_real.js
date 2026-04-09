const prompt = `You are helping map Torque architecture. Based only on these facts, identify whether any current v2 surfaces appear to be backed by genuinely new domain implementations rather than mainly acting as facades over older handlers. Give 6-8 durable findings and one concise synthesis.

Facts:
1) Many v2 handlers delegate to older modules such as routingHandlers, strategicConfigHandlers, modelHandlers, concurrencyHandlers, workflow handlers, and other preexisting stacks.
2) server/api/v2-control-plane.js is a dedicated shared response-builder layer for normalized {data, meta} responses and task/workflow/provider response shaping.
3) server/api/v2-workflow-handlers.js is a dedicated structured REST handler module for workflow lifecycle. It uses workflowEngine directly for listing/getting/reconciling status, but still delegates create/run/cancel/add-task actions to handlers/workflow/index for normalization and creation logic.
4) Earlier repo findings: v2-inference.js is a genuine execution engine with its own async runner and attempt planning, not just a facade.
5) The dashboard/frontend is mostly v2-first, but many settings/config surfaces are v2 facades over older backend modules.

Question: Which v2 surfaces currently look most genuinely new, and what does that imply about the real shape of convergence? Be concrete and avoid fluff.`;
fetch('http://127.0.0.1:3457/api/v2/inference', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'google-ai', prompt, timeout_ms: 60000 })
}).then(async r => {
  console.log(await r.text());
}).catch(e => {
  console.error(e);
  process.exit(1);
});
