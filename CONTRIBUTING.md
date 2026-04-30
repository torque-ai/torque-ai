# Contributing to TORQUE

Thank you for considering contributing to TORQUE! Here's how to get started.

## Good First Issues

Look for issues labeled [`good-first-issue`](https://github.com/torque-ai/torque-ai/labels/good-first-issue) — these are specifically scoped for new contributors.

## 1) Getting Started

Clone the repository and install dependencies:

    git clone https://github.com/torque-ai/torque-ai.git
    cd torque-ai
    cd server && npm install
    cd ../dashboard && npm install
    cd ..

Copy MCP settings from example:

    cp .mcp.json.example .mcp.json

## 2) Development Setup

- Node.js 24+
- better-sqlite3 native module (prebuilt binaries available for most platforms)
- Ollama optional for local LLM provider testing

### Architecture Overview

    torque-ai/
      server/           MCP server, REST API, task execution, providers
        handlers/        Request handlers (5 domain sub-directories)
        providers/       13 execution providers (Ollama, Codex, Claude CLI, cloud APIs, system)
        tool-defs/       44 tool definition files (JSON Schema)
        db/              ~75 database modules
        execution/       Workflow runtime, queue scheduler
      cli/               CLI client (api-client, commands, formatter)
      bin/               Entry points (torque, torque-status)
      dashboard/         React 19 + Vite + Tailwind dashboard (14 views)
      agent/             Remote test execution agent

## 3) Running Tests

Server tests (15,500+ tests):

    cd server
    npx vitest run

Dashboard tests (~388 tests):

    cd dashboard
    npx vitest run

Smoke tests (quick verification):

    npm run test:smoke

## 4) Code Style

- ESLint enforced: `no-unused-vars`, `prefer-const`
- Return structured errors via `makeError(ErrorCodes.X, message, details)`
- Keep error payloads machine-readable with `error_code` field

## 5) Adding Tools

1. Add the tool definition export to the `TOOLS` array in `server/tools.js` (definitions still live under `server/tool-defs/`).
2. Implement the handler in `server/handlers/` and make sure its module is listed in `HANDLER_MODULES` in `server/tools.js`.
3. Add an explicit `routeMap.set('<tool_name>', handleYourTool)` entry in `server/tools.js` with the other manual route mappings.

## 6) Database Changes

- Add schema changes in `server/db/schema.js`
- Keep migrations backward-compatible
- Use `resetForTest` pattern in tests to avoid stale DB state

## 7) Commit Messages

Use Conventional Commits with DCO sign-off:

    git commit -s -m "feat: add new provider routing rule"

The `-s` flag adds `Signed-off-by: Your Name <email>`.

Prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`

## 8) Pull Requests

PRs should include:

- Scope of change
- Test coverage and commands run
- Evidence that CI passes (`lint + test + build`)
- Notes on backward compatibility
- Related issue reference

Merge strategy: squash for features, rebase for small fixes.

## 9) Branch Protection

- `main` requires PR review + status checks
- Feature branches: `feature/*`, `fix/*`, `docs/*`
- No force push to main

## 10) What We're Looking For

- Bug fixes with tests
- Test coverage improvements
- Documentation improvements
- Performance improvements
- Accessibility improvements

Feature PRs should be discussed in an issue first.

## License

By contributing, you agree that your contributions will be licensed under the MIT license. See [LICENSE](LICENSE) for details.
