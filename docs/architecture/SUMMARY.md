Architecture study currently covers the Claude plugin packaging layer, the standalone remote agent and its HTTP integration tests, and the Node CLI stack that fronts the TORQUE server.

The `.claude-plugin/` manifests publish the local plugin bundle and wire Claude to the packaged TORQUE MCP server, hooks, skills, agents, and commands. The `agent/` package is a guarded Node ESM service that authenticates requests, runs remote commands and git sync flows, proxies `/peek/*`, and exposes health and project discovery endpoints; `agent/tests/*.test.js` exercises those contracts over HTTP.

The CLI study now spans `bin/torque.js`, `cli/api-client.js`, `cli/commands.js`, `cli/ci.js`, `cli/dashboard.js`, `cli/doctor.js`, and `cli/formatter.js`. Together they dispatch user commands into REST and tool calls, add CI watcher helpers, open the local dashboard, perform environment diagnostics, and translate markdown-heavy server responses into readable terminal output.
