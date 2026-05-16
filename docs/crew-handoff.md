# Crew Handoff — Swarm-Style Function-Return Agent Handoff

## Overview

TORQUE crews support Swarm-style function-return agent handoff: a tool handler
returns a tagged sentinel object instead of a plain result, and the crew runner
detects it, validates the target agent, merges context variables, and swaps the
active agent — all within the existing turn loop. The implementation lives in
`server/crew/handoff.js` (sentinel creation, registry, history) and
`server/crew/crew-runner.js` (detection and execution inside `runCrewTurn`).


## Handoff Object Shape

A handoff sentinel is a plain object tagged with a well-known `Symbol`:

    {
      [Symbol.for('torque.crew.handoff')]: true,
      __handoff: true,
      agent: '<target-agent-name>',
      contextPatch: { /* optional key-value pairs */ }
    }

| Field | Type | Description |
|-------|------|-------------|
| `Symbol.for('torque.crew.handoff')` | `true` | Primary tag checked by `isHandoff()` in `server/crew/handoff.js` |
| `__handoff` | `true` | Convenience flag for serialization contexts where Symbols are stripped |
| `agent` | `string` | Name of the target agent to hand off to (must be non-empty after trim) |
| `contextPatch` | `object` | Key-value pairs shallow-merged into the shared context variables; defaults to `{}` |

The `isHandoff(x)` function performs a duck-type check: it returns `true` only
when `x` is a non-null object with the `Symbol.for('torque.crew.handoff')`
property set to `true`. Plain objects, strings, nulls, and arrays all return
`false`.


## How It Works

The runtime flow inside `runCrewTurn` (`server/crew/crew-runner.js` lines 220-262):

1. A tool handler returns a handoff sentinel via `createHandoff(targetAgent, { contextPatch })`.
2. `isHandoff(result)` detects the sentinel.
3. `getAgent(agents, result.agent)` validates the target exists in the agents map;
   if it does not, an error is thrown listing the unknown agent name.
4. `state.activeAgent` is set to `result.agent`, swapping the active agent.
5. If `result.contextPatch` is present, `state.contextVariables.merge(result.contextPatch)`
   shallow-merges the patch into shared context.
6. A history entry is recorded both on `state.handoffHistory` (in-memory) and,
   when a `taskId` is available, via `recordHandoffHistory` for task-scoped
   persistence through `persistTaskHandoffHistory`.
7. If `chainAutomatically` is set and the target agent implements the same tool,
   `runCrewTurn` recurses with a handoff counter that enforces `maxHandoffs`
   (default 10) to prevent infinite loops.
8. Otherwise the turn returns `{ activeAgent: result.agent, handedOff: true }`
   and the higher-level crew loop restarts with the new agent.


## Usage Example

A tool handler that returns a handoff:

    const { createHandoff } = require('./crew/handoff');

    // Inside a triage agent's tool map
    const triageAgent = {
      tools: {
        route: async (args, ctx) => {
          const department = classifyIssue(args.issue);
          return createHandoff(department, {
            contextPatch: { issue: args.issue, priority: 'high' },
          });
        },
      },
    };

Running the crew turn:

    const { runCrewTurn } = require('./crew/crew-runner');
    const { createContextVariables } = require('./crew/context-variables');

    const agents = {
      triage: triageAgent,
      billing: {
        tools: {
          respond: async (args, ctx) => {
            return `Handling ${ctx.get('issue')} at priority ${ctx.get('priority')}`;
          },
        },
      },
    };

    const state = {
      activeAgent: 'triage',
      contextVariables: createContextVariables(),
    };

    // Turn 1: triage hands off to billing
    const turn1 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'route', args: { issue: 'refund' } },
    });
    // turn1.handedOff === true, state.activeAgent === 'billing'

    // Turn 2: billing handles the request with merged context
    const turn2 = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'respond', args: {} },
    });
    // turn2.result === 'Handling refund at priority high'

For automatic chaining when all agents share the same tool name, pass
`chainAutomatically: true`:

    const result = await runCrewTurn({
      agents,
      state,
      toolCall: { name: 'hop', args: {} },
      chainAutomatically: true,
      maxHandoffs: 10,
    });


## Context Variable Merge Rules

Context variables are managed by `server/crew/context-variables.js` via
`createContextVariables(initial)`. The `merge(patch)` method applies:

- **Shallow merge** — `state = { ...state, ...patch }`. Nested objects are
  replaced, not deep-merged.
- **Last-writer-wins** — if the patch contains a key that already exists in the
  shared context, the new value overwrites the old one.
- **Absent `contextPatch` leaves context untouched** — when `createHandoff` is
  called without a `contextPatch` (or with an empty object), no merge occurs and
  all existing context variables are preserved.
- **Pre-existing variables survive** — keys not mentioned in the patch remain
  in the context after the merge.
- **Merge history is tracked** — every `merge()` call is recorded in an internal
  log retrievable via `contextVariables.history()`.


## Error Handling

- **Unknown target agent** — if a handoff names an agent not present in the
  `agents` map passed to `runCrewTurn`, the call throws:

      Error: runCrewTurn: unknown active agent "<name>"

  The error includes the agent name so the caller can identify which handoff
  targeted a missing agent.

- **Empty or invalid agent name** — `createHandoff('')` and `createHandoff(null)`
  throw immediately:

      Error: createHandoff: agent name required

- **Chain depth exceeded** — when `chainAutomatically` is enabled and the
  handoff chain exceeds `maxHandoffs` (default 10), the call throws:

      Error: handoff chain exceeded maxHandoffs=<N>

  This prevents infinite handoff loops between agents that keep returning
  handoffs to each other.


## Agent Registry

`server/crew/handoff.js` provides a lightweight in-memory registry for agents
that participate in handoffs:

- `registerHandoffAgent({ name, systemPrompt, tools })` — stores agent metadata
  and generates a wrapper tool name via `buildHandoffToolName` (e.g., `'Billing'`
  becomes `handoff_to_billing`).
- `getHandoffAgent(name)` — case-insensitive lookup returning a copy of the
  agent record.
- `getHandoffWrapper(name)` — returns the pre-built wrapper function that
  produces handoff sentinels for the named agent.
- `resetHandoffState()` — clears the registry and history (used in tests).

The registry is separate from the `agents` map passed to `runCrewTurn`. The
registry is useful for MCP tool generation (each registered agent gets a
`handoff_to_<name>` tool), while the `agents` map is the runtime dispatch
surface.


## Dependencies

This feature builds on:

- **Plan 26** (crew-flow-split) — the crew runner and context variable
  infrastructure
- **Plan 88** (crew-router) — the router interface (`roundRobinRouter`,
  `codeRouter`, `llmRouter`, `hybridRouter`) in `server/crew/routers.js`

No new npm dependencies are required. The handoff module uses only Node.js
built-ins and existing crew infrastructure.
