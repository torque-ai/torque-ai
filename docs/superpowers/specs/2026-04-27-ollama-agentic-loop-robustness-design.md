# Local Ollama Agentic Loop Robustness — Design Spec

**Date:** 2026-04-27
**Status:** Implemented on `feat/ollama-agentic-robustness` — pending live smoke test + cutover to main.

> **Implementation note (post-shipping correction):** the spec's "Mix" invariant in the Data Flow section originally said allowlist rejections "didn't reset" the consecutive-error counter when sandwiched between same-tool real errors. The shipped implementation DOES reset on every allowlist rejection (treats it like a success — see `server/providers/ollama-agentic.js`). This is more permissive and matches the design goal of suppressing false-positive stops. The integration test in `server/tests/ollama-agentic.test.js` ("mix: real error + allowlist rejection + same-tool real errors does not trigger early-stop") encodes the actual behavior.
**Scope:** Make local Ollama (qwen3-coder:30b on BahumutsOmen) reliably complete agentic-loop-driven EXECUTE-stage tasks. A small-model robustness pass on the existing agentic loop — three coordinated changes targeting the dominant failure patterns observed in today's production logs.

## Problem

On 2026-04-27, 25 local-Ollama EXECUTE tasks failed against `qwen3-coder:30b`. Sampling 6 representative tasks revealed two distinct failure patterns:

1. **Zero tool calls (5 of 6 sampled).** The model produces well-formed code in markdown blocks (SQL migrations, JS test files, etc.) directly in the response content with `tool_calls: []`. Example: task `8bce19bb` ran 3.5 minutes generating a complete migration + test file in markdown, never once calling `write_file`. The factory's existing system prompt explicitly says `"TOOL CALLS ARE THE ONLY WAY TO MAKE PROGRESS"` and `"If you reply with a prose plan, the task fails"` — qwen3-coder:30b reads this and ignores it.

2. **Tool-error cascade early-stop (1 of 6 sampled).** Task `45659863` actually engaged tools — 9 iterations deep, including `search_files`, `read_file`, `list_directory`, and a successful `write_file` of a complete PowerShell test file. Then iteration 8 used `run_command Get-Content` which the allowlist rejected, iteration 9 retried with `powershell -Command "Get-Content..."` (also rejected), and the 2-consecutive-error early-stop triggered. The model was 7 iterations into productive work and got cut off chasing one verification step.

The system prompt is already explicit and correct. The bottleneck is qwen3-coder:30b's pattern-following: declarative rules don't always force the right behavior at 30B param scale. Stronger levers — demonstrated examples and corrective feedback loops — are needed.

## Goals

1. **Force-engage tool calls.** Get qwen3-coder:30b past the "zero tool calls" failure mode so EXECUTE tasks actually invoke the tool surface.
2. **Reduce false-positive early-stops.** Distinguish recoverable rejections (allowlist hits) from genuine errors so the loop doesn't kill productive work.
3. **Improve tool-call recovery.** When a tool call fails, give the model enough information to choose a different approach.
4. **Preserve frontier-model behavior.** Don't break or degrade the existing path for Codex / Codex-Spark / cerebras-routed agentic tasks.

## Non-Goals

- **Plan-quality gate fixes.** Plan-stage rejection (e.g., `plan_description_quality_rejected` for vague task descriptions) is upstream of the agentic loop. Out of scope.
- **Task decomposition.** Decomposing complex tasks into smaller sub-tasks would address "task too big for the model," but today's data shows the dominant failure is "model doesn't engage tools at all" — independent of task size. Once these robustness fixes ship, the failure curve will shift; decomposition becomes the right next-phase lever based on that new evidence, not pre-emptively.
- **Separate small-model agentic profile.** Branching the agentic loop into "small model" vs "frontier model" paths doubles the surface area to maintain. Single code path with composed lenient behavior is preferred.
- **Capability ceiling improvements.** qwen3-coder:30b's 3B-active-param scale has real limits. This design closes the gap between "model could succeed" and "model actually completes" — it doesn't push the gap higher.
- **Pipeline composition / shell-feature support in run_command.** Pipelines (`A | B`), redirection (`>`), and metacharacter-bearing commands stay rejected for security.

## Related Work

- **Codex Fallback for EXECUTE — Phases 1+2+3** (shipped 2026-04-26, merges `24930d16`, `7707517a`, `834f7a0c`): when Codex is unavailable, the failover routing template directs free-eligible work to chains including local Ollama. This design is downstream — making local Ollama actually succeed at the work it's now being asked to do.
- **Phase 3 plan-augmenter** (`server/factory/plan-augmenter.js`): operates at PLAN stage, adds verify commands to plan tasks. Different concern from the EXECUTE-stage agentic loop addressed here.
- **Existing system prompt** in `buildAgenticSystemPrompt` at `server/providers/execution.js:413`: contains explicit rules about tool calls. This design extends, not replaces, that prompt.

---

## Architecture

A small-model robustness pass on the existing agentic loop. No new modules, no separate small-model profile, no new abstractions. Three coordinated changes land in their natural layers:

```
┌────────────────────────────────────────────────┐
│  buildAgenticSystemPrompt (execution.js)       │
│  + Few-shot example showing tool-call shape    │  ← FIX #1A
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  ollama-agentic.js — outer iteration loop      │
│                                                │
│  iter 0: response parsed                       │
│  ┌─ if tool_calls.length === 0 AND content    │
│  │   length > 50 → corrective reprompt,        │  ← FIX #1B
│  │   retry same iteration                      │
│  │  (fires at most once per task)              │
│  └─ else: continue normally                    │
│                                                │
│  consecutive-error tracking:                   │
│  ┌─ if error has _allowlist_rejection: true    │
│  │   skip the increment (recoverable hint)     │  ← FIX #3 (skip)
│  ├─ else if same tool failed last iteration    │
│  │   counter++; if counter >= 3 → stop         │  ← FIX #3 (3, was 2)
│  └─ else: counter = 1                          │
└──────────────────┬─────────────────────────────┘
                   │
                   ▼
┌────────────────────────────────────────────────┐
│  ollama-tools.js — run_command dispatch        │
│  + Read-only PS cmdlets in default allowlist   │  ← FIX #2A
│  + Rejection error suggests alternative tool   │  ← FIX #2B
│  + Sets _allowlist_rejection: true on result   │
└────────────────────────────────────────────────┘
```

**Why this hangs together:**
- Fix #1 gets the model to invoke tools at all — necessary precondition for everything else.
- Fix #2 reduces the noise rate of valid tool-call attempts that the model would otherwise fail.
- Fix #3 gives the model enough budget to recover from residual errors that fix #2 doesn't preempt.

Without all three: the model would either (a) never tool-call, (b) tool-call but get rejected, or (c) recover but get cut off mid-recovery. The composition is the design.

---

## Components

### Fix #1A — Few-shot example in agentic system prompt

**File:** `server/providers/execution.js` — `buildAgenticSystemPrompt` (~line 413-442)

Append a worked example to the existing prompt before the working-directory line:

```
EXAMPLE — correct first response shape:
Task: "Read server/foo.js and add a license header at the top."
Your first response MUST be a tool call, NOT prose. Here is what a correct first response looks like in the structured tool-call format:
  {"name": "read_file", "arguments": {"path": "server/foo.js"}}
Then on the NEXT iteration, after seeing the file content, you would call:
  {"name": "edit_file", "arguments": {"path": "server/foo.js", "old_text": "...", "new_text": "..."}}
DO NOT respond with text saying "I'll read the file first" — that is prose, not a tool call. Invoke read_file directly.
```

**Rationale:** Models that ignore declarative rules often follow demonstrated patterns. Adds ~150 tokens, negligible against typical 32k–128k context.

### Fix #1B — First-iteration validator + corrective reprompt

**File:** `server/providers/ollama-agentic.js` — after the response-parse step (~line 364-405)

When `iterations === 0` AND `tool_calls.length === 0` AND `content.length > 50`:

```javascript
if (iterations === 0 && !nativeToolCalls?.length && (content || '').length > 50) {
  logger.info(`[Agentic] iter-0 produced text-only response, retrying with corrective`);
  messages.push({
    role: 'user',
    content: 'Your previous response had no tool calls — only text. Tool calls are the ONLY way to make progress. Re-attempt: invoke read_file, list_directory, or write_file directly using the structured tool-call mechanism. Do not write code in the message body.'
  });
  continue;  // don't increment iterations
}
```

Fires at most once per task (gated on `iterations === 0`). If the second attempt also produces text-only, the loop falls through to normal handling — either later iterations produce tool calls or the task hits the iteration cap honestly.

### Fix #2A — Expand `run_command` allowlist with safe PS cmdlets

**File:** `server/providers/ollama-tools.js` — at the default allowlist definition

Add safe read-only PowerShell cmdlets:
- `Get-Content` (≈ `cat`)
- `Get-ChildItem` / `gci` / `dir` / `ls` (≈ `ls`)
- `Select-String` (≈ `grep`)
- `Measure-Object` (≈ `wc`)

Pipeline composition (`Get-Content foo | Select-String x`) is rejected by the existing `isCommandAllowed` shell-metacharacter guard. Allowlist expansion only enables the bare cmdlets.

### Fix #2B — Suggestion-aware rejection error

**File:** `server/providers/ollama-tools.js` — `run_command` allowlist branch (~line 1192-1198)

Replace:
```javascript
return { result: `Error: Command not in allowlist: ${args.command}`, error: true };
```

With:
```javascript
const cmd = args.command.trim().split(/\s+/)[0].toLowerCase();
const suggestions = {
  'cat': 'use read_file({path}) instead',
  'get-content': 'use read_file({path}) instead',
  'head': 'use read_file({path, end_line: N}) instead',
  'tail': 'use read_file({path, start_line: -N}) instead',
  'ls': 'use list_directory({path}) instead',
  'dir': 'use list_directory({path}) instead',
  'get-childitem': 'use list_directory({path}) instead',
  'find': 'use search_files({pattern, path}) instead',
  'grep': 'use search_files({pattern, path}) instead',
  'select-string': 'use search_files({pattern, path}) instead',
};
const hint = suggestions[cmd] ? ` — ${suggestions[cmd]}` : '';
return {
  result: `Error: Command not in allowlist: ${args.command}${hint}`,
  error: true,
  _allowlist_rejection: true,
};
```

The `_allowlist_rejection: true` marker is the signal fix #3 reads to skip incrementing the consecutive-error counter.

### Fix #3 — Relaxed consecutive-error early-stop

**File:** `server/providers/ollama-agentic.js` — consecutive-error tracking block (~line 622-657)

Two changes:
1. Bump threshold: `consecutiveErrorCount >= 2` → `consecutiveErrorCount >= 3`.
2. Skip the increment when `execResult._allowlist_rejection === true`:

```javascript
if (error) {
  if (execResult._allowlist_rejection) {
    // Allowlist rejections are routing hints, not real errors. Reset like a success.
    lastErrorToolName = null;
    consecutiveErrorCount = 0;
  } else if (lastErrorToolName === tc.name && lastErrorIteration < iterations) {
    consecutiveErrorCount++;
    if (consecutiveErrorCount >= 3) {  // was 2
      // ... existing early-stop logic ...
    }
  } else {
    consecutiveErrorCount = 1;
    lastErrorToolName = tc.name;
    lastErrorIteration = iterations;
  }
}
```

Net effect: model can hit allowlist rejection any number of times in a row without penalty (each accompanied by a different tool guess); for genuine errors, gets 3 attempts (was 2) before the loop bails.

---

## Data Flow

### Scenario A — Model produces markdown on iteration 0 (dominant pattern)

```
iter 0: agentic loop sends system prompt (with few-shot example) + user message (task)
   ↓
   model returns: text content "I'll create the migration..." + ```sql ...``` block + tool_calls: []
   ↓
   parser: nativeToolCalls.length === 0, content.length > 50
   ↓
   FIX #1B validator fires → push corrective user message → continue (don't increment)
   ↓
iter 0 (retry): model returns + tool_calls: [{name: "write_file", arguments: {...}}]
   ↓
   tool executor runs write_file → success
   ↓
   loop continues normally, iterations++
```

If retry ALSO produces no tool calls, validator does NOT fire again (single-shot). Normal flow handles the second prose response.

### Scenario B — Model uses run_command for read

```
iter 7: model writes test file via write_file (success)
   ↓
iter 8: model calls run_command({command: "Get-Content Tests/foo.ps1"})
   ↓
   FIX #2A: Get-Content IS now allowlisted → command runs successfully
   ↓
   model gets file content, writes final summary, task completes
```

Old behavior: rejected → retry with `powershell -Command "..."` → also rejected → 2 errors → cut off.

### Scenario C — Destructive command rejected, model recovers

```
iter 4: model calls run_command({command: "rm -rf node_modules"})
   ↓
   FIX #2B: error returned with _allowlist_rejection: true, no specific suggestion
   ↓
   FIX #3: counter NOT incremented (allowlist marker present)
   ↓
iter 5: model calls run_command({command: "del node_modules"})
   ↓
   Also rejected. Counter still NOT incremented.
   ↓
iter 6: model switches tactic to actual task work — loop continues
```

Old behavior: 2 rejections → cut off at iter 5.

### Scenario D — Genuine error (file actually doesn't exist)

```
iter 3: model calls read_file({path: "src/imaginary.js"}) → ENOENT
   ↓ counter = 1
iter 4: model retries similar path → ENOENT
   ↓ counter = 2
iter 5: still failing → ENOENT
   ↓ counter = 3 → THRESHOLD HIT → early stop
```

Old: bailed at iter 4 (count 2). New: bails at iter 5 (count 3). One extra attempt.

### Invariants preserved

1. **No infinite loops.** Validator fires at most once. Allowlist rejections still log per-call. Iteration cap (default 25) unchanged.
2. **No new tool surface.** All four changes are within existing components. No new files, modules, or dependencies.
3. **Frontier models unaffected.** Few-shot example helps but doesn't constrain. Validator only fires on iter 0 with text-only output (frontier models don't do this). Allowlist expansion benefits all models. Relaxed early-stop benefits all models.

---

## Error Handling

### Fix #1A failure modes
- *Could confuse frontier models:* No. Example is presented as illustrating the protocol, not constraining behavior. Frontier models already follow.
- *Could exhaust context:* +150 tokens against typical 32k–128k context. Negligible.

### Fix #1B failure modes
- *Model produces text AND tool_calls:* Validator checks `tool_calls.length === 0`. If there are calls, doesn't fire.
- *Corrective retry also produces text:* Validator gated on `iterations === 0`, fires at most once. Second prose attempt falls through to normal flow.
- *Parser misses a tool call embedded in markdown:* Validator fires unnecessarily; cost is 1 wasted iteration. Mitigation: parser correctness is out of scope.
- *Empty content + zero tool_calls:* Validator's `content.length > 50` check skips this case; existing empty-response retry handles it.

### Fix #2A failure modes
- *Pipeline composition `Get-Content foo | Select-String x`:* Existing shell-metachar guard rejects pipelines. Only bare cmdlets enabled.
- *Dangerous cmdlet flags:* All four added cmdlets are read-only. Flags like `-Force`, `-Tail` are display-modifying, not destructive.
- *Cross-platform:* PowerShell cmdlets fail on Linux with "command not found" — that's a real error counting toward threshold normally. Correct.

### Fix #2B failure modes
- *Suggestion misleads model:* `cat /etc/passwd` would suggest read_file({path: '/etc/passwd'}) — but the existing `isPathTraversalSafe` guard at the read_file boundary still rejects path traversal. Suggestion changes which tool the model tries; underlying safety controls unchanged.
- *Suggestion missing for unfamiliar command:* No suggestion, returns generic error. `_allowlist_rejection: true` still set so fix #3 still suppresses count.
- *Suggestion-table drift:* Map is small and only covers commands with clear safe-tool equivalents. Adding a new tool means adding to the map. If we don't, the model gets a generic message — degraded but not broken.

### Fix #3 failure modes
- *Tool truly broken indefinitely:* Threshold of 3 means 1 extra failed call before bail. Worst-case waste: ~10s. Acceptable.
- *`_allowlist_rejection: true` accidentally set on a real error:* Marker is set in exactly one location (run_command's allowlist branch). New code paths setting it would surface in code review.
- *Allowlist-rejection storm:* Model loops calling run_command with rejected variants. Iteration cap (25) bounds this. If common in practice, follow-up: add "no successful tool call in last N iterations" guard. Out of scope.

### Cross-cutting

- **Telemetry:** Each fix adds structured log lines (`[Agentic] iter-0 retry`, `[Agentic] allowlist rejection (suppressed)`, `[Agentic] consecutive errors threshold raised`). Behavior observable in production logs.
- **Backwards compatibility:** All four changes preserve frontier-model behavior. Existing tests should pass unchanged.

---

## Testing

### Per-fix unit tests

**Fix #1A — Few-shot in system prompt** (`server/tests/build-agentic-system-prompt.test.js` — extend or create)
- Prompt output contains the few-shot example block.
- Existing rules block still present (no regression).
- Working directory still appears at the end.

**Fix #1B — First-iter validator** (`server/tests/agentic-execution-fixes.test.js` — extend)
- Validator fires when iter === 0 + tool_calls empty + content > 50 chars: corrective message pushed, iteration NOT incremented.
- Does NOT fire when tool_calls non-empty.
- Does NOT fire when iter > 0.
- Does NOT fire when content < 50 chars.
- Fires at most once per task.

**Fix #2A — Expanded allowlist** (`server/tests/ollama-tools-allowlist.test.js` — extend or create)
- `Get-Content`, `Get-ChildItem`, `Select-String`, `Measure-Object` → allowed.
- `Remove-Item`, `Set-Content`, `Stop-Process` → still rejected.
- `Get-Content foo | Select-String x` → still rejected (pipeline metachar).

**Fix #2B — Suggestion in error** (same test file)
- Rejected `cat foo.txt` → result includes `use read_file({path}) instead`.
- Rejected `ls -la` → result includes `use list_directory({path}) instead`.
- Rejected `grep -r pattern` → result includes `use search_files({pattern, path}) instead`.
- Rejected `rm -rf node_modules` → no specific suggestion (destructive).
- Every rejection result has `_allowlist_rejection: true`.

**Fix #3 — Relaxed early-stop** (extend `agentic-execution-fixes.test.js`)
- 2 same-tool real errors → does NOT trigger.
- 3 same-tool real errors → triggers `consecutive_tool_errors`.
- 2 same-tool errors + 1 different-tool error → does NOT trigger.
- Allowlist rejection (5 in a row) → counter does NOT increment.
- Mix: 1 real + 1 allowlist + 1 same-tool real → counts as 2 (allowlist sandwiched, didn't reset), 3rd real triggers stop.

### Integration test (new describe block in `agentic-execution-fixes.test.js`)

Mocked Ollama adapter:
1. **Markdown-then-recovery:** iter 0 returns text → validator → iter 0 retry returns tool_call → success.
2. **Allowlist-rejection-recovery:** rejection → counter NOT incremented → next iteration succeeds.
3. **Genuine-error early-stop:** 3 same-tool errors → cut off with `consecutive_tool_errors`.

### Smoke test post-deploy

Take a known-failing task from today's log (e.g., `8bce19bb` — "annotation queues feature") and re-submit to local Ollama. Success criterion: failure mode shifts from "zero tool calls" to "tool calls + actual progress." Not 100% completion — qwen3-coder:30b has real capability ceilings — but the bottleneck moves.

### Out of scope

- Full regression on all 23 of today's failures (manual spot-check sufficient).
- Performance impact (the few-shot adds ~150 tokens; one extra iteration max from validator). Negligible; not measured.
- Cross-model regression on frontier models (covered by existing test suite).

---

## Phasing / Rollout

This design is small enough to ship as a single PR with no internal phasing. Ordering of commits inside the PR for review clarity:

1. Fix #2A — allowlist expansion (smallest, lowest risk).
2. Fix #2B — suggestion-aware rejection error.
3. Fix #3 — relaxed early-stop + allowlist-rejection skip.
4. Fix #1A — few-shot in system prompt.
5. Fix #1B — first-iter validator.
6. Tests for all five.
7. Integration smoke test.

Each commit can be reverted independently if a regression surfaces.

## Migration / Compatibility

- No DB schema changes.
- No config defaults changed.
- No new dependencies.
- Existing tests should pass without modification (the existing 2-error tests will need their numbers updated to the new threshold of 3, but otherwise no shape changes).
- Frontier models are unaffected — they don't trigger the validator, don't typically hit consecutive-error stops, and benefit from the broader allowlist + better error messages.

## Out of Scope

- Plan-quality gate fixes (separate codepath, upstream of EXECUTE).
- Task decomposition (Phase B follow-up — wait for new failure curve after these fixes ship).
- Capability-ceiling improvements (qwen3-coder:30b at 3B-active params has hard limits we can't engineer past).
- Pipeline / shell composition in run_command.
- New tool surface (no new tools, no new modules).
- Performance optimization (negligible impact from these changes).
- Multi-turn conversation memory beyond what the existing loop already provides.

---

## Open Questions

None at this time. Design is complete and self-consistent. If new questions surface during implementation, they should be addressed as plan-time decisions, not spec-time amendments.
