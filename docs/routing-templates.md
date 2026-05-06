# Routing Templates Reference

Routing templates map task categories to provider chains. They sit upstream of the recovery layer (`docs/recovery-decisions.md`) and the factory loop (`docs/factory-loop-states.md`): a template's chain decides who attempts the work, the loop emits decisions about what happened, and recovery decides what to do when work fails. Most operator-visible "wrong provider for the wrong task" bugs are template bugs, not routing-engine bugs.

This doc is the canonical reference for the 11 preset templates, the schema they conform to, and the categories the resolver actually consumes.

---

## TL;DR

- **11 preset templates** in `server/routing/templates/*.json`. Each is a small JSON file (~21–86 lines).
- **10 canonical task categories** (declared in `server/routing/category-classifier.js`): `security`, `xaml_wpf`, `architectural`, `reasoning`, `large_code_gen`, `documentation`, `simple_generation`, `targeted_file_edit`, `plan_generation`, `default`.
- **11 active providers** referenced across templates: `ollama`, `codex`, `claude-cli`, `cerebras`, `groq`, `google-ai`, `openrouter`, `ollama-cloud`, `anthropic`, `deepinfra`, `hyperbolic`. Two documented providers are NOT used in any template: `codex-spark` and `claude-ollama` — see open question #1.
- **Real bug found in this audit and fixed**: `codex-down-failover.json` had a `tests` chain, but `tests` is NOT a canonical category — the resolver never reads it. Removed. Coverage test added so the same drift can't happen again.

---

## Schema

Each template is an object with these top-level fields:

| Field | Required | Type | Notes |
|---|---|---|---|
| `name` | yes | string (≤ ~50 chars) | Display name. |
| `description` | no | string | Human-readable strategy summary. |
| `rules` | yes | object | Maps each canonical category → chain. Must include all 10 canonical categories. Extra keys are accepted by the validator but **never read** — silent dead config. |
| `complexity_overrides` | no | object | Maps category → `{simple\|normal\|complex: chain}`. Override the base chain when smart-routing classifies the task at that complexity level. |
| `capability_constraints` | no | object | Per-template capability hints (e.g., `max_files`, `greenfield_provider`, `modification_oversize_provider`). Used by `legacy-fallback.json` to mirror legacy hardcoded routing. |

### Chain entry shapes

A chain is either:
- **A string** — shorthand for `[{provider: <string>}]`. `all-local.json` uses this form (e.g., `"security": "ollama"`).
- **An array of `{provider, model?}` objects** — e.g., `[{"provider": "codex"}, {"provider": "cerebras", "model": "qwen-3-235b-a22b-instruct-2507"}]`. Max chain length: 7.

Every entry must have a non-empty `provider` string. `model` is optional; smart routing falls back to per-provider defaults when omitted.

The validator (in `server/routing/template-store.js validateTemplate`) accepts both forms, but does NOT reject extra keys outside `CATEGORIES`. That's how the `tests` chain in `codex-down-failover.json` survived — the JSON parses, the file passes validation, but the resolver only iterates the canonical 10.

---

## The 11 templates

Strategy summary, primary providers per category. Each row's "primary" column is the first provider in that category's chain.

### `system-default.json` — System Default
Codex for hard problems, free cloud for everything else. Balanced cost vs quality.

| Category | Primary | Notable fallbacks |
|---|---|---|
| security, xaml_wpf, architectural, reasoning, large_code_gen | codex | cerebras, ollama-cloud (kimi-k2, mistral-large-3) |
| documentation | groq (gpt-oss-120b) | cerebras, google-ai |
| simple_generation, plan_generation | cerebras (qwen-3-235b) | groq, ollama |
| targeted_file_edit | cerebras | codex |
| default | cerebras | google-ai, codex |

Has `complexity_overrides` for `targeted_file_edit.complex` and `default.complex` → codex + ollama-cloud (kimi-k2).

### `quality-first.json` — Quality First
Codex primary for all code work, biggest free models as fallback.

| Category | Primary | Notable fallbacks |
|---|---|---|
| Most categories | codex | ollama-cloud (kimi-k2, mistral-large-3) |
| simple_generation | cerebras | codex, groq |
| targeted_file_edit | codex | cerebras |
| default | codex | cerebras, ollama-cloud, google-ai |

### `codex-primary.json` — Codex Primary
Codex for action work, text-gen providers for plan generation.

| Category | Primary | Notable fallbacks |
|---|---|---|
| All except plan_generation | codex | claude-cli, ollama |
| plan_generation | codex | cerebras, groq, ollama |

(2026-05-04 fix: plan_generation used to lead with cerebras; that was a real prod bug. See `project_codex_primary_plan_routing.md` in memory.)

### `cost-saver.json` — Cost Saver
Free models first, codex only as last resort.

| Category | Primary | Codex position |
|---|---|---|
| security, xaml_wpf, architectural, reasoning, large_code_gen | cerebras / ollama-cloud | last (after 3 free providers) |
| documentation, simple_generation | groq / cerebras | not in chain |
| plan_generation | ollama | not in chain |
| targeted_file_edit | cerebras | second (codex as fallback) |
| default | cerebras | last (after 4 free providers) |

### `cloud-sprint.json` — Cloud Sprint
Maximum speed — cerebras everywhere, codex fallback.

| Category | Primary | Fallback |
|---|---|---|
| Almost all | cerebras (qwen-3-235b) | codex (or groq for documentation) |

### `free-agentic.json` — Free Agentic
Zero-cost agentic tool calling. Groq restricted to docs/simple (unreliable multi-step tool calling).

| Category | Primary |
|---|---|
| security, xaml_wpf, simple_generation, default, targeted_file_edit | cerebras |
| architectural, large_code_gen | ollama-cloud (kimi-k2) |
| reasoning | ollama-cloud (mistral-large-3) |
| documentation | groq |
| plan_generation | ollama |

No codex anywhere. `complexity_overrides.targeted_file_edit.complex` → ollama-cloud (kimi-k2).

### `free-speed.json` — Free Speed
Sub-second cerebras primary, codex safety net.

| Category | Primary | Fallback |
|---|---|---|
| Almost all | cerebras | ollama-cloud / google-ai → codex |
| documentation | groq | cerebras, google-ai-flash-lite |

### `all-local.json` — All Local
Ollama everywhere. Uses string-shorthand chain syntax.

| Category | Chain |
|---|---|
| All | `"ollama"` |

`complexity_overrides`: `architectural`, `reasoning`, `large_code_gen` complex → `"codex"` (escape hatch). Also string-shorthand.

### `ollama-cloud-primary.json` — Ollama Cloud Primary
Ollama Cloud first for all categories, codex as late escape hatch.

| Category | Primary | Tail |
|---|---|---|
| All | ollama-cloud (varies by category — kimi-k2, mistral-large-3, qwen3-coder) | codex |

Detailed `complexity_overrides` for `reasoning`, `large_code_gen`, `targeted_file_edit`, `default`.

### `codex-down-failover.json` — Codex-Down Failover
Routes around a tripped Codex circuit breaker. Free-eligible categories use fast/cheap providers; codex-only categories use the most capable free models. Activated by `failover-activator.js` when codex circuit-breaker fires.

| Category | Primary |
|---|---|
| simple_generation, targeted_file_edit | groq |
| documentation, default, plan_generation | groq / cerebras |
| architectural, reasoning, security | ollama-cloud (kimi-k2) / google-ai (gemini-2.5-pro) |
| large_code_gen | ollama-cloud (qwen3-coder:480b) |
| xaml_wpf | ollama-cloud (kimi-k2) |

(2026-05-06 fix: removed dead `tests` chain that the resolver never read.)

### `legacy-fallback.json` — Legacy Fallback (auto)
Catch-all tail template mirroring the historical hardcoded `matchProviderByPattern` routing. Runs LAST in the template chain only when no explicit per-task or active template returned a chain. Operators can edit/disable like any other template.

| Category | Chain |
|---|---|
| security | anthropic, claude-cli |
| xaml_wpf | codex |
| architectural, reasoning, large_code_gen | deepinfra, hyperbolic, ollama-cloud |
| documentation, simple_generation | groq |
| plan_generation, targeted_file_edit, default | `[]` (intentionally empty — falls through) |

Carries `capability_constraints`: `{ max_files: { groq: 1 }, greenfield_provider: "codex", modification_oversize_provider: "codex" }`.

---

## Open questions / risks

### 1. `codex-spark` not used in any template

`codex-spark` is documented as "Fast single-file edits (gpt-5.3-codex-spark model)" — purpose-built for `targeted_file_edit`. But no template's `targeted_file_edit` chain leads with it; most lead with cerebras or codex (full).

This is a product/UX call, not a definite bug:
- **For**: putting codex-spark first in `targeted_file_edit` chains for `codex-primary` and `quality-first` would give faster, cheaper single-file edits without quality loss for the common case.
- **Against**: `quality-first`'s thesis is "use full codex for everything" — switching to codex-spark contradicts that.

**Action item**: Decide whether `codex-spark` belongs in any preset's `targeted_file_edit` chain. If yes, update `codex-primary.json` and `system-default.json` (most likely candidates).

### 2. `claude-ollama` not used in any template

Same shape as #1 — `claude-ollama` (Claude Code CLI driving local Ollama models) is documented but unused in templates. Probably intentional (it's a special-case use), but worth flagging.

### 3. Default-disabled providers as primaries

Several templates lead with providers that are disabled-by-default unless the operator sets the API key + runs `configure_provider`:
- `cost-saver`, `system-default`, `cloud-sprint`, `free-speed`, `free-agentic` lead with cerebras/groq/google-ai for many categories.
- If the operator activates one of these templates without enabling those providers, the chain falls through to codex/ollama. The shape is "graceful degradation" rather than failure, but the operator's stated intent (e.g., "I want cheap") doesn't get honored.

**Action item**: Consider an activation-time warning when a template's primary providers aren't enabled. Or a dashboard hint.

### 4. ~~Validator stricter than resolver (empty-chain drift)~~ ✅ RESOLVED 2026-05-06

`legacy-fallback.json` has empty `[]` chains for `plan_generation` / `targeted_file_edit` / `default` — intentionally documented as "fall through to next routing stage" in its description. But the validator rejected empty arrays with `chain must have at least one entry`. legacy-fallback survived because **`seedPresets` doesn't call `validateTemplate`** — preset JSONs are inserted into the DB raw. A USER who tried to create a template with the same fall-through intent via `createTemplate` would have been blocked.

The resolver (`resolveProvider`) handles empty chains correctly: `if (chain.length === 0) return null` → fall through. So the validator was stricter than the actual contract.

**Fix landed**: validator now accepts empty arrays as "fall through" markers (same effect as `undefined`, matches resolver behavior). New regression test pins every preset to validator-passes so future drift between presets and user-shape is caught at test time, not via the validator-bypass loophole.

### 5. Template precedence order is not documented in the templates themselves

Per CLAUDE.md: "User override > per-task template > global active template > smart routing defaults." But the `legacy-fallback.json` description says it "runs only when no explicit per-task or active template returned a chain" — implying yet another tier. Total tiers: per-task user override → per-task template → global active template → legacy-fallback (auto) → smart routing defaults. **Action item**: codify this in `docs/routing.md` or here, with the exact order the resolver consults.

---

## When changing routing templates

If you're adding, modifying, or removing a template:

1. **All 10 canonical categories required.** Use the coverage test added to `tests/routing-templates.test.js` ("every preset declares exactly the canonical category set") — this catches missing or extra categories. The `tests` chain in `codex-down-failover.json` was caught by exactly this kind of check.
2. **Use array-of-objects, not strings, for new chains** unless you have a specific reason. String shorthand works but is harder to extend with `model:` later.
3. **Validator accepts extra keys silently** — this is a bug class, not a feature. The coverage test is the line of defense.
4. **Models are optional** — but provider × default-model can change between releases. If you depend on a specific model behavior, set `model:` explicitly.
5. **For new categories** — adding a new category to `CATEGORIES` in `category-classifier.js` requires every template to add a chain for it. The coverage test will fail until all 11 templates are updated.

---

## Related references

- `server/routing/category-classifier.js` — the canonical 10 categories + classification logic.
- `server/routing/template-store.js` — load + validate logic. `validateTemplate()` is the single source of schema enforcement.
- `server/routing/templates/*.json` — the 11 preset templates this doc describes.
- `tests/routing-templates.test.js` — has a coverage check (added 2026-05-06) that pins every template to the canonical category set.
- `docs/recovery-decisions.md` — what happens AFTER a template's chain fails. The recovery layer's `escalate-architect` strategy bumps `provider_chain_json`, which is a separate per-project chain (NOT the template chain).
- CLAUDE.md § Routing Templates — operator-facing summary.
