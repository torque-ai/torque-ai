# ClaudeOllama vs Direct Ollama — Benchmark Findings

**Date:** 2026-04-19
**Model:** `qwen3-coder:30b` on a registered Ollama host
**Harness:** `scripts/bench-claude-ollama.js`
**Runs:** 2 prompts × 2 providers = 4 runs, serial on one host

## Result

| Task | Provider | wall_ms | Input tok | Output tok | Output |
|---|---|---:|---:|---:|---|
| q-and-a | `ollama` (direct HTTP) | 18,487 | 16 | 2 | `OK` |
| q-and-a | `claude-ollama` | 95,037 | — | — | `OK` |
| code-gen | `ollama` (direct HTTP) | 1,382 | 33 | 10 | `def square(n):\n    return n * n` |
| code-gen | `claude-ollama` | 94,411 | — | — | `` ```python\ndef square(n):\n    return n * n\n``` `` |

*(Token counts unavailable for `claude-ollama` — the benchmark used `--output-format text`, which doesn't emit structured usage records. Using `stream-json` + `--verbose` would surface them but adds parser complexity to the benchmark harness; not worth it for a first-pass.)*

## Observations

1. **Both paths produce semantically correct output** on the two tested prompts.
2. **`claude-ollama` adds ~85–90s of harness overhead per invocation** regardless of prompt size. Likely attributable to Claude Code CLI startup, session file initialization, MCP server handshake, and the tool-loop scaffolding — all of which happen even when no tools are called.
3. **`ollama` direct is 5–70× faster** on these prompts. The first direct call (18.5s) had a one-time model-load penalty; the second (1.4s) was pure inference.
4. **Harness prompt bias is visible.** The code-gen prompt explicitly said *"no markdown fencing"*. Direct ollama obeyed; `claude-ollama` produced fenced markdown. Claude Code appends its own system prompt that biases toward rendered-markdown output, and that prompt overrides (or at least weights against) the user's formatting instruction on simple tasks.
5. **No quality win.** Nothing in either output suggests the Claude Code harness produced *better* content on these prompts — it produced *wrapped* content.

## Interpretation

For the tested category — simple Q&A and single-line code generation where no tool use is required — `claude-ollama` is strictly worse: slower, no quality benefit, and actively harmful formatting bias.

The hypothesis worth testing going forward: `claude-ollama` may pay back its overhead on **tasks that require multi-step tool use** (read file → reason → edit file → verify). The harness's file-tool loop and permission system are its differentiator. Benchmarking against a file-edit or multi-file-refactor workload is a separate follow-on.

## Implications for routing

- **Do not auto-route** any simple-tier task (docs, Q&A, single-line edits) to `claude-ollama`. The wall-clock regression is severe.
- **Keep `claude-ollama` opt-in** — the spec's decision to land it disabled by default and exclude it from smart routing was correct.
- If the provider graduates out of opt-in, target only the **large_code_gen** and **complex_multi_file** task categories, and only after a follow-on benchmark shows a quality win on those.

## Known caveats

- Single sample per task — no variance estimate. Latency has noise; the ~90s `claude-ollama` overhead was consistent across both runs but the sample size is small.
- No cold-cache control. Both `ollama-direct` runs shared the same process; the first was a cold-model-load, the second was warm. `claude-ollama` subprocess-spawns fresh each time, so every run is effectively cold.
- The `claude-ollama` benchmark invoked `ollama launch claude` directly rather than routing through TORQUE's provider class — the numbers are about the underlying bridge, not TORQUE's additional per-task accounting. TORQUE routing adds further overhead; real-world `claude-ollama` tasks via `submit_task` will be at least as slow as observed here.

## Reproduce

```bash
scp scripts/bench-claude-ollama.js <user>@<host>:<path>/bench-claude-ollama.js
ssh <user>@<host> node <path>/bench-claude-ollama.js
```

Set `MODEL` and `OLLAMA_HOST_URL` env vars to override defaults.
