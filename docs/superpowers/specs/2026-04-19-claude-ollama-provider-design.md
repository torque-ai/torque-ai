# ClaudeOllama Provider — Design

## Goal

Add a new TORQUE provider that wraps `ollama launch claude --model <local> -- -p "<prompt>"`, giving
locally-hosted Ollama models access to the Claude Code harness (tool loop, Read/Edit/Bash,
agentic planning) instead of the raw prompt-response shape used by the existing `ollama-agentic`
adapter.

The hypothesis worth testing: a 30B local model driving Claude Code's structured tool protocol
can outperform the same model called directly, because the harness imposes a better agentic
loop than TORQUE's adapter can manufacture inline.

Scope is local models only. Cloud Ollama models (`*-cloud` tags) remain reachable through the
existing `ollama-cloud` provider, which uses `OLLAMA_CLOUD_API_KEY` against `api.ollama.com`.
The `ollama launch claude` bridge is not used for cloud because its auth (SSH-keypair signin at
`ollama.com/connect`) does not accept bearer tokens.

## Viability — verified

Three probes ran against a registered Ollama host (LAN workstation) confirming the design is
buildable:

1. **Scriptable non-interactive invocation works.** `ollama launch claude --model qwen3-coder:30b -- -p "<prompt>" --output-format text` returned clean stdout.
2. **Model flag plumbs through.** Same prompt to `qwen3-coder:30b` → "curious", `qwen3.5:latest` → "fluffy", `gemma4:latest` → "Graceful". The `--model` selection is honored end-to-end.
3. **Tool use works.** A probe file containing a known sentinel string was successfully read by `qwen3-coder:30b` when asked to invoke the Read tool — the local model drove the Claude Code tool-use protocol and returned the exact contents.

## Invocation shape

```
ollama launch claude --model <model> --
    -p <prompt>
    --output-format stream-json
    --include-partial-messages
    --permission-mode <mode>
    --add-dir <workingDir>
    [--allowed-tools ...] [--disallowed-tools ...]
    [--session-id <id> | --resume <id>]
    [--append-system-prompt <skillPrompt>]
```

The `--` is the pass-through boundary defined by `ollama launch`. Every flag after it goes to
`claude-cli`. Stream-json output gives us the same event format that `claude-code-sdk.js` already
parses: `tool_call`, `tool_result`, `content_block_delta`, `usage`, etc. Most normalization code
is reusable.

## File layout

| File | Purpose |
|---|---|
| `server/providers/claude-ollama.js` | New provider class `ClaudeOllamaProvider extends BaseProvider` |
| `server/providers/claude-code/stream-parser.js` | (new) Extracted from `claude-code-sdk.js` — shared record normalization: `normalizeToolCall`, `normalizeToolResult`, `normalizeUsage`, `extractTextDelta`, `extractFallbackText`. Both providers consume it. |
| `server/providers/claude-code-sdk.js` | Refactored to import from the shared parser |
| `server/providers/registry.js` | Register `claude-ollama` provider factory |
| `server/providers/config.js` | Add default config stanza (disabled by default; requires explicit enable) |
| `server/tool-annotations.js` | No change — provider isn't itself an MCP tool |

## Model discovery

No hardcoded model list. On `checkHealth()` / `listModels()`, the provider:

1. Calls existing `list_ollama_hosts` infrastructure to enumerate active hosts.
2. For each host, reads `/api/tags` and extracts model names.
3. Returns the union, de-duplicated. Only local models (non-`*-cloud` tags) are included;
   cloud tags are filtered out since the bridge can't reach them without signin.

This respects the model-agnostic principle from `project_public_release_model_agnostic.md`.

## Concurrency

Per-host cap of **1**. Rationale: a 24 GB VRAM budget can hold one ~18 GB model resident;
swapping between `qwen3-coder:30b`, `gemma4:latest`, and `qwen3.5:latest` forces Ollama to
unload and reload gigabyte-scale weights each time. The live probe made this visible — four
parallel invocations serialized on swap latency.

Implementation:
- `maxConcurrent` is derived at runtime: `activeHostCount` from `list_ollama_hosts`, capped at 1 per host.
- Reuse `host-mutex.js` to serialize within a host.
- Scheduler should prefer sticky-model batching: drain one model's queue before switching.

## Permission model

Mirrors the existing `claude-cli` / `claude-code-sdk.js` behavior.

- Reads `.claude/settings.json` in the task's working directory for `allowed_tools`,
  `disallowed_tools`, and `permission_mode`.
- Per-task `options` override project settings (same keys).
- Default mode: `auto` (same default as existing providers).
- Tool-call permissions run through the same `evaluatePermission` chain in
  `server/providers/claude-code/permission-chain.js`.

## Session and transcript

Mirrors `claude-code-sdk.js`:

- Sessions live under `<dataDir>/claude-ollama-sessions/` (separate root — different
  `claude_session_id` space from the Anthropic-backed SDK).
- `ensureSession`, `readSessionMeta`, `writeSessionMeta`, `forkSession`, `resumeSession`
  are near-copies; the only material difference is the session root and the CLI invocation.
- Transcript append, tool-call and tool-result logging, usage tracking — all shared with
  `claude-code-sdk.js` via the extracted `stream-parser.js`.

## Smart-routing integration

The provider is registered but **not** wired into smart-routing defaults. Tasks reach it only
via:
- Explicit `provider: "claude-ollama"` in `submit_task` / `smart_submit_task`.
- Per-project defaults (`set_project_defaults { provider: "claude-ollama" }`).
- Explicit routing-template entries (user-authored only).

Rationale: we don't yet have benchmark data proving it beats `ollama-agentic` for any task
category. Keeping it opt-in prevents regressions while the experiment matures.

## Config and enablement

Provider ships **disabled by default**. Enablement path:

```
configure_provider { provider: "claude-ollama", enabled: true }
```

Preconditions the `checkHealth` method verifies:
1. `ollama.exe` (or `ollama`) is on PATH.
2. `claude.exe` (or `claude`) is on PATH.
3. At least one registered Ollama host is healthy and has at least one local model.

Each failed precondition produces a specific error in the health response so the user can fix
what's missing instead of staring at a generic "unavailable."

## Benchmarking (follow-on, not part of this spec)

After implementation, a benchmark run compares `claude-ollama` vs `ollama-agentic` on the same
task set:
- Single-file edits with a known-correct target.
- Multi-file refactors with a verify command.
- Simple Q&A (no tool use) — sanity check that the harness doesn't regress trivial cases.

Metrics: success rate, wall-clock duration, tokens consumed, harness-vs-code failure separation
(did the tool loop fail, or did the model produce wrong code?). Results determine whether the
provider graduates into smart-routing defaults or stays opt-in.

## Non-goals

- Cloud Ollama models. Keep those on `ollama-cloud` — the bridge can't auth to them.
- Replacing `claude-code-sdk.js` or `claude-cli` — the Anthropic-backed providers remain
  primary; this is a new sibling, not a rewrite.
- Custom tool permissions beyond what `claude-cli` already supports. Use the existing
  `allowed_tools`/`disallowed_tools`/`permission_mode` machinery.
- Any kind of interactive fallback. If non-interactive invocation fails, the task fails.
  Visible terminal windows are prohibited by standing user feedback
  (`feedback_silent_providers_only.md`).
