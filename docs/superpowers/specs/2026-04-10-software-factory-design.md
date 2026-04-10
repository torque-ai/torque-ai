# TORQUE Software Factory — Design Specification

**Date:** 2026-04-10
**Status:** Draft
**Scope:** Project lifecycle factory — spec to shipped release with configurable autonomy

## Overview

TORQUE evolves from a task orchestrator into an autonomous software factory capable of managing entire project lifecycles. The factory accepts work from any source, maintains a holistic understanding of each project's health, makes product-aware prioritization decisions, executes through the existing team pipeline, verifies results, learns from outcomes, and ships — with configurable human oversight ranging from full supervision to fully dark operation.

### Design Principles

1. **Holistic over local** — the factory optimizes for the whole project, not the file in front of it. Balance across health dimensions is the structural bias.
2. **Glass box, not black box** — every decision, every action, every reasoning chain is observable from the dashboard or via MCP tools. Transparency is non-negotiable at any trust level.
3. **Guardrails are not optional** — safety mechanisms fire regardless of autonomy level. Trust level controls approval gates; guardrails are always enforced.
4. **One action to find, one action to act, same state everywhere** — both human (dashboard) and LLM (MCP tools) surfaces expose the same controls with equal accessibility. No capability is buried or multi-step.
5. **Project-agnostic** — the factory can onboard and manage any codebase, not just TORQUE itself. Long-term target is arbitrary external projects.

### What Exists Today

TORQUE already has the execution backbone:
- 13 execution providers with smart routing, fallback chains, and routing templates
- Team pipeline (Planner, QC, Remediation, UI Reviewer)
- Workflow DAGs, scouts (8 variants), visual sweep fleet, scheduling
- 733 test files, DI container, event bus, plugin architecture
- Dashboard with ~35 views (Kanban, budget, providers, governance, approvals)
- CI watcher, governance engine, versioning/auto-release
- Remote workstation federation, codebase study, ~600 MCP tools

The factory builds on this foundation. The execution layer is mature. What's missing is the intelligence layer (health model, architect), the continuous loop, the intake system, and the guardrails that make autonomous operation safe.

---

## 1. The Factory Loop

The factory operates as a continuous per-project loop:

```
SENSE -> PRIORITIZE -> PLAN -> EXECUTE -> VERIFY -> LEARN -> (repeat)
```

| Stage | Subsystem | Purpose |
|-------|-----------|---------|
| **Sense** | Project Health Model | Scan the project across multiple dimensions. Produce a quantitative health snapshot. |
| **Prioritize** | Architect Agent | Read the health model, apply product-sense reasoning, produce a ranked work backlog with reasoning. |
| **Plan** | Decomposer (enhanced Planner) | Take the top-priority work item and decompose it into executable tasks with dependency ordering, respecting scope budgets. |
| **Execute** | Team Pipeline | Existing infrastructure — smart routing, provider selection, workflows, QC, remediation. |
| **Verify** | Verification Gate | Post-execution validation — tests, build, visual verification, architectural review, health delta check, regression detection. |
| **Learn** | Feedback Loop | Measure actual impact against predicted impact. Record outcomes. Calibrate future decisions. |

The **Trust Policy** wraps the loop and determines which stage transitions are autonomous vs. require human approval.

The **Intake System** feeds work items into the loop from any source.

The **Dashboard** provides real-time observability into every stage.

### Loop Cadence

Configurable per project:
- **Active development:** cycle after every completed batch or significant event
- **Maintenance:** daily or weekly
- **On-event:** triggered by new issues, CI failures, dependency alerts
- **On-demand:** human requests a cycle

---

## 2. Project Health Model

The factory's structural awareness. Quantitative answer to "what shape is this project in?"

### Health Dimensions

Each dimension produces a 0-100 score with specific findings that justify the score:

| Dimension | Measures | Data Sources |
|-----------|----------|-------------|
| **Structural Integrity** | Module boundaries, dependency cycles, file sizes, single points of failure, DI usage | `scan_project`, codebase study, static analysis |
| **Test Coverage** | % covered, critical paths tested, test quality (not just count), test/code ratio | Coverage tools, test-coverage scout |
| **Security Posture** | Known vulnerabilities, secret exposure, input validation, auth coverage | Security scout, dependency audit |
| **User-Facing Completeness** | Features finished end-to-end? Error states? Loading states? Edge cases? | Codebase study + Architect inference |
| **API Completeness** | Endpoints documented, error responses defined, contracts tested | Schema analysis, contract tests |
| **Documentation** | README accuracy, inline docs for public APIs, architecture docs vs reality | Documentation scout |
| **Dependency Health** | Outdated packages, known CVEs, abandoned dependencies, version drift | Dependency scout, package audit |
| **Build & CI Health** | Build reliability, CI pass rate, build time trends | CI watcher, build history |
| **Performance** | Response times, bundle sizes, memory usage, known bottlenecks | Performance scout, benchmarks |
| **Debt Ratio** | TODOs, suppressed warnings, known workarounds, tech debt markers | `scan_project`, grep patterns |

### Scanning Strategy

- **Initial onboard:** Full scan across all dimensions. Expensive but runs once. Produces the baseline.
- **Incremental updates:** After every factory action, re-score affected dimensions only.
- **Periodic deep scan:** Configurable schedule (daily for active, weekly for maintenance). Catches drift that incremental updates miss.

### Storage

Health snapshots stored as time-series — one row per project per dimension per timestamp. Provides:
- Current scores (latest snapshot)
- Trend lines (improving or degrading?)
- Pre/post comparison for any batch

### Balance Scoring

The key prioritization metric is **balance** — the standard deviation across dimensions. A project with all dimensions at 60 is healthier than one with some at 95 and others at 20. Structural bias: **bring the weakest dimension up before polishing the strongest.**

### Dashboard

Radar chart per project showing all dimensions. Click any dimension for findings, trend history, and related work.

---

## 3. Architect Agent

The factory's product mind. Qualitative judgment layer that answers "what should we work on next and why?"

### Role

A scheduled, recurring reasoning process that maintains continuity through persisted state. Sits between the Health Model and the Planner. Synthesizes structural data, product context, and user intent into a prioritized backlog.

### Inputs

1. **Health Model** — current scores, trends, balance analysis, weakest dimensions
2. **Project Context** — persisted project brief describing what the project is, who it's for, critical user journeys, what "done" looks like. Written during onboard, refined over time.
3. **Work History** — what the factory has done, succeeded, failed, in-progress. Prevents re-doing work or oscillating.
4. **Intake Queue** — pending work items from all sources. Human-submitted work carries implicit high priority.

### Outputs

**Ranked Backlog** — ordered work items, each with:
- What to do (concrete enough for the Planner to decompose)
- Why (which health dimension, which user journey, what risk)
- Expected impact (which dimensions should improve, by roughly how much)
- Scope budget (task count ceiling — prevents runaway decomposition)

**Reasoning Log** — human-readable explanation of prioritization. First-class artifact visible on dashboard. Structured, not raw chain-of-thought. Example: "Auth has no tests (Test Coverage: 23) and is on the critical login path (day-one user journey). Settings page polish deferred because structural foundation isn't there yet."

**Flags** — items the Architect is uncertain about or thinks need human input. Surface as notifications; become blockers only if trust policy requires it.

### Product-Sense Prompting

The Architect's prompt encodes product discipline:
- "What does a new user encounter first? Is that path solid?"
- "What breaks the experience if it fails? Is that hardened?"
- "What's been over-invested relative to its importance? What's been neglected?"
- "If this shipped today, what would embarrass you?"

The project brief provides specific context; the prompt provides general product thinking.

### Continuity

The Architect persists between cycles:
- Previous backlog and reasoning
- Decisions and their outcomes (from the feedback loop)
- Human overrides and corrections (calibration data)

Corrections accumulate into project-specific judgment. Repeated overrides on a type of decision teach the Architect that pattern.

### Cadence

- **Active development:** re-prioritize after every completed batch or significant event
- **Maintenance:** daily or weekly
- **On-demand:** human requests re-prioritization

### Scope Budgets

The Architect assigns a scope budget to each work item — a ceiling on tasks the Planner can produce. If the Planner exceeds it, the violation is flagged. Project-wide limits also supported (e.g., "no batch exceeds 20 tasks").

---

## 4. Trust & Policy Framework

How the human configures autonomy per project and the controls that keep it safe.

### Trust Levels

| Trust Level | Sense | Prioritize | Plan | Execute | Verify | Ship |
|-------------|-------|-----------|------|---------|--------|------|
| **Supervised** | auto | pause | pause | auto | pause | pause |
| **Guided** | auto | auto | pause | auto | auto | pause |
| **Autonomous** | auto | auto | auto | auto | auto | pause |
| **Dark** | auto | auto | auto | auto | auto | auto |

- **Supervised** — human approves priorities, plan, verification, and ship. Training wheels for new or high-risk projects.
- **Guided** — human approves plan and ship only. Main operating mode for most projects.
- **Autonomous** — human approves ship only. Reviewing output, not driving process.
- **Dark** — fully autonomous. For low-risk projects where bad releases are cheap.

Default: **Supervised**. Promote as confidence builds.

### Policy Overrides

Fine-grained per-project controls beyond trust level:

| Policy | Controls |
|--------|----------|
| **Budget ceiling** | Max spend per cycle (provider credits, compute) |
| **Scope ceiling** | Max tasks per batch, max files per task |
| **Blast radius limit** | Max % of codebase modified per batch |
| **Restricted paths** | Files/directories requiring approval regardless of trust (e.g., `migrations/`, `.env`) |
| **Required checks** | Verification commands that must pass before ship (tests, build, lint, type-check) |
| **Escalation rules** | Conditions that always pause for human (security findings, breaking changes, major dependency bumps) |
| **Work hours** | Time windows when execution is allowed |
| **Provider restrictions** | Which providers are permitted (privacy-sensitive = local only) |

### Kill Switch

Per-project and global **pause** accessible from the dashboard (one click, always visible) and MCP (`pause_project`, `pause_all_projects`). Freezes the loop — in-progress tasks complete but nothing new starts or ships. Stays frozen until explicit resume.

### Accessibility Contract

**Dashboard (human):**
- Every project card shows a visible pause/resume toggle — always visible, not behind dropdowns
- Project list is searchable and filterable by status (running, paused, trust level)
- Global pause-all button for emergency stop

**MCP/CLI (LLM):**
- `pause_project { project }` — single tool call
- `resume_project { project }` — single tool call
- `pause_all_projects` — emergency stop
- `factory_status` — all projects, trust levels, current activity
- All factory control tools in core tier (always available, no unlock)

Both surfaces read from the same source of truth. State changes are instant and bidirectional.

### Escalation

Events that always escalate regardless of trust level:
- Security vulnerability introduced
- Health dimension dropped below configurable threshold
- Architect confidence below floor
- Budget ceiling approaching
- Conflicting work detected
- External dependency breaking change
- Factory self-correction failed (retries exhausted, remediation stuck)

---

## 5. Intake System

How work enters the factory from any source and becomes a uniform internal representation.

### Work Item Schema

```
Work Item:
  id:           unique identifier
  source:       conversational | github_issue | scheduled_scan | self_generated | api
  origin:       { type, ref } — provenance trace (e.g., github_issue + owner/repo#42)
  title:        short description
  description:  full context, intent, acceptance criteria
  priority:     user_override | architect_assigned | default
  project:      which project
  requestor:    who/what created it (human, scout, CI watcher, architect)
  constraints:  { scope_budget, restricted_paths, deadline, ... }
  status:       intake | prioritized | planned | executing | verifying | shipped | rejected
  created_at:   timestamp
```

### Input Channels

| Channel | Mechanism | Priority |
|---------|-----------|----------|
| **Conversational** | Human describes work in Claude Code or chat. Factory extracts intent, creates work item. | Highest — human asked directly |
| **GitHub Issues** | Factory watches configured repos. Issues matching labels/patterns become work items. | As labeled, or Architect assigns |
| **Scheduled Scans** | Scout findings, dependency alerts, health-triggered work. | Architect prioritizes with everything else |
| **Self-Generated** | Architect identifies gaps from health model. CI watcher detects failures. | Architect assigns, capped by scope budgets |
| **API/Webhook** | External systems POST work items (Slack bots, CI pipelines, other tools). | Configurable per integration |

### Deduplication

Multiple sources may generate overlapping work. Detection by:
- Matching affected files/modules
- Semantic similarity of descriptions
- Architect merge during prioritization

Duplicates are linked, not deleted — provenance chain preserved.

### Dashboard

Intake queue view: all pending items across projects, filterable by source/project/priority. Drag to reorder, click to edit, right-click to reject.

---

## 6. Guardrails Engine

Seven categories of safety. All enforced regardless of trust level.

### 6.1 Runaway Scope

| Guard | Mechanism |
|-------|-----------|
| **Scope budgets** | Architect assigns task ceiling per work item. Planner cannot exceed without escalation. |
| **Blast radius limit** | Per-project cap on % of codebase modified per batch. Default 5%, configurable. |
| **Decomposition depth** | Max sub-task nesting levels. Default 2. Prevents recursive spirals. |
| **Time boxing** | Wall-clock budget per batch. Exceeding pauses and escalates, not grinds. |

### 6.2 Quality Regression

| Guard | Mechanism |
|-------|-----------|
| **Health delta** | Re-score affected dimensions post-batch. Any drop blocks the ship gate. |
| **Architectural review** | Post-scan for dependency cycles, file size explosions, dead code. |
| **Test regression gate** | Full suite must pass. Existing tests cannot regress. |
| **Proportionality check** | Output volume vs. scope. Disproportionate output is flagged. |

### 6.3 Resource Waste

| Guard | Mechanism |
|-------|-----------|
| **Budget ceiling** | Per-project, per-cycle. Pause before exceeding, not after. |
| **Cost tracking** | Per-task actual cost. Architect sees cost-per-health-point-gained. |
| **Idle detection** | Cycling without health improvement triggers escalation after N cycles. |
| **Retry limits** | Per-task ceiling prevents infinite remediation loops. |

### 6.4 Silent Failures

| Guard | Mechanism |
|-------|-----------|
| **Decision audit log** | Every decision logged with reasoning — not just what, but why. |
| **Anomaly detection** | Unusual durations, file size changes, test flips trigger alerts. |
| **Workaround detection** | Post-scan for `// TODO`, `// HACK`, empty catches, disabled tests, suppressed warnings introduced by the batch. |
| **Stale work detection** | In-progress too long, completed but unshipped, unscanned dimensions. |

### 6.5 Security

| Guard | Mechanism |
|-------|-----------|
| **Pre-ship security scan** | Checks for secrets, CVEs in new deps, injection patterns. |
| **Secret fence** | Hard block on reading/writing/committing files matching patterns (`.env`, `*.key`, `credentials.*`). |
| **Network fence** | Tasks cannot make outbound calls unless project policy allows. |
| **Permission scope** | Tasks scoped to declared file paths. Cannot modify outside scope. Enforced by execution environment. |

### 6.6 Conflicting Work

| Guard | Mechanism |
|-------|-----------|
| **File lock registry** | Batches declare expected write sets. Overlapping sets block the second batch. |
| **Post-batch conflict detection** | `detect_file_conflicts` runs automatically. |
| **Branch isolation** | Each batch in its own worktree/branch. Conflicts are merge conflicts, not overwrites. |
| **Cross-batch regression** | After merge, full tests catch interaction bugs. |

### 6.7 Loss of Control

| Guard | Mechanism |
|-------|-----------|
| **Kill switch** | Per-project and global. One click/one tool call. |
| **Reasoning transparency** | Every decision on dashboard with full reasoning. |
| **Rate limiting** | Max batches per hour per project. Prevents flood. |
| **Rollback** | Every batch has pre-state. One-click rollback. |
| **Heartbeat alerts** | Periodic summaries. Silence is also an alert. |

### Guardrail Precedence

Guardrails are **additive and non-overridable by the factory**. The Architect cannot skip a security scan. The Planner cannot exceed scope budgets. Only a human can relax a guardrail, and the action is logged.

Trust level controls approval gates. Guardrails fire always.

---

## 7. Observability Layer

Glass box. Peek inside at any depth, any time.

### Dashboard Views

| View | Shows |
|------|-------|
| **Factory Overview** | All projects: trust level, status (running/paused/idle), health radar at a glance. Air traffic control. |
| **Project Deep Dive** | Single project: health radar + trends, Architect backlog, active batches, history, policy config. |
| **Architect Log** | Structured prioritization reasoning. Readable in 30 seconds. |
| **Batch Timeline** | Gantt-style: batch stages, task execution, verification progress. Click for detail. |
| **Guardrail Monitor** | Live green/yellow/red per project per guardrail. Recent fires, resolutions. |
| **Intake Queue** | All pending work items. Filterable, draggable, editable. |
| **Audit Trail** | Searchable log of every factory decision and action. |
| **Cost Dashboard** | Per-project cost-per-cycle, cost-per-health-point, provider efficiency, trends. |

### Decision Records

Every factory decision persisted as:

```
Decision:
  timestamp:    when
  project:      which project
  stage:        sense | prioritize | plan | execute | verify | ship
  actor:        health_model | architect | planner | executor | verifier | human
  action:       what was decided
  reasoning:    why (human-readable)
  inputs:       what data informed it
  outcome:      what happened
  confidence:   actor certainty (for architect/planner)
```

Powers the Audit Trail, Architect Log, and feedback loop.

### Notification Channels

| Channel | Use |
|---------|-----|
| **Dashboard** | Always on. Badges for approvals, escalations, completions. |
| **SSE push** | Real-time to connected Claude Code sessions. Existing mechanism. |
| **Webhook** | POST on events. Enables Slack, Discord, email, custom. |
| **Digest** | Periodic summary of factory activity. Daily or weekly. |

### LLM Observability Tools

All core-tier (no unlock required):

| Tool | Returns |
|------|---------|
| `factory_status` | All projects, trust levels, current activity |
| `project_health { project }` | Current scores and trends |
| `architect_backlog { project }` | Prioritized work items with reasoning |
| `batch_status { project }` | Active batch progress |
| `guardrail_status { project }` | Green/yellow/red per guardrail |
| `decision_log { project, since, stage }` | Filtered decision history |
| `intake_queue { project }` | Pending work items |

---

## 8. Feedback Loop

Closes the cycle. Makes the factory improve over time.

### Post-Batch Analysis

After every batch (shipped or rejected):

**Health Delta Analysis**
- Re-score targeted dimensions. Did they improve? By how much?
- Did untargeted dimensions degrade? (collateral damage)
- Compare Architect's predicted impact vs. actual

**Execution Efficiency**
- Tasks needed vs. scope budget
- Remediation rate
- Provider first-try success
- Wall-clock time vs. estimate

**Guardrail Activity**
- Which fired? True positive or false positive?
- Any that should have fired but didn't?

**Human Corrections**
- Architect overrides — what changed and why?
- Batch rejections — what was wrong?
- Policy adjustments — what prompted them?

### Where Feedback Writes

**Health Model Calibration**
- Adjust scoring weights for consistently over/under-scoring scouts
- Increase scan frequency for volatile dimensions

**Architect Memory**
- Project-specific judgment records:
  - "Human overrode priority X in favor of Y because Z"
  - "Batches targeting test coverage average 4 tasks, 85% success"
  - "Auth module regressed 3 times — likely deeper structural issue"
- Read at the start of each Architect cycle

**Factory-Wide Patterns**
- Cross-project: "tasks modifying >5 files have 40% remediation rate"
- Provider-by-task-type: "Codex excels at greenfield, struggles with large-file refactors"
- Feeds Planner (better decomposition) and smart routing (better provider selection)

### Drift Detection

Systemic patterns that trigger alerts:
- **Priority oscillation** — alternating between two dimensions without improvement
- **Diminishing returns** — health plateau despite continued work
- **Scope creep** — average batch size growing over time
- **Cost creep** — cost-per-health-point trending upward

All surface on the Guardrail Monitor.

### Not Machine Learning

This is structured record-keeping, not model training. "Learning" = accumulating experience as readable history so LLM agents make better-informed decisions. Like a human project manager getting better after six months — not retraining, just remembering what worked.

---

## 9. End-to-End Scenario

Concrete example. Project "WidgetApp" at **Guided** trust level:

**SENSE:** Health Model scans WidgetApp. Finds: Test Coverage = 31, Security = 72, Structural = 68, User-Facing Completeness = 45. Balance is poor.

**PRIORITIZE:** Architect reads health model + project brief ("customer-facing billing tool, critical path: login -> dashboard -> create invoice -> send"). Reasons: "Invoice creation has no error handling and no tests. User hits this on day two. Writing tests for the invoice flow lifts both Test Coverage and User-Facing Completeness." Produces work item with scope budget of 8 tasks. Reasoning logged.

**PLAN (pause — Guided):** Planner decomposes into 6 tasks. Dashboard shows plan. Human notified, reviews, approves.

**EXECUTE:** Team pipeline runs. Dashboard shows real-time progress.

**VERIFY:** Tests pass. Security clean. Health delta: Test Coverage 31->48, User-Facing Completeness 45->54. No regressions. Proportionality check passes.

**SHIP (pause — Guided):** Dashboard shows batch with health deltas, diff summary, verification results, reasoning. Human approves. Conventional commit, version_intent = fix, auto-release patches.

**LEARN:** Architect predicted +15 Test Coverage, actual +17. 1.2 avg retries. All Codex. $0.34. Memory updated.

**LOOP:** Next cycle. Test Coverage still weakest at 48. Architect picks next highest-impact target on critical path.

Human touched twice (plan + ship). At Autonomous, only ship. At Dark, only dashboard when curious.

---

## 10. Implementation Phasing

This is a large system. Recommended build order based on dependencies:

### Phase 1: Health Model + Project Registry

- Project onboard/registration (DB schema, MCP tools, dashboard view)
- Health dimension scoring (leverage existing scouts + scan_project)
- Time-series storage and trend calculation
- Radar chart dashboard view
- MCP tools: `project_health`, `register_project`

**Why first:** Everything else depends on the health model. The Architect needs it. The guardrails reference it. The feedback loop writes to it. And it's independently useful — even without the full factory loop, having a live health dashboard per project is valuable.

### Phase 2: Intake System + Work Items

- Work item schema and DB storage
- Conversational intake (extract intent from natural language)
- GitHub issue watcher integration
- Self-generated intake (scout findings, CI failures become work items)
- Intake queue dashboard view
- Deduplication logic
- MCP tools: `create_work_item`, `intake_queue`, `reject_work_item`

**Why second:** The Architect needs work items to prioritize. The factory loop needs an intake to feed it.

### Phase 3: Architect Agent

- Architect prompt engineering with product-sense reasoning
- Scheduled execution on configurable cadence
- Backlog generation with reasoning, scope budgets, expected impact
- Architect memory persistence and continuity
- Architect Log dashboard view
- MCP tools: `architect_backlog`, `trigger_reprioritize`

**Why third:** Requires health model (Phase 1) and work items (Phase 2) as inputs.

### Phase 4: Trust & Policy Framework

- Trust levels (Supervised, Guided, Autonomous, Dark)
- Per-project policy configuration (budgets, blast radius, restricted paths, etc.)
- Approval gates wired into factory loop transitions
- Kill switch (dashboard + MCP)
- Factory Overview dashboard view
- MCP tools: `pause_project`, `resume_project`, `pause_all_projects`, `set_trust_level`, `set_project_policy`, `factory_status`

**Why fourth:** Wraps the loop. Must exist before the loop runs autonomously.

### Phase 5: Guardrails Engine

- All seven guardrail categories implemented
- Guardrail Monitor dashboard view
- Escalation routing (dashboard notifications + webhook)
- File lock registry, scope enforcement, secret fence

**Why fifth:** Must exist before dark operation. Some guardrails (test regression, conflict detection) already partially exist and can be wired in quickly.

### Phase 6: Factory Loop Integration

- Wire SENSE -> PRIORITIZE -> PLAN -> EXECUTE -> VERIFY -> LEARN into a continuous cycle
- Loop cadence configuration
- Batch Timeline dashboard view
- Autonomous operation for Supervised and Guided trust levels

**Why sixth:** All subsystems exist. This phase connects them.

### Phase 7: Feedback Loop + Learning

- Post-batch health delta analysis
- Architect memory accumulation from human corrections
- Factory-wide pattern detection
- Drift detection and alerting

**Why seventh:** Needs the loop running to generate data. Can be added incrementally.

### Phase 8: Observability + Notifications

- Decision logging infrastructure
- Audit Trail dashboard view
- Webhook/digest notification channels
- Cost dashboard enhancements

**Why last:** Most valuable when the full factory is running. Some pieces (decision logging) should be wired in earlier as each subsystem is built.

---

## Non-Goals (for now)

- **Multi-tenant** — single operator (you). Multi-user auth is a separate concern.
- **Deployment pipeline** — the factory ships code (merge + release). Deployment to production infrastructure is out of scope.
- **Model training** — feedback is structured records, not training data. No fine-tuning loop.
- **IDE integration** — factory is dashboard + MCP driven. No VS Code/JetBrains plugin.
