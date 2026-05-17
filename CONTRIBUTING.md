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

## 2) Worktree Workflow (required for all changes)

**All code, config, and doc changes must go through a feature worktree — `main` is read-only.** A `PreToolUse` hook (`.claude/hooks/block-main-edit.js`) blocks `Edit` / `Write` / `NotebookEdit` operations on the main worktree, and the pre-commit hook blocks direct commits to `main` while worktrees exist. The rule exists because TORQUE itself runs from `main`; editing it directly risks corrupting an in-flight task or restart barrier.

Create a worktree for your change:

    scripts/worktree-create.sh <feature-name>

This creates a working copy at `.worktrees/feat-<feature-name>/` on branch `feat/<feature-name>` and installs dependencies. Open that directory in your editor and develop there.

When the change is ready to ship:

    scripts/worktree-cutover.sh <feature-name>

This merges your branch into `main`, holds a TORQUE restart barrier while the queue drains, restarts TORQUE on the new code, and cleans up the worktree. Docs-only changes skip the restart phase automatically.

**Emergency override** (use sparingly, document in commit message): `git commit --no-verify` bypasses the worktree guard, and `TORQUE_ALLOW_MAIN_EDIT=1` in the env bypasses the edit hook.

## 3) Development Setup

- Node.js 24+
- better-sqlite3 native module (prebuilt binaries available for most platforms)
- Ollama optional for local LLM provider testing

### Architecture Overview

    torque-ai/
      server/           MCP server, REST API, task execution, providers
        handlers/        Request handlers (5 domain sub-directories)
        providers/       14 execution providers (Ollama, Codex, Codex-Spark, Claude CLI / Claude-Code-SDK, claude-ollama, cloud APIs)
        plugins/         7 default plugins (snapscope, version-control, remote-agents, model-freshness, auto-recovery-core, codegraph, optional auth)
        tool-defs/       53 tool definition files (JSON Schema)
        db/              ~84 database modules across db/, db/factory/, db/file/, db/host/, db/peek/, db/provider/, db/schema/
        execution/       Workflow runtime, queue scheduler, restart barrier
      cli/               CLI client (api-client, commands, formatter)
      bin/               Entry points (torque, torque-remote, torque-coord, torque-push, torque-status)
      dashboard/         React 19 + Vite + Tailwind dashboard (14 views)
      docs/              Canonical reference docs (factory, routing-templates, torque-remote, stall-and-retry, plugin-contract, etc.)

## 4) Running Tests

Server tests (15,500+ tests):

    cd server
    npx vitest run

Dashboard tests (~388 tests):

    cd dashboard
    npx vitest run

Smoke tests (quick verification):

    npm run test:smoke

Heavy tests should route through `torque-remote` when a remote workstation is configured — see `docs/torque-remote.md`.

## 5) Code Style

- ESLint enforced: `no-unused-vars`, `prefer-const`, plus the `torque/no-utility-deps-in-register` rule that catches direct `require('./database')` in new modules (use the DI container at `server/container.js`)
- Return structured errors via `makeError(ErrorCodes.X, message, details)`
- Keep error payloads machine-readable with `error_code` field

## 6) Adding Tools

**Built-in tool (single repo-wide tool):**

1. Add the tool definition export to the `TOOLS` array in `server/tools.js` (definitions still live under `server/tool-defs/`).
2. Implement the handler in `server/handlers/` and make sure its module is listed in `HANDLER_MODULES` in `server/tools.js`.
3. Add an explicit `routeMap.set('<tool_name>', handleYourTool)` entry in `server/tools.js` alongside the other manual route mappings.

**Plugin tool (preferred for new cohesive feature surfaces):**

A plugin owns its own tool set and registers via the plugin contract (`server/plugins/plugin-contract.js`). The loader (`server/plugins/loader.js`) discovers it from `server/plugins/<name>/index.js`. See `docs/plugin-contract.md` for the 8 required + 3 optional contract methods, the loader's resolution sequence, and the 4 boot-integration passes. Add the plugin name to `DEFAULT_PLUGIN_NAMES` in `server/index.js` if it should load by default.

## 7) Database Changes

- Add schema changes in `server/db/schema-tables.js` (canonical schema) and write a numbered migration in `server/db/migrations.js`
- Keep migrations backward-compatible — TORQUE applies missing migrations on startup against existing tasks.db files
- Use the `resetForTest` pattern in tests to avoid stale DB state

## 8) Commit Messages

Use Conventional Commits with DCO sign-off:

    git commit -s -m "feat: add new provider routing rule"

The `-s` flag adds `Signed-off-by: Your Name <email>`.

Prefixes: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`. For versioned projects, TORQUE's release automation infers `version_intent` from these prefixes — see `docs/versioning.md`.

## 9) Pull Requests

PRs should include:

- Scope of change
- Test coverage and commands run (ideally via `torque-remote` when a remote workstation is available)
- Evidence that the pre-push gate passes (`PRE_PUSH_FORCE_FULL=1 git push origin main` for the full gate)
- Notes on backward compatibility
- Related issue reference

Merge strategy: squash for features, rebase for small fixes. The standard path is `scripts/worktree-cutover.sh <feature-name>` which handles the merge + restart barrier.

## 10) Branch Protection

- `main` requires PR review + status checks
- Feature branches created by `scripts/worktree-create.sh` are named `feat/<name>`; the worktree workflow keeps your work isolated from the running TORQUE server
- No force push to main

## 11) What We're Looking For

- Bug fixes with tests
- Test coverage improvements
- Documentation improvements
- Performance improvements
- Accessibility improvements

Feature PRs should be discussed in an issue first.

## License

By contributing, you agree that your contributions will be licensed under the MIT license. See [LICENSE](LICENSE) for details.
