# Findings: Cadence

**Tagline:** Distributed durable workflow engine built for multitenant, multicluster operations.
**Stars:** 9.3k (GitHub, 2026-04-11)
**Language:** Go (99.5%)

## Feature 1: Domains as the control boundary
**What it does:** Cadence uses domains as the top-level administrative boundary for workflow retention, owner metadata, bad-binary blocks, archival settings, active cluster, cluster membership, and failover state. Global domains extend the same object with replication and regional routing behavior.
**Why distinctive:** Temporal renamed this concept to namespaces, but Cadence still exposes more of the operator policy directly on the domain object and treats it as the place where tenancy and regional behavior meet. That makes the boundary feel especially explicit for platform teams running many semi-isolated workflow tenants.
**TORQUE relevance:** HIGH - TORQUE has workflows, tasks, providers, and dashboards, but not a first-class tenant object that carries retention, routing, and failover policy together. A Cadence-like domain model could unify project isolation, provider defaults, MCP exposure, and future multi-region routing under one administrative handle.

## Feature 2: Archival as a first-class subsystem
**What it does:** Cadence can move workflow histories and visibility records out of primary persistence after retention, with separate history and visibility settings at both cluster and domain levels. Archivers are selected by URI scheme, so the same feature can target local storage, object stores, or other backends through a pluggable interface.
**Why distinctive:** Cadence treats archival as an operating model, not just a history-retention toggle: per-domain archival URIs, pluggable archivers, archived visibility queries, and documented interaction with global domains are all part of the core story. Compared with Temporal, Cadence still reads as the more operator-shaped archival design for self-managed clusters.
**TORQUE relevance:** HIGH - TORQUE will eventually want cheap primary storage for active state and long-tail retention for audit, debugging, and compliance artifacts. Cadence’s split between live persistence and archival storage is directly portable to workflow logs, task outputs, MCP transcripts, and dashboard visibility indexes.

## Feature 3: Advanced visibility queries
**What it does:** Cadence indexes custom search attributes and lets operators query workflows inside a domain with a SQL-like filter language, including `AND`/`OR`, comparisons, `IN`, `BETWEEN`, `ORDER BY`, plus dedicated `ScanWorkflow` and `CountWorkflow` APIs. Workflows can also upsert search attributes while running, so the search index evolves with execution state.
**Why distinctive:** Temporal has visibility too, but Cadence leans harder into the operator-query model: memo versus indexed attributes is explicit, attribute keys are allowlisted, and the scan/count APIs are documented as tools for very large fleets. The result feels closer to a workflow operations index than a simple debugging filter.
**TORQUE relevance:** HIGH - TORQUE’s dashboard and MCP surfaces would benefit from a real query layer over workflow/task metadata instead of point lookups and status lists. Searchable attributes like provider, queue, owner, failure class, approval state, or SLA bucket would make TORQUE much easier to operate at factory scale.

## Feature 4: Detached child workflows
**What it does:** Cadence child workflows support parent-close policies including `Abandon`, `RequestCancel`, and `Terminate`, so a parent can choose whether a child should stay coupled or keep running independently. That gives workflow authors an explicit way to spawn durable background work without pretending everything has the same lifetime.
**Why distinctive:** The abandoned-child option makes daemon-like or service-style workflows a first-class orchestration pattern instead of an accidental side effect. Cadence documents this policy explicitly in the workflow contract, which makes detached children an endorsed orchestration tool instead of a workaround.
**TORQUE relevance:** HIGH - TORQUE already has cases where a parent workflow wants to kick off a long-lived watcher, remediation loop, or human-follow-up path that should survive cancellation of the initiating flow. A Cadence-style detached child contract would make those patterns explicit, observable, and safer to reason about.

## Feature 5: Global domains and cross-region failover
**What it does:** Cadence global domains replicate workflow state across clusters while keeping one active cluster and any number of standbys. Requests that hit a standby can be API-forwarded to the active cluster, and operators can fail domains over with direct CLI commands or managed graceful failover.
**Why distinctive:** Cadence exposes the multi-region tradeoffs very directly: global domains shift activities from at-most-once toward at-least-once during failover, replication lag can replay work, and conflict handling re-injects external events so workflows still make forward progress. That operator-facing model of forwarding, failover versioning, and per-domain regional control remains one of Cadence’s clearest differentiators.
**TORQUE relevance:** HIGH - If TORQUE ever runs multiple controllers or regions, Cadence’s global-domain model is a strong template for tenant-level active-region selection, forwarded writes, and explicit failover semantics. Even before full multi-region support, the same design could inform HA control planes, standby dashboards, and disaster-recovery drills.

## Verdict
The three ideas most worth porting are domain-level control boundaries, advanced visibility queries, and detached child workflows. Cadence’s domain model would give TORQUE a cleaner administrative surface for tenancy and routing, its visibility model would make large-scale operations materially better, and its detached-child pattern would formalize long-lived background workflows that outlive the flow that started them. The multi-region global-domain model is the next strategic idea once TORQUE needs true cross-controller failover.
