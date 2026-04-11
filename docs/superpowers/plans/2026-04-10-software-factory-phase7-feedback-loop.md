# Software Factory Phase 7: Feedback Loop — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the factory cycle by recording outcomes, comparing predicted vs actual health impact, tracking execution efficiency, and detecting systemic drift patterns.

**Architecture:** A feedback module (`server/factory/feedback.js`) runs post-batch analysis comparing architect predictions against actual health deltas. Results feed into architect memory (stored in `factory_architect_cycles` context), factory-wide patterns (stored in a new `factory_feedback` table), and drift detection alerts.

**Tech Stack:** better-sqlite3 (existing), vitest (existing)

---

## File Structure

```
server/db/migrations.js                    # Modify: migration v18 for factory_feedback
server/db/factory-feedback.js              # Feedback record storage
server/factory/feedback.js                 # Post-batch analysis, drift detection
server/handlers/factory-handlers.js        # Modify: add feedback handlers
server/tool-defs/factory-defs.js           # Modify: add feedback tools
server/api-server.core.js                  # Modify: add REST routes
dashboard/src/views/Factory.jsx            # Modify: add feedback/drift section
server/tests/factory-feedback.test.js      # Tests
```

### Task 1: Migration v18 + Feedback Storage

`factory_feedback` table: id, project_id, batch_id, health_delta_json (before/after scores per dimension), execution_metrics_json (tasks, retries, duration, cost), guardrail_activity_json, human_corrections_json, created_at. DB module with recordFeedback, getFeedback, getPatterns.

### Task 2: Post-Batch Analysis

Create `server/factory/feedback.js`. Exports:
- `analyzeBatch(project_id, batch_id)` — compares pre/post health scores, calculates actual vs predicted delta, counts remediation rate, measures cost-per-health-point
- `detectDrift(project_id)` — checks for priority oscillation (same dimensions alternating), diminishing returns (plateau), scope creep (growing batch sizes), cost creep (increasing cost-per-point)
- `recordHumanCorrection(project_id, correction)` — stores override/rejection data for architect calibration

### Task 3: MCP Tools + Handlers + Wiring

3 tools: `analyze_batch` (run post-batch analysis), `factory_drift_status` (check for drift patterns), `record_correction` (log human override). Handlers, REST routes, tier wiring.

### Task 4: Dashboard Feedback Section

Add to Factory.jsx: health delta chart (before/after per dimension), execution efficiency metrics, drift warnings, human correction log.

### Task 5: Tests

Test health delta calculation, drift detection patterns, correction recording, handler integration.
