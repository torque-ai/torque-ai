Architecture study currently covers the Claude plugin packaging layer, the standalone remote agent, the agent's HTTP integration tests, and the top-level CLI entry stack.

The `.claude-plugin/` manifests define how Claude discovers TORQUE: the marketplace descriptor publishes the local plugin bundle, and `plugin.json` wires Claude to the bundled TORQUE MCP server plus its packaged hooks, skills, agents, and commands.

The `agent/` package is a lightweight Node ESM service. `agent/index.js` loads `agent/config.json`, authenticates requests, exposes `/health`, `/run`, `/sync`, `/projects`, `/probe`, `/certs`, and `/peek/*`, and applies command, path, timeout, and concurrency guards around remote execution and git-sync flows. The `agent/tests/*.test.js` coverage drives those endpoints over HTTP, with focused checks for health/auth behavior, streamed process execution, and git-backed sync/project registration in disposable repositories.

The CLI layer currently studied starts at `bin/torque.js`, which prints help/version output, dispatches the legacy command surface into the richer CLI modules, and implements budget, cache, template, plan, and backup helpers via `cli/api-client.js`. That shared API client centralizes fetch timeouts, response parsing, and normalized API/network errors for server-facing CLI requests.
