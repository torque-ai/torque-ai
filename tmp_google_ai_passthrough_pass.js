const prompt = `You are helping map Torque architecture. Based only on the facts below, give 6-8 durable findings and one concise synthesis about whether the tool-passthrough REST layer is still a major authority surface or mostly legacy residue.

Facts:
1) server/api/routes-passthrough.js says it is auto-generated REST routes for MCP tool passthrough via handleToolCall().
2) The file header says: Generated REST routes for 501 MCP tools, generated 2026-03-13.
3) The advanced section alone contains 71 routes, including register-agent, claim-task, renew-lease, steal-task, trigger-failover, create-routing-rule, acquire-lock, release-lock, list-approval-rules, add-approval-rule, approve-task, and coordination-dashboard.
4) Earlier repo findings: many of Torque's strongest operational interventions still live outside the main v2/dashboard curated surfaces; the dashboard frontend is converging on v2, but authority remains distributed across v2 handlers, legacy compat routes, passthrough routes, and older handler stacks.
5) The passthrough routes map MCP tools directly to semantic REST endpoints instead of requiring bespoke v2 handlers.

Question: What is the durable architectural meaning of this passthrough layer right now? Be concrete and avoid fluff.`;
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
