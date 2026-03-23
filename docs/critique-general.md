# TORQUE: A Critic's Assessment

*Generated 2026-03-23. Honest internal critique of the project's architecture, scope, and development process.*

## The Good (acknowledged, but moving on)

The ambition is real — multi-provider AI task orchestration with DAG workflows, smart routing, quality gates, and a DI container is a serious system. The test count (672 test files, 312K lines of test code) shows commitment to correctness. Minimal runtime dependencies is a strong choice.

## The Serious Concerns

### 1. This is a solo-developer megaproject that grew faster than any one person can maintain.

943 commits in 9 days (March 14-23). One author. 500K lines of server JavaScript. That's not development, that's a firehose. The code wasn't written by you — it was written *through* you, by the AI tools TORQUE itself orchestrates. This creates a recursive trust problem: the tool that generates your code is the code you're building. Who's actually reviewing the output?

### 2. The AI-generated code smell is everywhere.

- 28 files over 50KB. `schema-tables.js` is 113KB. `api-server.test.js` is 90KB. Handler files regularly exceed 50KB. These aren't sizes a human writes or can meaningfully review.
- 672 test files vs 444 source files — a 1.5:1 ratio by file count, and **1.6:1 by lines** (312K test lines vs 189K source lines). Tests should be proportional to source, but this ratio suggests AI-generated test padding. Are these tests testing meaningful behavior, or are they testing that the AI's own boilerplate does what the AI said it does?
- 62 modules in `server/db/` alone. 33 tool definition files. 40+ handler files. This level of decomposition isn't clean architecture — it's what you get when an AI generates one module per concept without considering whether that concept warrants its own file.

### 3. The architecture is a cathedral of accidental complexity.

- **489 MCP tools** (per the CLAUDE.md claim). No human user will discover, learn, or meaningfully use 489 tools. This is an interface designed for AI consumption, but AI agents don't need 489 tools either — they need 20 well-designed ones. The progressive unlock system acknowledges this problem without solving it.
- **12 providers** with overlapping capabilities, fallback chains, routing templates, smart routing, policy engines, shadow enforcement, slot-pull schedulers. Each of these is a real concept, but stacked together they form an onion of indirection where a task submission passes through ~8 layers of decision-making before reaching a provider.
- The DI container with 130+ registered services is not evidence of good architecture — it's evidence that the module boundaries are too granular. A container with 130 services is a service locator in disguise.

### 4. The CLAUDE.md is a novel, not documentation.

The project CLAUDE.md is 26KB. Combined with the global CLAUDE.md, it's a document that takes significant context to even load into an AI session. It documents internal processes, session handoffs, provider quality matrices, and operational runbooks that should live in separate documentation — not in an instruction file that's force-loaded into every conversation. It conflates "how to use TORQUE" with "how to operate the TORQUE development process."

### 5. The project has no real users, but it has enterprise features.

Policy engines, shadow enforcement, approval workflows, audit stores, RBAC-style auth, budget watchers, cost tracking, cron scheduling, webhook handlers, remote agents, CI integration. These are features you build when you have organizations using your tool. Building them before having users means you're guessing at requirements, and those guesses are now 500K lines of code to maintain.

### 6. The "never write code directly" doctrine is a bet that could go badly.

The CLAUDE.md explicitly says "NEVER manually implement what TORQUE should produce." The project's development process is: plan in Claude Code, submit to TORQUE, TORQUE dispatches to Codex/Ollama/etc., verify output, commit. This means:
- The developer's mental model of the codebase is mediated through AI output summaries, not through writing and reading code.
- Bugs in TORQUE's orchestration layer become bugs in TORQUE itself (the tool generates its own code).
- The "known issue" that Codex sandbox contamination has a **100% reproduction rate** (per the CLAUDE.md) means the tool regularly corrupts its own repository state.

### 7. No TypeScript in a 500K-line JavaScript project.

This is plain CommonJS JavaScript with no type annotations, no JSDoc types, no type checking. At 500K lines, the number of implicit contracts between 130+ DI services, 62 DB modules, and 40+ handler files is astronomical. The only thing catching type mismatches is the test suite — which was also AI-generated and may share the same assumptions.

### 8. SQLite as the primary data store for a distributed system.

TORQUE orchestrates across multiple hosts, supports multiple concurrent Claude sessions, and manages workflows with complex state machines. SQLite's write-locking semantics mean any concurrent write contention will surface as `SQLITE_BUSY` errors. For a single-user tool this is probably fine, but the architecture clearly aspires to be more than single-user (multi-host, remote agents, auth/RBAC).

## The Meta-Critique

TORQUE is the most honest example I've seen of what happens when you give an ambitious developer unlimited AI code generation and no team to push back. The result is a system that is simultaneously impressive in scope and deeply fragile — because scope is cheap when AI writes the code, but understanding, coherence, and maintainability are not.

The real question isn't "does it work today" — it probably does, for the one person who uses it. The question is: if you stepped away for 3 months and came back, could you debug a failure in the routing-template → policy-engine → smart-routing → provider-fallback → slot-pull-scheduler pipeline? Could anyone else?
