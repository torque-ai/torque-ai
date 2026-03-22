# TORQUE Performance Run — SpudgetBooks Test Bed

## Context

We just completed a massive session implementing 18 competitive features for TORQUE. Everything is documented in memory at `project_competitive_features_session.md`. All 18 features are verified with 154 unit tests + 40 live assertions. Now we need to stress-test TORQUE under real load using every provider and every new feature.

## Objective

Use the SpudgetBooks project (`C:/Users/Werem/Projects/SpudgetBooks` — C#/.NET WPF budgeting app) as a test bed to:

1. **Exercise every LLM provider TORQUE supports** — submit real tasks to each and compare output quality, speed, and reliability
2. **Validate every new competitive feature under load** — provider scoring populates, circuit breakers trip/recover, budget watcher fires, resume context helps retries succeed, commit mutex serializes, symbol indexer provides compact context, templates inject C# agent context, etc.
3. **Identify bugs and performance bottlenecks** — capture any issues that only surface under concurrent multi-provider execution

## SpudgetBooks Overview

- **Stack:** C#/.NET 9, WPF (XAML), SQLite, MVVM architecture
- **Location:** `C:/Users/Werem/Projects/SpudgetBooks`
- **Solution:** `SpudgetBooks.sln`
- **Projects:** Domain, Application, Infrastructure, App (WPF), Cli, Telemetry
- **Build:** `dotnet build SpudgetBooks.sln`
- **Test:** `dotnet test`
- **Route XAML/WPF tasks to cloud** — local LLMs struggle with WPF semantics

## Phase 1: Provider Gauntlet

Submit the SAME task to every available provider and compare results. Use `compare_providers` MCP tool or manual submission.

**Task:** "In SpudgetBooks.Domain/Budgeting/, add a RecurringExpenseCalculator class that computes the next N occurrences of a recurring expense given a start date, frequency (daily/weekly/monthly/yearly), and amount. Include a method GetProjectedTotal(months) that returns the total projected spend. Add unit test file."

**Providers to test (all 13):**

| Provider | Type | Expected Behavior |
|----------|------|-------------------|
| codex | Cloud CLI | Should succeed — primary code provider |
| codex-spark | Cloud CLI | Should succeed — fast single-file |
| claude-cli | Cloud CLI | Should succeed — complex reasoning |
| ollama | Local | Depends on host availability |
| hashline-ollama | Local | Targeted edits — may struggle with new file |
| aider-ollama | Local | Multi-file via SEARCH/REPLACE |
| deepinfra | Cloud API | Large models (Qwen 72B) |
| hyperbolic | Cloud API | Large models, fast output |
| cerebras | Cloud API | Fast inference |
| groq | Cloud API | Low latency |
| google-ai | Cloud API | Large context (800K+) |
| openrouter | Cloud API | Multi-model gateway |
| ollama-cloud | Cloud API | Remote Ollama endpoint |

For each provider, capture:
- Success/failure
- Duration
- Output quality (does it compile? correct logic? good tests?)
- Provider score after completion (from `get_provider_scores`)

## Phase 2: Feature Validation Under Load

Run a TORQUE workflow with 6+ parallel tasks against SpudgetBooks and verify each new feature activates:

### Features to observe:

1. **Provider Scoring** — After Phase 1, run `get_provider_scores` and verify scores populated for each provider tested. Check that composite scores reflect actual quality.

2. **Circuit Breaker** — If any provider fails 3+ times consecutively, verify `get_circuit_breaker_status` shows it as OPEN. Verify it blocks subsequent routing to that provider.

3. **Budget Watcher** — If using paid providers (codex, anthropic), check if budget thresholds fire. May need to set a low test budget first via `set_project_defaults`.

4. **Resume Context** — Deliberately submit a task that will fail (e.g., wrong file path), then retry. Verify the retry task description contains "## Previous Attempt" preamble with files modified, error details, and approach taken.

5. **Commit Mutex** — Submit a workflow with 2+ tasks that have `auto_commit: true`. Verify commits are serialized (no merge conflicts).

6. **Symbol Indexer** — Run `index_project` on SpudgetBooks first. Then submit tasks that reference specific classes. Verify context-stuffed prompts use symbol-level content instead of whole files (check task output for "Referenced Symbols" section).

7. **Project Templates** — Run `detect_project_type` on SpudgetBooks. Verify it returns `csharp` with ".NET conventions" agent context. Verify this context appears in task prompts for free providers.

8. **Test-Verification-Lite** — Submit a Codex task and check the prompt includes "Do NOT run the full project test suite". Verify Codex only runs targeted tests, not `dotnet test` on the full solution.

9. **TUI Dashboard** — Run `bin/torque-top` in a separate terminal during the workflow. Capture a screenshot showing running tasks, queue depth, and recent completions.

10. **SSE Tickets** — Generate a ticket via `POST /api/auth/sse-ticket`, connect via `GET /sse?ticket=xxx`, verify one-time use.

11. **Active Policy Effects** — If any policy profiles are active, verify effects fire (check logs for `[active-effects]` messages).

12. **Output Buffer** — During high-concurrency (6+ tasks), check server logs for batched progress writes instead of per-line writes.

13. **CPU Activity Detection** — If a Codex task appears stalled (no output), verify the stall detector checks CPU before declaring stalled (check logs for "rescued by CPU activity").

## Phase 3: Multi-Provider Workflow

Create a SpudgetBooks feature workflow that distributes work across providers:

```
Workflow: "SpudgetBooks Recurring Expenses Feature"

Step 1 (types — cerebras): Add RecurrenceFrequency enum to Domain/Budgeting/
Step 2 (data — ollama): Add RecurringExpense entity to Domain/Budgeting/
Step 3 (events — groq): Add RecurringExpenseEvents to Domain/Events/
Step 4 (system — codex): Add RecurringExpenseService to Application/Services/
Step 5 (tests — codex): Add RecurringExpenseServiceTests
Step 6 (wire — codex): Wire into DI container in App/
```

Use `step_providers` to route each step to a different provider. Observe:
- Provider fallback if one is unavailable
- Score-based fallback chain ordering
- Circuit breaker tripping if a provider fails
- Resume context on retry

## Phase 4: Bug Hunt

During all phases, watch for:
- Provider routing anomalies (cerebras hijacking, fallback loops)
- Process leaks (git.exe accumulation, node.exe orphans)
- DB lock contention under concurrent writes
- SSE transport disconnections
- Dashboard rendering issues
- Stale provider scores or incorrect composite calculations
- Output buffer losing data on process exit

## Verification Commands

```bash
# Full unit test suite
torque-remote "cd server && npx vitest run"

# Live feature verification (40 assertions)
node server/scripts/test-all-features.js

# TUI dashboard
node bin/torque-top

# Provider scores after testing
# Use get_provider_scores MCP tool

# Circuit breaker status
# Use get_circuit_breaker_status MCP tool

# Symbol index for SpudgetBooks
# Use index_project MCP tool with working_directory=C:/Users/Werem/Projects/SpudgetBooks
```

## Success Criteria

- Every provider tested with at least 1 real task
- Provider scores populated for 5+ providers (trusted threshold)
- At least 1 circuit breaker trip observed and recovered
- Resume context verified in at least 1 retry
- Commit mutex serialization verified with concurrent auto-commits
- Symbol indexer extracts C# symbols from SpudgetBooks
- No process leaks after full run
- Zero data loss from output buffer
- All 154 unit tests still green after the run
