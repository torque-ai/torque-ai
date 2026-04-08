Architecture study currently covers the Claude plugin packaging layer and the standalone remote execution agent.

The `.claude-plugin/` manifests define how Claude discovers TORQUE: the marketplace descriptor publishes the local plugin bundle, and `plugin.json` wires Claude to the bundled TORQUE MCP server plus its packaged hooks, skills, agents, and commands.

The `agent/` package is a separate lightweight Node ESM service. `agent/index.js` loads `agent/config.json`, authenticates requests, exposes `/health`, `/run`, `/sync`, `/projects`, `/probe`, `/certs`, and `/peek/*`, and applies command, path, timeout, and concurrency guards around remote execution and git-sync flows.
