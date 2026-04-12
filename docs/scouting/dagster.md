# Findings: Dagster

**Tagline:** Asset-first orchestrator that makes data products, not task invocations, the center of scheduling, lineage, and operations.
**Stars:** 15.3k (GitHub, 2026-04-11)
**Language:** Python (80.3%)

## Feature 1: Software-defined asset graph
**What it does:** Dagster lets users declare assets as Python functions plus dependency edges, then materialize subsets of that graph as runs. The UI and runtime treat the resulting asset lineage graph as the canonical model of the system.
**Why distinctive:** Most orchestrators make jobs, DAG nodes, or tasks primary and infer outputs secondarily. Dagster flips that: the thing you care about keeping fresh is the asset, and runs are just the mechanism used to update selected nodes in the graph.
**TORQUE relevance:** HIGH - TORQUE currently centers the LLM task, but code patches, test results, docs, telemetry bundles, and release artifacts could be modeled as first-class outputs with explicit provenance. That would make workflows a means of producing and refreshing artifacts instead of the only object the system truly understands.

## Feature 2: Asset checks as attached quality contracts
**What it does:** Dagster allows checks to be defined against assets, execute them alongside or separately from materializations, and surface their status directly in the asset graph and UI. Checks can emit structured metadata and can be used to block downstream work when quality conditions fail.
**Why distinctive:** Verification is embedded in the asset model instead of bolted on as an external CI phase or ad hoc alert. That keeps "is this artifact trustworthy?" attached to the same first-class object as lineage and freshness.
**TORQUE relevance:** HIGH - TORQUE could attach checks directly to code, test, and doc artifacts: lint status, compile success, review verdicts, traceability coverage, bundle integrity, and publish readiness. Downstream tasks or releases could depend on artifact checks rather than re-encoding validation logic in every workflow.

## Feature 3: Partitions and partition-aware dependencies
**What it does:** Dagster can partition assets by time windows, static keys, dynamic keys, or multi-dimensional schemes, then materialize individual partitions independently. Partition mappings describe how an upstream partition feeds a downstream one, which lets backfills and incremental work stay scoped to the relevant slices.
**Why distinctive:** Partitioning is not just a scheduling trick; it is part of the asset model itself. That makes "one day of this table" or "one customer shard of this dataset" behave like a first-class slice of the graph rather than an argument hidden inside a task.
**TORQUE relevance:** HIGH - TORQUE could use the same idea for repo/package/service partitions, test shards, doc sections, customer-specific runs, or daily evidence bundles. Artifact partitions would make partial recompute, targeted invalidation, and backfills much cleaner than replaying broad task graphs.

## Feature 4: Sensors and schedules over asset selections
**What it does:** Dagster schedules launch materializations on a time-based cadence, while sensors evaluate external state and yield run requests when something meaningful changes. Sensors support run keys and cursors so external-event automation can stay idempotent and stateful instead of firing duplicate work.
**Why distinctive:** Automation is decoupled from business logic but still aware of the asset model. Rather than burying polling and cron logic inside tasks, Dagster provides a dedicated control plane for "when should this asset graph or selection be updated?"
**TORQUE relevance:** HIGH - TORQUE already has scheduling machinery, but Dagster's model suggests driving automation from artifact freshness and external change signals instead of only from queued tasks. Run-key and cursor ideas are directly portable for repo watchers, CI failure intake, docs sweeps, and recurring maintenance jobs.

## Feature 5: IO managers as the artifact boundary
**What it does:** Dagster's IO managers control how asset outputs are stored and how downstream assets load them, separating transformation logic from persistence details. The same asset code can therefore materialize to memory locally, then to warehouse tables, object stores, or files in other environments.
**Why distinctive:** Storage is treated as a pluggable runtime boundary, not hardcoded inside every compute function. That preserves the asset graph while letting teams swap transport, caching, and environment-specific storage behavior without rewriting business logic.
**TORQUE relevance:** MEDIUM - TORQUE is not a data warehouse orchestrator, but it has the same problem around artifact persistence: local files, git blobs, object storage, CI artifacts, remote-agent sandboxes, and telemetry bundles. An IO-manager-like layer could centralize how artifacts are written, loaded, cached, and promoted across environments.

## Verdict
Dagster's strongest transferable idea is the asset-first mental model: model the thing being produced, attach lineage and quality to it, and treat runs as implementation detail. For TORQUE, that argues for making code, tests, docs, reports, and release bundles first-class artifacts with checks, partitions, and automation around them. The caution is scope: Dagster is specialized for data platforms, so TORQUE should borrow the artifact model and control-plane concepts without inheriting the full data-platform abstraction stack.
