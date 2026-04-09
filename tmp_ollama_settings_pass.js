const prompt = `You are helping map Torque architecture. Based only on the facts below, give 6-8 durable findings and one concise synthesis about which project/settings/config surfaces still depend on older backend layers despite v2 frontend routing.

Facts:
1) dashboard/src/api.js says endpoints are gradually migrating from legacy /api/* to /api/v2/* control-plane routes.
2) dashboard/src/api.js uses requestV2 for many settings-adjacent surfaces including workstations, providers/providerCrud, stats, budget, strategic, routingTemplates, versionControl, coordination, projectTuning, benchmarks, schedules, system, and models.
3) server/dashboard/router.js still marks many legacy routes compat:true, including /api/providers*, /api/stats*, /api/agents*, /api/plan-projects*, /api/hosts*, /api/peek-hosts*, /api/budget/*, /api/system/status, /api/project-tuning*, /api/benchmarks*, /api/schedules*, /api/workflows*, /api/approvals*, and /api/strategic/*.
4) server/api/v2-dispatch.js delegates many v2 handlers to older domain modules, for example concurrencyHandlers, routingHandlers, strategicConfigHandlers, modelHandlers, and other preexisting handler stacks.
5) Earlier repo findings: governance still has a split between dashboard-facing legacy rule handlers and broader v2 policy-engine exposure; version control and some strategic surfaces are partly surfaced but not always fully wired in the main UI.

Question: What is the durable migration pattern specifically for project/settings/config-like surfaces? Be concrete and avoid fluff.`;
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
