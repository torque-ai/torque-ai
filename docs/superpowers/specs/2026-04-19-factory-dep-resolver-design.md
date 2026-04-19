# Factory Dependency Resolver — Design

**Status:** Spec, awaiting implementation.

**Motivation:** When a factory project's `verify_command` fails because a package isn't installed in the environment, the current verify-review-hybrid classifier routes the failure to one of four outcomes — `task_caused` (retry the plan), `baseline_broken` (pause the project), `environment_failure` (pause), or `ambiguous` (retry). None of these *resolve* the missing dep. The loop either burns cycles retrying against the same broken environment or pauses indefinitely pending operator intervention.

User direction (2026-04-19): "Dependencies should become something that the factory resolves, not ignores." This spec adds a distinct `missing_dep` classification and a pluggable resolver that installs the package, updates the project's dependency manifest, and commits the change — exactly what a human does when they hit the same error.

---

## Goal

When verify fails with a recognizable "package not installed" signal:

1. Classify the failure as `missing_dep` (new, 5th classification in verify-review-hybrid).
2. Identify the package name and its ecosystem (Python, Node, etc.) via regex + LLM fallback.
3. Submit a Codex task that installs the package into the project's own environment, updates its declared dependency manifest, regenerates any lock file, and commits the change on the feature branch.
4. Re-run `verify_command`. On pass → resume normal factory flow. On cascade (another missing dep) → resolve again, up to 3 times per batch. On resolver task failure → escalate to an LLM for a second attempt before pausing.

Success = bitsy no longer stalls on a missing pytest plugin, and the fix is durable (manifest updated, lock regenerated, committed on the branch) instead of transient (install on remote machine that persists nowhere).

---

## Architecture

A pluggable module at `server/factory/dep-resolver/` with a registry + one adapter per ecosystem. v1 ships the Python adapter; future managers (npm, cargo, bundler, etc.) plug in as new adapter files.

```
verify_command fails
  ↓
reviewVerifyFailure()  (existing classifier — returns 5th classification)
  ↓
  ├─ environment_failure → pause (existing)
  ├─ task_caused         → retry (existing)
  ├─ baseline_broken     → pause (existing)
  ├─ ambiguous           → retry (existing)
  └─ missing_dep         → DEPENDENCY RESOLVER (new)
                               ↓
                           Codex task: install + manifest update + commit
                               ↓
                           re-run verify_command
                               ↓
                           ├─ passed                          → LEARN
                           ├─ new missing_dep, <3 total       → loop
                           ├─ new missing_dep, =3             → pause (baseline_broken, dep_cascade_exhausted)
                           └─ resolver task errored           → LLM escalation → retry once or pause
```

### Files

```
server/factory/dep-resolver/
├── registry.js          # loads adapters, dispatches by detected manager
├── escalation.js        # LLM escalation helper
└── adapters/
    └── python.js        # pip / poetry / uv / pyproject.toml / requirements.txt
```

### Adapter contract (per ecosystem)

```
detect(errorOutput: string) → {
  detected: boolean,
  package_name?: string,      // module name from regex (may need LLM mapping)
  manager: 'python' | 'npm' | ...,
  signals?: string[],
}

buildResolverPrompt({ package_name, project, worktree, manifest_hint }) → string
  // The Codex task description: identify manifest, add dep in right section,
  // run install, regenerate lock, commit.

validateManifestUpdate(worktreePath: string, expected_package: string) → {
  valid: boolean,
  reason?: string,
}
  // Post-commit sanity: manifest grew, commit landed, no suspicious diff.
```

---

## Detection flow

Inside `reviewVerifyFailure`, added as a new classification branch that runs *after* environment-failure detection and *before* the intersection/LLM-tiebreak logic.

1. **Environment check (existing, unchanged).** Exit code 127 / stderr `ENOENT` / timeout still classify as `environment_failure`. Missing *binary* is different from missing *package* (bash can't find pytest vs pytest can't import a module).
2. **Dep detection (new).** Walk each registered adapter's `detect(errorOutput)`. First adapter whose `detect` returns `{detected: true}` wins. No match → fall through to existing classifier paths.
3. **Package name resolution.**
   - **Regex extract** (fast, in adapter): captures module name from known error patterns.
   - **LLM mapping** (only when module name likely differs from package name): send `{error_output, module_name, manifest_excerpt}` to `submitFactoryInternalTask({ kind: 'reasoning', ... })`. LLM returns `{package_name, manager, confidence}`. If `confidence === 'low'` or JSON is malformed, fall through as `ambiguous` (existing path).
4. **Return** `{classification: 'missing_dep', package_name, manager, module_name, detection_signals}`.

### Python adapter — detection patterns (v1)

```js
const PYTHON_MISS_PATTERNS = [
  /ModuleNotFoundError: No module named ['"]([\w.]+)['"]/,
  /ImportError: cannot import name ['"]([\w.]+)['"] from ['"]([\w.]+)['"]/,
  /ImportError: No module named ([\w.]+)/,  // Py2 style, still seen in pytest output
];
```

Regex catches ~90% of Python miss cases directly. LLM mapping handles long-tail cases (`cv2 → opencv-python`, `sklearn → scikit-learn`, `bs4 → beautifulsoup4`, `yaml → PyYAML`, vendored packages, optional extras).

---

## Resolver action

Factory's EXECUTE-stage handler calls `depResolver.resolve({ classification, project, worktree, workItem })`.

1. **Select the adapter** from `classification.manager`.
2. **Build a Codex task prompt** via `adapter.buildResolverPrompt(...)`.
3. **Submit as internal factory task**:
   ```js
   submitFactoryInternalTask({
     task: prompt,
     working_directory: worktree.path,
     kind: 'targeted_file_edit',
     tags: [
       ...factoryTags,
       `factory:dep_resolve=${package_name}`,
       'factory:dep_resolve=true',
     ],
     project_id: project.id,
     work_item_id: workItem.id,
   });
   ```
   Tags let the worktree-auto-commit listener skip it (the resolver task commits itself).
4. **Await via `handleAwaitTask`** — structured heartbeats, `auto_resubmit_on_restart: true`. Timeout is the project's existing task timeout; no special bound.
5. **On task completed:** call `adapter.validateManifestUpdate(worktreePath, package_name)`. If valid → factory re-runs `verify_command` via the existing retry-path plumbing. If invalid (manifest didn't grow, no commit, suspicious diff) → treat as resolver failure (Section: Escalation).
6. **On task failed / timed out:** escalate.

### Resolver prompt — Python example

```
The verify step failed with "ModuleNotFoundError: No module named 'opencv'".
Detected missing package: opencv-python (Python).

Your job:
1. Identify the project's dependency manifest (pyproject.toml / requirements.txt /
   requirements-dev.txt / setup.py).
2. Add `opencv-python` to the appropriate section — runtime deps if imported by
   non-test code, dev/test deps if only tests use it. Respect existing
   version-pinning conventions in the manifest.
3. Run the project's install command (pip install / poetry add / uv pip install /
   whichever matches the project's setup).
4. If a lock file exists (poetry.lock / uv.lock / Pipfile.lock), regenerate it.
5. Commit with a conventional message like `deps: add opencv-python` on the
   current branch.
6. Do NOT modify application code. Do NOT run the test suite.

Context: worktree at <path>, branch feat/factory-<id>-<slug>.
After making the edits, stop.
```

---

## Cascade + resolver-failure handling

### Cascade (3-resolution cap per batch)

Counter stored in `factory_projects.config_json.dep_resolve_cycle_count`, reset when the batch enters SENSE. Each resolver invocation increments. On the 3rd successful resolve, if re-verify produces a NEW `missing_dep`, the factory does NOT resolve again — it classifies as `baseline_broken` with `reject_reason: dep_cascade_exhausted` and pauses.

Rationale: 3 missing deps in one plan is plausible (bulk refactor, new framework pulled in). 4+ is a signal the plan's dependency story is structurally wrong — better to surface it than churn through installs.

### Resolver failure → LLM escalation (one-shot)

When the Codex resolver task exits failed, or `validateManifestUpdate` returns invalid, the factory does **not** immediately pause. Escalation:

1. Gather context — original verify error, resolver task's stderr/stdout, the diff the task attempted, relevant manifest file contents, the detected package name.
2. Submit to LLM via `submitFactoryInternalTask({ kind: 'reasoning', task: escalationPrompt, project_id, work_item_id, tags: [...factoryTags, 'factory:dep_escalation=true'] })`. The routing template decides which provider runs it (Codex, Claude, DeepInfra, Ollama — whichever the project's template maps to `reasoning`).
3. Escalation LLM returns structured JSON:
   ```json
   {
     "action": "retry" | "pause",
     "revised_prompt": "<new resolver instructions, optional when action=retry>",
     "reason": "<one-sentence diagnostic>"
   }
   ```
4. **`action: retry`** — submit ONE more resolver task with `revised_prompt`. Counts as 1 of the 3 cascade slots. If this second task also fails → pause (no further escalation, no further retries).
5. **`action: pause`** — pause project as `baseline_broken`, reject work item with `reject_reason: dep_resolver_unresolvable: ${reason}`.

**Fail-open:** If the escalation LLM itself errors (provider down, JSON malformed, etc.), default to `action: pause` with `reason: escalation_llm_unavailable`. Never silently retry.

---

## Data model + trust-level gating

No new tables. All state lives in `factory_projects.config_json`:

```json
{
  "dep_resolver": {
    "enabled": true,
    "cascade_cap": 3
  },
  "dep_resolve_cycle_count": 0,
  "dep_resolve_history": [
    { "ts": "2026-04-19T20:00:00Z",
      "batch_id": "factory-<proj>-<id>",
      "package": "opencv-python",
      "manager": "python",
      "outcome": "resolved",
      "task_id": "..." }
  ]
}
```

`dep_resolve_history` is a rolling 20-entry audit. Older entries age out. The permanent record lives in the decision log (see below).

### Trust-level gating (reuses existing factory trust model)

| Trust level | Detection fires → | Resolver task submitted → |
|---|---|---|
| `dark` | Auto-resolve. No operator prompt. | Auto-submitted, auto-committed. |
| `autonomous` | Auto-resolve. Decision log notes the action. | Auto-submitted, auto-committed. |
| `supervised` | Emits `pending_approval` decision with proposed package + manager. | Operator approves via existing gate flow → resolver task then submits. |
| `guided` | Same as supervised. | Same — always requires approval. |

### Kill switch

`config_json.dep_resolver.enabled === false` disables the feature for that project. Verify failures with missing-dep signatures fall through to the existing classifier, which will usually classify as `environment_failure` or `baseline_broken` — same behavior as before this feature.

---

## Decision log actions (new)

Added alongside the existing `auto_*` / `verify_reviewed_*` / `worktree_*` actions:

| Action | Stage | Triggered by | What it means |
|---|---|---|---|
| `dep_resolver_detected` | verify | Adapter detected missing dep in verify output | Classifier returned `missing_dep` |
| `dep_resolver_task_submitted` | verify | Factory submitted Codex resolver task | Resolver in flight |
| `dep_resolver_task_completed` | verify | Codex resolver task completed, manifest validated | Ready to re-verify |
| `dep_resolver_validation_failed` | verify | Codex claimed done but validator disagreed | Treated as resolver failure, escalation may fire |
| `dep_resolver_escalated` | verify | Resolver failed, escalation LLM called | One-shot fallback in flight |
| `dep_resolver_escalation_retry` | verify | Escalation LLM returned `retry`, new resolver task in flight | Last-chance resolution |
| `dep_resolver_escalation_pause` | verify | Escalation LLM returned `pause`, or escalation itself failed | Project pausing with LLM's diagnostic |
| `dep_resolver_reverify_passed` | verify | Re-verify after resolution passed | Factory continues to LEARN |
| `dep_resolver_reverify_failed_cascade` | verify | Re-verify found another missing dep, within cap | Cascade, another resolution firing |
| `dep_resolver_cascade_exhausted` | verify | 3 resolutions done, 4th missing dep detected | Pausing project |

---

## Testing

### Unit tests

- `server/factory/dep-resolver/adapters/python.test.js` — regex detection across all known miss patterns, module→package mapping invocation, edge cases (empty output, mixed errors, dotted module names).
- `server/factory/dep-resolver/registry.test.js` — adapter registration, dispatch by manager, no-match fallthrough.
- `server/factory/dep-resolver/escalation.test.js` — LLM returns `retry` → second task built; returns `pause` → pause signaled; LLM errors → fail-open pause.
- `server/tests/verify-review.test.js` (extend existing) — `reviewVerifyFailure` returns `{classification: 'missing_dep', ...}` when Python adapter detects + LLM maps. Negative case: LLM returns low confidence → classify as `ambiguous`.

### Integration tests (new: `server/tests/factory-dep-resolver-integration.test.js`)

- **Scenario 1 (happy path, auto):** dark-trust project, verify fails with `ModuleNotFoundError: No module named 'opencv'`. Mock Python adapter returns `{package_name: 'opencv-python'}`. Mock Codex resolver task completes. Mock re-verify passes. Assert: factory_worktrees row still active, commit landed on branch, decision log has `dep_resolver_detected` + `dep_resolver_reverify_passed`, work item status = verifying.
- **Scenario 2 (cascade cap):** three cycles of resolve→verify-fails-with-new-dep, then 4th dep detected → pause with `reject_reason: dep_cascade_exhausted`. Assert counter = 3, project status = paused.
- **Scenario 3 (resolver task fails → escalation → retry → pass):** first resolver task errors, escalation LLM returns `{action: retry, revised_prompt: ...}`, second resolver task succeeds, verify passes.
- **Scenario 4 (resolver task fails → escalation → pause):** escalation LLM returns `{action: pause}`, project paused with LLM's reason.
- **Scenario 5 (supervised trust gate):** `trust_level: supervised`, detection fires, factory emits `pending_approval`, does NOT auto-submit resolver. Test stops at the approval gate.
- **Scenario 6 (feature disabled):** `config_json.dep_resolver.enabled = false`, verify fails with `ModuleNotFoundError` → existing classifier runs, classifies as `environment_failure` or `baseline_broken`, no resolver involvement.
- **Scenario 7 (escalation LLM unavailable → pause):** resolver fails, escalation LLM returns invalid JSON → pause with reason `escalation_llm_unavailable`.

### Post-deploy smoke (manual)

Trigger a known-Python-project factory cycle with an intentionally-removed dep. Watch decision log + commit on branch. Documented as a cutover-verification step in the implementation plan; not automated (requires a real remote workstation with Python).

---

## Out of scope (v1)

- **Non-Python adapters.** The plugin architecture is designed for npm / cargo / etc., but v1 ships only Python. Future work adds one adapter file per ecosystem.
- **Allowlist / denylist for auto-installed packages.** Revisit if a supply-chain incident or runaway misdetection surfaces; for v1, trust-level gating + decision log audit is sufficient.
- **Typo-squat / download-count heuristic checks.** Same rationale — add if real-world failures justify.
- **Cross-project dep sharing** (e.g., shared pip cache). Each project resolves to its own manifest per the D decision in brainstorming.
- **Version-conflict resolution.** If Codex can't satisfy a version constraint, the resolver task fails → escalation → pause. Designing an auto-downgrade heuristic is v2 work.
- **Dashboard UI for `dep_resolve_history`.** REST + decision log expose the data; a dedicated panel is v2.

---

## Open questions (revisit during implementation)

- Should the adapter's `validateManifestUpdate` tolerate CRLF-only diffs? (Windows worktrees sometimes produce whitespace-only diffs that still count as "committed".)
- Does `manifest_excerpt` passed to the LLM mapping call need truncation for projects with very large `pyproject.toml` / `poetry.lock` files? Current factory tasks cap context at 96K tokens for free providers; a 5MB lock file would overflow. Likely: excerpt first 200 lines of manifest + project-declared package names only.
- For `kind: 'reasoning'` routing, should escalation be forced to the most-capable provider regardless of active template, or respect the template? Defaulting to template-driven; operators who care can pin via `set_routing_template`.

---

**End of spec.**
