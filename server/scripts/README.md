# Script Inventory

Active scripts in `server/scripts/`. One-time migration and legacy scripts were removed in the Phase 1 refactor cleanup (2026-03-09).

## Active

| Script | Purpose | Usage |
|--------|---------|-------|
| `check-live-rest-readiness.js` | Checks REST health plus provider/model lane readiness for the live REST integration target. | Run `npm run ci:live-rest-readiness-local` from `server/`, or call `node scripts/check-live-rest-readiness.js` with the documented async/concurrency flags. |
| `gpu-metrics-server.js` | Starts the GPU companion HTTP service that exposes `nvidia-smi` metrics for TORQUE dashboards and discovery. | Imported by `server/index.js`, or run `node scripts/gpu-metrics-server.js --port 9394`. |
| `mcp-dual-agent-smoke.js` | Sends concurrent MCP gateway calls through separate Codex and Claude request lanes and reports latency/failures. | Run `npm run ci:mcp-dual-agent-smoke` from `server/`. |
| `mcp-launch-readiness.js` | Starts the MCP gateway, verifies it comes up cleanly, then runs the readiness pack and dual-agent smoke checks. | Run `npm run ci:mcp-launch-readiness` from `server/`. |
| `mcp-readiness-pack.js` | Aggregates gateway health and MCP control artifacts into a single readiness report. | Run `npm run ci:mcp-readiness-pack` from `server/`. |
| `reset-ollama.ps1` | Restarts a local Windows Ollama instance and waits for the API to answer again. | Run `powershell -File scripts/reset-ollama.ps1` from `server/` on Windows hosts. |
| `reset-ollama.sh` | Restarts a local Linux Ollama service and waits for the API to answer again. | Run `bash scripts/reset-ollama.sh` from `server/` on Linux hosts. |
| `run-live-rest-local.js` | Starts the local TORQUE server when needed and runs the live REST integration test bundle, writing artifacts. | Run `npm run ci:live-rest-local` from `server/`, or use the async/concurrency package-script variants. |
| `smoke-dashboard-mutations.js` | Verifies dashboard mutation endpoints reject non-AJAX requests and allow valid AJAX updates. | Run `npm run ci:dashboard-mutation-smoke` from `server/`. |

## Removed (Phase 1 Refactor)

The following were deleted as orphaned/one-time scripts:
`extract-tool-defs.js`, `verify-routemap.js`, `audit-tables.js`, `queue-runner-v3.js`, `extract-execution.js`, `extract-project-config.js`, `extract-schema.js`, `reconstruct-database.js`, `reconstruct-task-manager.js`, `rewire-modules.js`, `task-health.js`
