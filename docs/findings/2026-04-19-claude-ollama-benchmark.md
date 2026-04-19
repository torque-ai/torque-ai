# ClaudeOllama vs Direct Ollama — Benchmark Findings

**Date:** 2026-04-19
**Model:** `qwen3-coder:30b` on a registered Ollama host
**Harness:** `scripts/bench-claude-ollama.js`
**Runs:** 2 prompts × 2 providers × 2 passes = 8 samples, serial on one host

## Result

### Run 1 (cold start on `ollama-direct`)

| Task | Provider | wall_ms | Input tok | Output tok | Output |
|---|---|---:|---:|---:|---|
| q-and-a | `ollama` (direct HTTP) | 18,487 | 16 | 2 | `OK` |
| q-and-a | `claude-ollama` | 95,037 | — | — | `OK` |
| code-gen | `ollama` (direct HTTP) | 1,382 | 33 | 10 | `def square(n):\n    return n * n` |
| code-gen | `claude-ollama` | 94,411 | — | — | `` ```python\ndef square(n):\n    return n * n\n``` `` |

### Run 2 (warm model on Ollama)

| Task | Provider | wall_ms | Output summary |
|---|---|---:|---|
| q-and-a | `ollama` (direct HTTP) | 520 | `OK` |
| q-and-a | `claude-ollama` | **1,605,422 (26.7 min)** | **Off-task** — 2000-word essay about an HP OMEN crash investigation project in the cwd, ignoring the "single word: OK" prompt entirely |
| code-gen | `ollama` (direct HTTP) | 1,485 | `def square(n):\n    return n * n` |
| code-gen | `claude-ollama` | 92,728 | `` ```python\ndef square(n):\n    return n * n\n``` `` |

*(Token counts unavailable for `claude-ollama` — the benchmark used `--output-format text`, which doesn't emit structured usage records. Using `stream-json` + `--verbose` would surface them but adds parser complexity to the benchmark harness; not worth it for a first-pass.)*

## Observations

1. **Both paths produce semantically correct output** on the two tested prompts *in Run 1*. Run 2 surfaced an off-task failure on `claude-ollama` Q&A (see #6).
2. **`claude-ollama` adds ~90s of floor overhead per invocation** even on trivial prompts. Likely attributable to Claude Code CLI startup, session file initialization, MCP server handshake, and the tool-loop scaffolding — all of which happen even when no tools are called.
3. **`ollama` direct is 5–3100× faster** across the two runs. Warm inference on `qwen3-coder:30b` is ~0.5–1.5s; cold model-load adds a one-time ~17s penalty.
4. **Harness prompt bias is visible.** The code-gen prompt explicitly said *"no markdown fencing"*. Direct ollama obeyed; `claude-ollama` produced fenced markdown in both runs. Claude Code appends its own system prompt that biases toward rendered-markdown output, and that prompt overrides the user's formatting instruction on simple tasks.
5. **Code-gen latency is stable** across runs (~93s), but Q&A is wildly variable (95s → 1,605s → off-task essay).
6. **The harness can ignore the user's prompt entirely.** Run 2's `claude-ollama` Q&A took 26.7 minutes to produce a 2000-word unsolicited "project investigation report" about files in the cwd (the SSH user's default home directory, which happened to contain a real software project) instead of the one-word "OK" the prompt asked for. This isn't a model failure — direct `ollama` with the same prompt + model answered correctly in 520 ms. It's a *harness* failure: Claude Code's agentic loop, when bound to a smaller local model in a non-empty working directory, interprets simple prompts as invitations to go exploring. The local model lacks the capability to resist the harness's "be proactive" priors and falls into file-tour mode.
7. **No quality win.** Nothing in either output suggests the Claude Code harness produced *better* content on the prompts it stayed on-task for — it produced *wrapped* content.

## Interpretation

For the tested category — simple Q&A and single-line code generation where no tool use is required — `claude-ollama` is strictly worse: slower, no quality benefit, actively harmful formatting bias, and **can go completely off-task** when the working directory looks interesting to the harness.

The hypothesis still worth testing: `claude-ollama` may pay back its overhead on **tasks that require multi-step tool use** (read file → reason → edit file → verify) where the harness's file-tool loop is actually doing the work the task requires. Benchmarking against a file-edit or multi-file-refactor workload is a separate follow-on — but the off-task Run 2 result means that benchmark needs to also measure *adherence to the prompt*, not just latency and output quality.

## Implications for routing

- **Do not auto-route** any simple-tier task (docs, Q&A, single-line edits) to `claude-ollama`. The wall-clock regression is severe and the prompt-adherence risk is real.
- **Keep `claude-ollama` opt-in** — the spec's decision to land it disabled by default and exclude it from smart routing was correct, and Run 2 strengthens the case.
- If the provider graduates out of opt-in, target only the **large_code_gen** and **complex_multi_file** task categories, and only after a follow-on benchmark shows a quality win AND prompt-adherence in those categories.
- **Always pass an explicit, scoped `working_directory`** when invoking `claude-ollama` — a non-empty cwd with unrelated files can send the harness off on unrelated tours. The spec's requirement that submissions include a `working_directory` becomes load-bearing here.

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
