# Multi-Dimensional Provider Scoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Replace binary success/failure provider tracking with a 4-axis scoring model (cost, speed, reliability, quality) that feeds into smart routing decisions.

**Architecture:** Add a provider_scores table that accumulates per-provider metrics from task completions. A ProviderScoringService computes composite scores with configurable weights. Smart routing queries scores when selecting providers. Requires minimum sample count (5) before trusting data.

**Tech Stack:** SQLite, existing provider-routing-core.js, existing cost_tracking table

**Inspired by:** CreedFlow's BackendScoringService (4-axis scoring with sample gating)

---

### Task 1: Schema -- provider_scores table

**Files:**
- Modify: `server/db/schema-tables.js` (add table definition)
- Test: `server/tests/provider-scoring.test.js`

- [ ] Step 1: Write failing test -- table exists after init
- [ ] Step 2: Run test to verify it fails
- [ ] Step 3: Add CREATE TABLE provider_scores with columns: provider (PK), cost_efficiency, speed_score, reliability_score, quality_score, composite_score, sample_count, total_tasks, total_successes, total_failures, avg_duration_ms, p95_duration_ms, avg_cost_usd, last_updated, trusted (boolean, set when sample_count >= 5)
- [ ] Step 4: Run test to verify it passes
- [ ] Step 5: Commit

---

### Task 2: Core scoring module

**Files:**
- Create: `server/db/provider-scoring.js`
- Test: `server/tests/provider-scoring.test.js` (append)

Functions to implement:
- `recordTaskCompletion({ provider, success, durationMs, costUsd, qualityScore })` -- upsert into provider_scores, recompute axes
- `getProviderScore(provider)` -- single provider row
- `getAllProviderScores({ trustedOnly })` -- all scores, optionally filtered
- `getCompositeWeights()` -- returns { cost: 0.15, speed: 0.25, reliability: 0.35, quality: 0.25 }
- `setCompositeWeights(weights)` -- persists to config table

Scoring formulas:
- reliability = total_successes / total_tasks
- speed = 1 - (avg_duration_ms / max_duration_across_providers), clamped 0-1
- cost = 1 - (avg_cost_usd / max_cost_across_providers), clamped 0-1 (free = 1.0)
- quality = exponential moving average of qualityScore inputs
- composite = weighted sum, only computed when sample_count >= MIN_SAMPLES (5)
- trusted = 1 when sample_count >= MIN_SAMPLES

- [ ] Step 1: Write failing tests for recordTaskCompletion (new provider, sample gating, composite calculation)
- [ ] Step 2: Run tests to verify they fail
- [ ] Step 3: Implement provider-scoring.js
- [ ] Step 4: Run tests to verify they pass
- [ ] Step 5: Commit

---

### Task 3: Wire scoring into task completion pipeline

**Files:**
- Modify: `server/handlers/task/pipeline.js` (where finalizeTask transitions status)
- Test: `server/tests/provider-scoring.test.js` (integration)

Hook point: after task status transitions to completed/failed. Call recordTaskCompletion with provider, success boolean, durationMs, costUsd, and qualityScore (default 0.7 for completed, 0.0 for failed; override from verification results when available).

- [ ] Step 1: Write failing integration test
- [ ] Step 2: Identify hook point in finalization pipeline
- [ ] Step 3: Add scoring call (wrapped in try/catch -- non-critical)
- [ ] Step 4: Run tests
- [ ] Step 5: Commit

---

### Task 4: Wire scoring into smart routing

**Files:**
- Modify: `server/db/provider-routing-core.js` -- provider selection logic
- Test: `server/tests/provider-scoring.test.js` (routing integration)

After filtering by availability and capability, sort candidates by composite_score (trusted providers first, then by score descending). Fall back to existing heuristic order when no trusted scores exist.

- [ ] Step 1: Write failing test -- routing prefers higher-scored trusted provider
- [ ] Step 2: Add score-aware sorting to provider selection
- [ ] Step 3: Run tests
- [ ] Step 4: Commit

---

### Task 5: MCP tool + dashboard endpoint

**Files:**
- Modify: `server/mcp/index.js` or tool-defs -- add get_provider_scores tool
- Modify: `server/api/routes.js` -- add GET /api/provider-scores
- Modify: `server/tool-annotations.js` -- add annotation

- [ ] Step 1: Add MCP tool definition for get_provider_scores
- [ ] Step 2: Add REST endpoint
- [ ] Step 3: Add tool annotation
- [ ] Step 4: Run tests
- [ ] Step 5: Commit
