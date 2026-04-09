const prompt = `You are helping map Torque architecture. Based only on the facts below, identify which subsystem would most likely have to become authoritative first for Torque to truly become one control plane. Give 5-7 durable findings and one concise recommendation.

Facts:
1) The dashboard frontend is mostly converging on /api/v2/* and the repo has an emerging v2 control-plane boundary.
2) Real authority is still split across v2 handlers, legacy dashboard compat routes, generated MCP-tool passthrough REST routes, and older handler/tool modules behind them.
3) Direct inference and orchestrated tasks share a task/state substrate, but still use separate runtime engines.
4) Some of the strongest operator interventions still live in legacy advanced handlers instead of curated v2/dashboard surfaces.
5) The passthrough layer projects 501 MCP tools into REST, acting as a broad authority escape hatch.
6) Project/settings/config surfaces are often frontend-v2 but backend-legacy facades.
7) Policy is important, but still bridged onto runtime rather than fully fused with the finalizer/completion authority.

Question: If Torque were to become one truly authoritative control plane, which subsystem or layer would need to become authoritative first, and why? Be concrete and avoid fluff.`;
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
