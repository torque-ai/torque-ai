# Plan Scope Decisions

A permanent record of feature ideas TORQUE deliberately decided **not** to ship, and the rationale. Use this before generating new plans (autonomous factory or otherwise) — if a candidate looks like an item below, surface the prior decision instead of re-proposing it.

Compiled 2026-05-01 from the spirit-of-TORQUE audit of 74 unimplemented plans (the "fabro" autonomous-roadmap pass plus stragglers). The audit applied this lens, taken from `CLAUDE.md`:

> TORQUE is a **control-tower dispatcher** for LLM-coding work — deliberate placement across 13 specialist providers, software-factory autonomous loop, worktree + restart-barrier discipline, codegraph + visual verification + governance + plan quality + auto-recovery. Local-first OSS, plugin-extensible.
>
> TORQUE is **not** a generic Temporal/Inngest/Prefect clone, **not** a generic agent SDK, **not** infrastructure (sandbox/container hosting), **not** an APM platform.

The audit produced 45 explicit **DROP** decisions. They cluster into five themes; treat the themes as the durable reasons. Specific plans are illustrative, not exhaustive.

---

## Theme 1 — Generic workflow-engine clones

**Reason:** TORQUE's workflow primitive is a deliberately small DAG with task rows + decision-log + workflow_checkpoints. Adding event sourcing, signals/queries, partitions, work pools, asset graphs, etc. expands the surface without serving the code-factory loop. Workflow generality is what Temporal/Cadence/Prefect/Conductor/Kestra/n8n/Camunda exist for.

**Rejected plans (representative):**
- Temporal-style signals/queries/updates (fabro-30)
- Activity boundaries / activity tasks (fabro-31)
- Distributed agent runtime over WebSocket (fabro-32)
- Concurrency keys (fabro-33)
- Asset-centric artifacts (fabro-34)
- Workflow partitions (fabro-35)
- Deployments + work pools (fabro-36)
- Multi-tenant domains (fabro-38)
- Visibility query DSL (fabro-39)
- Detached child workflows (fabro-40)
- System task kinds (inline/jq/http/human) (fabro-43)
- Unified trigger admission layer (fabro-45)
- Workflow revisions / versioning DSL (fabro-51)
- Scoped error boundaries (fabro-53)
- Configured failure-handler workflows (fabro-56)
- Crew/Flow split (fabro-26)

**What we use instead:** task rows, workflow YAML in git, governance rules, auto-recovery engine, restart-barrier task primitive.

---

## Theme 2 — Generic agent SDK / authoring abstractions

**Reason:** TORQUE's "agent" is a provider invocation with deliberate placement and verify. We are not an SDK that other systems embed; we don't ship a prompt DSL, an HTTP agent protocol, a typed task contract layer, or a visual builder. Those are products in their own right.

**Rejected plans (representative):**
- AutoGPT Agent Protocol HTTP surface (fabro-57)
- Auto-form UI from signatures (fabro-58)
- Pydantic-AI validator-driven retry (fabro-59) — covered by auto-verify-retry
- Embed-our-runtime library mode (fabro-60)
- Prompt DSL (BAML-style) (fabro-61)
- Reasoning toolkits (think/analyze/search) (fabro-62) — covered by codegraph + scout + peek
- First-class threads (fabro-63)
- Build-time DAG validation (fabro-64)
- Code-as-action smolagents (fabro-76)
- Prompt/invocation middleware DSL (fabro-96)
- On-fail action matrix (fabro-98) — covered by auto-recovery
- Procedural memory taxonomy (fabro-102)

---

## Theme 3 — Observability / eval platforms

**Reason:** `CLAUDE.md` is explicit: observability and eval platforms belong in **plugins**, not core. TORQUE's first-class observability is decision-log + Factory.jsx + heartbeats — at the right fidelity for code-factory work. Langfuse/Helicone/OTEL/Promptfoo clones are their own products.

**Rejected plans (representative):**
- Inngest Gantt-waterfall view (fabro-46)
- Langfuse-clone (sessions/datasets/prompts/scores) (fabro-68)
- Semantic-cache middleware (fabro-69)
- Promptfoo+DeepEval matrix runner (fabro-70)
- OpenTelemetry exporter (fabro-78)
- LangSmith rubric annotation queues (fabro-86)
- GPT-Researcher typed reports + citation ledger (fabro-87)
- Helicone proxy/async observability (fabro-90)

**What we use instead:** decision-log table, Factory.jsx, heartbeat events, governance rule emission. APM/OTEL belongs in a plugin if/when somebody needs it.

---

## Theme 4 — Memory / data-integration / exotic infra

**Reason:** TORQUE's memory model is codegraph (symbol intelligence) + project context + per-host model awareness. Chat-agent-style memory hierarchies (Letta/mem0/Zep/LangMem) don't fit the code-edit task shape. Data-source sync, fine-tuning pipelines, and hosted browser substrates are mission drift.

**Rejected plans (representative):**
- Letta core/recall/archival memory (fabro-47)
- Devika browser-driven research (fabro-48) — partly possible via scout variants
- Activepieces full plugin catalog/marketplace (fabro-50)
- Activepieces credential registry (fabro-52) — covered by auth plugin
- LoRA per-project fine-tune pipeline (fabro-54) — out of scope; we route, we don't train
- Bolt.diy `<action>` streaming protocol (fabro-55)
- mem0 background extractor (fabro-66)
- Firecrawl SaaS integration (fabro-74)
- Zep time-aware knowledge graph (fabro-77)
- Dust team-spaces + synced data sources (fabro-81)
- Browser Use AX-tree tool (fabro-93) — peek/snapscope already gives Claude eyes
- Chroma archival memory (fabro-94)

---

## Theme 5 — "Already covered, just not in the shape this plan proposed"

**Reason:** Some plans propose features that effectively exist under different names. The audit confirmed via `git show --stat` and source greps that the capability is in production (or the closest TORQUE analogue is). These plans were archived rather than deleted; the archived plan stays as a historical pointer to "what we considered before settling on the current shape."

These are PARK decisions, not DROPs — they don't mean "we'll never want this," they mean "what we have already covers the use case at the right cost." If you find yourself proposing one of them, look at the archived plan first.

---

## Plan-file-only merges (caveat for future audits)

Eight plans had branches merged but the merge commits touched only the plan file (1 file / 7-20 lines, no code). Earlier triage passes that matched on branch names alone treated these as SHIPPED. They are now correctly classified as DROP. **Future plan-status audits must grep merge `--stat`, not just branch names.**

The eight: fabro-16, 17, 18, 19, 22, 71, 72, 73.

---

## What this means for plan generation

When the autonomous factory or an architect agent proposes a new plan:

1. **Match against the five themes above.** If the proposal looks like generic workflow-engine, generic agent-SDK, observability-platform, memory-platform, or exotic-infra work, reject early and surface this doc.
2. **Match against the curated next-up backlog** (`docs/superpowers/next-up-backlog.md`). If a plan duplicates one of the KEEP items, dedupe.
3. **Plans are evidence of *thinking*, not evidence of *commitment*.** A merged plan branch is not a shipped feature. Verify with `git show --stat <merge>` and a source grep before trusting the SHIPPED label.
