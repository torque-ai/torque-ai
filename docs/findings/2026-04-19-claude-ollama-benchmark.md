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

## Tool-use benchmark (Run 3) — the hypothesis fails

The Run 1/2 conclusion was "claude-ollama is worse on simple prompts but might pay back on multi-step tool use." A third benchmark tested that hypothesis directly.

**Fixture:** `fixture.py` with three Python functions that each use a local variable named `total`.

**Task (identical for both providers):** *"In fixture.py, rename every occurrence of the local variable `total` to `accumulator`. Do not change function names. The `sum(numbers)` call should remain unchanged. After making the edits, stop."*

**Harness:**
- `claude-ollama` — `ollama launch claude --model qwen3-coder:30b -- -p <task> --add-dir <fixture-dir> --permission-mode bypassPermissions --output-format text`. Real agentic tool use; the harness exposes Read/Edit/Grep and Claude Code's tool loop drives them.
- `ollama-direct` — single HTTP POST to `/api/chat` with the task + fixture content inline, prompting for the rewritten file back.

**Result:**

| Provider | wall_ms | Semantic pass | File on disk edited? |
|---|---:|---|---|
| `claude-ollama` | 147,109 | **NO** | no — fixture unchanged |
| `ollama-direct` | 85,369 | **YES** | yes, correct 8-for-8 rename |

`claude-ollama`'s harness log shows the root cause — Qwen3-coder:30b emits tool calls in pseudo-XML (the format it was trained on), not Anthropic-style:

```
<function=Read>
<parameter=file_path>
<fixture-dir>\fixture.py
</parameter>
</function>
</tool_call>
```

Claude Code's harness expects structured tool-use blocks per Anthropic's tool-use protocol. It saw this as plain text, never dispatched a Read tool, and the 147s was the model narrating its plan without actually executing any file operations. The on-disk fixture stayed identical.

`ollama-direct`, with the file content inline and a "return the edited file" prompt, solved it correctly and faster.

## Interpretation

Across all three benchmarks — simple Q&A, single-line code-gen, multi-step file edit — `claude-ollama` has no category where it wins against `ollama-direct` on `qwen3-coder:30b`. The hypothesis that multi-step tool use would pay back the harness overhead was falsified by the exact opposite result: the provider produced zero file changes on a tool-use task that `ollama-direct` completed in 85s.

**Root cause — model × harness mismatch:** Qwen3-coder:30b is trained to emit tool calls in pseudo-XML (OpenAI functions-calling / xLAM / Llama formats). Claude Code's harness only recognizes Anthropic's structured tool-use blocks. There's no translation layer in `ollama launch claude`; the harness just treats the model's tool intent as narration text. Effectively `claude-ollama` is a text-only wrapper with 90+ seconds of harness overhead.

**What would change this:** a larger or better-adapted model that emits Anthropic-format tool calls natively (e.g. a fine-tune on Anthropic's tool protocol, or a translation shim in the bridge itself). Qwen3-coder:30b doesn't clear that bar. Haven't tested whether any locally-pullable model does — probably none of the current Ollama catalog, since they're trained against OpenAI's format.

## Implications for routing

- **Do not auto-route anything to `claude-ollama`** with `qwen3-coder:30b` (or any currently-installed local model). No task category wins for it.
- **Keep `claude-ollama` opt-in and disabled by default** — the spec decision holds. Landing it as opt-in let us run these benchmarks without exposing normal submissions to a broken path.
- **Always pass an explicit, scoped `working_directory`** when invoking `claude-ollama` — a non-empty cwd with unrelated files can send the harness off on unrelated tours (Run 2).
- **Re-evaluate only when a local model trained on Anthropic's tool-use protocol exists.** Until that model lands, or until the `ollama launch claude` bridge grows a pseudo-XML → Anthropic-format translation shim, the provider has no functional win to deliver.

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
