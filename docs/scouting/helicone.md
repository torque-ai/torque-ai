# Findings: Helicone

**Tagline:** Drop-in AI gateway and logging layer that adds observability, caching, and controls with minimal code changes.
**Stars:** 4.9k (GitHub, 2026-04-12)
**Language:** TypeScript (91.1%)

## Feature 1: Dual Integration Model: Proxy or Async Logging
**What it does:** Helicone supports two attachment points. Teams can either point an OpenAI-compatible client at Helicone's AI Gateway for inline controls, or use Helicone's async logging path as middleware-style observability without proxying the request path.
**Why distinctive:** Most adjacent tools force a bigger architectural commitment: either adopt a gateway or instrument your application directly. Helicone is distinctive because it makes the tradeoff explicit and keeps both modes inside one product, which lowers adoption friction for teams that want to start shallow and deepen later.
**TORQUE relevance:** HIGH - TORQUE has the same adoption problem whenever new telemetry or policy layers are introduced. A proxy-or-async split would let TORQUE add execution visibility and controls without requiring every integration to move onto one hard deployment model on day one.

## Feature 2: Off-Critical-Path Async Logging
**What it does:** Helicone's async logging mode is designed to capture requests without placing Helicone in the application's critical path. The docs position it as zero propagation delay logging and explicitly note that an issue with Helicone should not cause an outage in the calling app.
**Why distinctive:** Langfuse and Phoenix are stronger on trace schema and evaluation loops, but Helicone is sharper on operational pragmatism for teams that do not want observability infrastructure inline with production inference. That makes its middleware story more concrete than a generic "SDK instrumentation" pitch.
**TORQUE relevance:** HIGH - TORQUE could use the same pattern for provider calls, MCP tools, and workflow telemetry. Inline hooks are useful for enforcement, but off-path logging is the safer default when the main goal is observability instead of request mediation.

## Feature 3: Header-Driven Gateway Controls: Caching and Rate Limits
**What it does:** On the gateway path, Helicone exposes controls through request headers instead of a large policy DSL. It supports edge caching with cache seeds, ignored keys, bucketed responses, and standard cache duration headers, plus rate limits that can be scoped globally, per user, or per custom property and measured by request count or spend.
**Why distinctive:** Portkey also offers gateway policy, but Helicone's approach is smaller-scope and very attachable because the controls travel with the request itself. The combination of Cloudflare-edge caching and segmented rate limiting makes the proxy useful even when a team is not trying to centralize all model routing behavior.
**TORQUE relevance:** MEDIUM - TORQUE is not an inference gateway, so this is not a direct blueprint. The transferable idea is request-scoped execution policy: cacheable work, tenant throttles, or spend caps could ride alongside task metadata instead of only living in central scheduler configuration.

## Feature 4: Properties and User Tracking as First-Class Metadata
**What it does:** Helicone treats metadata as a first-class surface through headers like `Helicone-Property-Environment` and `Helicone-User-Id`. Those values feed filtering, per-user analytics, segmentation, cost tracking, and request exploration without needing a separate analytics pipeline.
**Why distinctive:** This is more opinionated than generic tags because the metadata model is built to answer product and unit-economics questions, not just debugging questions. Compared with more trace-centric observability tools, Helicone leans harder into "which customer, environment, or feature is driving this behavior and cost?" as a default lens.
**TORQUE relevance:** HIGH - TORQUE already has rich execution context such as tenant, workflow class, routing template, and queue. A Helicone-style metadata surface would make it much easier to slice retries, latency, cost, and failures by business dimension without custom one-off reporting every time.

## Feature 5: Prompt Experiments with Centralized Eval Scores
**What it does:** Helicone's docs describe a spreadsheet-like experiments workflow for tuning prompts against production-style traffic, alongside Eval Scores for collecting results from external evaluation frameworks in one place. The current docs also state that Experiments was deprecated and scheduled for removal from the platform on September 1, 2025, while Eval Scores remains documented as an analytics feature.
**Why distinctive:** The distinctive idea is the lightweight bridge between production observability and prompt iteration, rather than a full standalone eval lab. Even with the experiments deprecation notice, Helicone still shows a useful middle ground where production requests, prompt changes, and centralized evaluation signals are meant to reinforce each other.
**TORQUE relevance:** MEDIUM - The experiments UI itself looks like an unstable reference because the docs mark it for removal on September 1, 2025. The stronger takeaway for TORQUE is the loop between production traces, prompt revisions, and centrally reported eval scores rather than Helicone's specific experiments surface.

## Verdict
Helicone is most interesting as a pragmatic hybrid: lighter than a full gateway control plane and lighter than a full observability and eval platform, but unusually strong at making adoption easy. The best ideas for TORQUE are the dual proxy-or-async integration model, metadata-first analytics, and request-scoped controls like caching and segmented rate limits. The experiments story needs caution because the docs mark it deprecated as of September 1, 2025, so Eval Scores and the broader production-to-evaluation loop look like the more durable takeaways.
