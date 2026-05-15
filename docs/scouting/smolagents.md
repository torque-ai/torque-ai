# Findings: smolagents

**Tagline:** Minimal Python agent framework built around executable code actions.
**Stars:** 26.6k (GitHub, 2026-04-12)
**Language:** Python (100.0%)

## Feature 1: CodeAgent Uses Python as the Action Language
**What it does:** `CodeAgent` is the default agent type, and it writes actions as Python snippets instead of JSON tool-call payloads. That lets one step include variables, loops, conditionals, and multiple tool invocations before returning through `final_answer`; `ToolCallingAgent` remains available when standard JSON tool calling is the better fit.
**Why distinctive:** The important shift is not "an agent that helps write code," but "code as the agent's own control language." Hugging Face explicitly positions this as better than dictionary-style tool selection, citing 30% fewer steps and stronger results on harder benchmarks.
**TORQUE relevance:** HIGH - TORQUE already has executable system-task kinds, including inline JS in Plan 43. smolagents is a strong reference for moving that idea up to the agent layer, where a planner emits bounded code actions rather than expanding every move into a long sequence of tool-only steps.
**Status:** IMPLEMENTED — see `run_code_agent` in the remote-agents plugin (Fabro #76).

## Feature 2: MultiStepAgent Is an Explicit, Inspectable ReAct Kernel
**What it does:** All agents inherit from `MultiStepAgent`, which stores system prompt and task memory, rewrites memory into model messages, parses an action, executes it, and records each `ActionStep`. It also supports planning intervals, managed agents, step callbacks, final-answer checks, replay, full-result returns, and OpenTelemetry instrumentation through `SmolagentsInstrumentor` for backends such as Phoenix and Langfuse.
**Why distinctive:** Many frameworks expose several agent flavors but hide the actual step loop behind heavier abstractions. smolagents keeps one small, explicit kernel for the full think-act-observe cycle, and the tracing model maps directly onto that same loop instead of bolting observability onto a separate runtime layer.
**TORQUE relevance:** HIGH - TORQUE already tracks workflow and task state transitions, but not an equally explicit agent memory loop. A `MultiStepAgent`-style kernel suggests a practical way to add planning revisions, per-step validation, and auditable intermediate state without inventing a second opaque runtime.

## Feature 3: Tooling Is a First-Class Contract, Not Just a Function Hook
**What it does:** A `Tool` in smolagents is a class with `name`, `description`, `inputs`, `output_type`, and `forward`, while simple functions can be lifted into that shape with `@tool`. The same tool surface can be loaded from Hub assets, MCP servers, collections, or even Spaces, and MCP tools can expose structured output schemas to the model.
**Why distinctive:** This is more disciplined than plain tool-calling wrappers. The metadata contract is shared across prompting, runtime execution, UI generation, Hub distribution, and structured-output handling, so tools are portable artifacts rather than one-off callback bindings.
**TORQUE relevance:** HIGH - TORQUE's `server/tools.js` and MCP surface already sit at a similar architectural choke point. smolagents is a useful model for tightening tool metadata, packaging tool collections, and making structured outputs visible to planners before a call is made.

## Feature 4: Sandboxed Code Execution Is a Core Runtime Surface
**What it does:** smolagents treats code execution risk as part of the product, not an afterthought: it documents a restricted local executor, warns clearly that it is not a real security boundary, and exposes remote sandbox backends through `executor_type` for Blaxel, E2B, Modal, and Docker. The docs also distinguish snippet-level sandboxing from running the entire agentic system inside the sandbox for stronger isolation and multi-agent support.
**Why distinctive:** Code-as-action frameworks often gesture at "use Docker" and stop there. smolagents makes execution isolation an explicit runtime choice with documented tradeoffs around setup cost, credential handling, state transfer, and managed-agent compatibility.
**TORQUE relevance:** HIGH - If TORQUE ever adopts agent-level executable actions, sandboxing cannot be left to individual tools or providers. smolagents provides a concrete reference for making isolation policy part of agent runtime configuration instead of a best-effort convention.
**Status:** IMPLEMENTED — the `run_code_agent` sandbox uses Node.js `vm.createContext` with `codeGeneration: { strings: false, wasm: false }`, no access to `require`/`process`/filesystem/network, and a configurable timeout (default 10s). See `server/plugins/remote-agents/sandbox.js`.

## Feature 5: Agents and Tools Are Hub-Native Artifacts
**What it does:** smolagents can save or push agents and tools to the Hugging Face Hub, and can load them back with `from_hub()` or `load_tool()`. Saving an agent generates portable artifacts such as `tools/`, `managed_agents/`, `agent.json`, `prompt.yaml`, `app.py`, and `requirements.txt`, which makes the agent distributable as code plus metadata rather than as a hidden runtime object.
**Why distinctive:** This turns an agent into something closer to a packageable runtime artifact than a local script. The Hub integration also reinforces the framework's minimalism: instead of inventing a separate control plane, it leans on an existing ecosystem for sharing, inspection, and reuse.
**TORQUE relevance:** MEDIUM - TORQUE already has plugin, MCP, and workflow distribution surfaces, so a Hub clone is not the main takeaway. The more relevant idea is portable agent packaging: export enough code, prompt, dependency, and tool metadata that an agent can be reviewed, versioned, and reloaded elsewhere.

## Verdict
smolagents is most interesting as a design reference for agent-level executable actions, not as a generic "multi-agent framework." The strongest ideas for TORQUE are the CodeAgent paradigm, the explicit `MultiStepAgent` loop, and the insistence that sandboxing and tool contracts belong in the runtime model, not in ad hoc glue code. Plan 43's inline JS task kinds already point in this direction; smolagents shows what it looks like when executable actions become the agent's native planning language instead of just one task primitive.

## TORQUE Implementation: `code_agent` Task Kind (Fabro #76)

The `run_code_agent` MCP tool implements the CodeAgent pattern from Feature 1 and the sandboxing model from Feature 4 inside the `remote-agents` plugin.

### Architecture

    Caller (planner / MCP client)
      │
      ▼
    run_code_agent handler (handlers.js)
      │  validates code, resolves tool names, builds context
      ▼
    executeCodeAgentCode (sandbox.js)
      │  wraps snippet in async IIFE, runs in vm.createContext
      ▼
    Sandboxed VM context
      │  code calls tools.* → proxied back to plugin handlers
      ▼
    Structured result { success, output, result, tool_calls, error }

### Key Files

| File | Role |
|------|------|
| `server/plugins/remote-agents/sandbox.js` | VM sandbox — `executeCodeAgentCode()` with allow-listed globals, console capture, tool proxy, timeout |
| `server/plugins/remote-agents/handlers.js` | `handleRunCodeAgent` — validates input, maps tool names to plugin handlers, formats MCP response |
| `server/plugins/remote-agents/tool-defs.js` | `run_code_agent` schema — `code`, `tools`, `context`, `timeout` parameters |
| `server/plugins/remote-agents/index.js` | Registers `run_code_agent` in tier2 tool list |
| `server/plugins/remote-agents/tests/command-tools.test.js` | Test suite covering execution, context injection, security, tool calling, timeouts |

### Sandbox Security Model

The sandbox executes JavaScript snippets in a Node.js `vm` context with these constraints:

- **No `require`** — the `require` function is not exposed; modules cannot be loaded.
- **No `process`** — no access to environment variables, exit, or argv.
- **No filesystem or network** — `fs`, `http`, `net`, `child_process` are all absent.
- **`codeGeneration: { strings: false, wasm: false }`** — prevents `eval()`, `new Function()`, and WASM compilation from escaping the sandbox boundary.
- **Read-only context** — the `context` object is frozen via `Object.freeze`.
- **Configurable timeout** — defaults to 10 seconds; prevents runaway loops.
- **Console output cap** — 1 MB maximum; output is truncated with a marker beyond that.
- **Tool call logging** — every tool invocation inside the sandbox is recorded with name, arguments, and result for auditability.

### MCP Tool Interface

The `run_code_agent` tool accepts:

- `code` (string, required) — JavaScript snippet to execute. Supports top-level `await`.
- `tools` (string array, optional) — tool names to expose inside the sandbox. Currently supports `run_remote_command` and `run_tests` from the remote-agents plugin.
- `context` (object, optional) — key-value pairs available as the read-only `context` object inside the sandbox.
- `timeout` (number, optional) — execution timeout in ms (default 10000).

Example invocation:

    run_code_agent({
      code: `
        const result = await tools.run_remote_command({
          command: "npm test",
          working_directory: "/repo"
        });
        console.log("exit:", result.exitCode);
        return result.success;
      `,
      tools: ["run_remote_command"],
      context: { project: "my-app" },
      timeout: 30000
    })

### Tier Classification

`run_code_agent` is a **tier2** tool — it requires `unlock_tier({ tier: 2 })` or `unlock_all_tools` before it appears in the MCP tool list. This keeps the core tool surface minimal while making the code-agent capability available on demand.
