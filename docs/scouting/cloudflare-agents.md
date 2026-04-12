# Findings: Cloudflare Agents

**Tagline:** Stateful edge agents built directly on Durable Objects.
**Stars:** 4.7k (GitHub, 2026-04-12)
**Language:** TypeScript (98.8%)

## Feature 1: Durable-Object-Backed Agent Identity
**What it does:** Each unique agent instance runs as its own Durable Object, giving it a globally addressable identity, single-threaded execution, storage, and lifecycle. The model is explicitly one agent per user, room, session, or other named entity, with idle agents hibernating until the next request, message, or alarm wakes them up.
**Why distinctive:** Cloudflare is not layering "agents" on top of an external durable engine; the Durable Object is the agent. That makes the core abstraction feel more like a persistent edge micro-server than a workflow execution record.
**TORQUE relevance:** MEDIUM - The main transferable idea is the single-owner state model for long-lived entities such as workflow coordinators, operator sessions, or remote seats. It is a strong architectural pattern, but adopting it in TORQUE would be a substrate shift rather than a small feature port.

## Feature 2: Durable Instance-Local Scheduling
**What it does:** Agents expose durable scheduling primitives for delayed, date-based, interval, and cron execution, and scheduled work can invoke normal agent methods. The SDK persists schedules to SQLite and uses Durable Object alarms underneath, so timers survive restarts and can wake sleeping agents back up.
**Why distinctive:** This feels like persistent `setTimeout` and `setInterval` attached to the agent itself, not an external scheduler service bolted on from the side. The SDK also hides the Durable Object limitation of a single alarm by multiplexing many schedules through SQL plus one alarm.
**TORQUE relevance:** HIGH - This is the most directly relevant Cloudflare idea for TORQUE because it collapses per-entity timers, retries, reminders, and maintenance jobs into the same durable object that owns the state. TORQUE already has strong scheduling, but Cloudflare's local-timer model is a cleaner mental model for agent- or workflow-scoped automation.

## Feature 3: Hibernating WebSockets as the Primary Control Plane
**What it does:** Agents use WebSockets for real-time bidirectional communication, typed RPC via `@callable()` methods, and live state updates to connected clients. Hibernation keeps the sockets open while the agent sleeps, then restores execution on the next message with persisted agent state and connection metadata intact.
**Why distinctive:** Most durable runtimes treat client connectivity as something external to the durable core. Cloudflare makes presence, wakeup, and coordination part of the same object that owns the durable state, which is especially natural at the edge.
**TORQUE relevance:** MEDIUM - TORQUE could benefit from a similar long-lived channel for live workflow inspection, approval, and remote agent control without paying always-on process costs. The strongest lesson is that interactive control and durable state do not need to be separate systems.

## Feature 4: Per-Agent Embedded SQL Plus Real-Time State Sync
**What it does:** Every agent instance gets its own embedded SQLite database via `this.sql`, plus a higher-level `this.state` and `setState()` layer that automatically persists and broadcasts updates to connected clients. Cloudflare positions the state as colocated with compute, so reads and writes happen inside the same Durable Object instead of reaching out to a remote database first.
**Why distinctive:** This pushes developers toward small sovereign stateful objects instead of stateless handlers backed by one shared persistence tier. It is a very Cloudflare-specific blend of local relational storage, realtime sync, and object identity.
**TORQUE relevance:** MEDIUM - TORQUE already leans heavily on SQLite, so the interesting part is not "use SQL" but "give each long-lived entity its own colocated state boundary." That could reduce coordination overhead in some TORQUE subsystems, though it is less portable than the scheduling and socket patterns.

## Feature 5: Edge Deployment with Built-In AI Routing Hooks
**What it does:** Agents run on Workers across Cloudflare's global network and can call Workers AI or external model providers from regular handlers, scheduled tasks, and WebSocket flows. The docs explicitly support AI Gateway routing so agents can add provider routing, evaluations, rate limits, and long-running streamed responses without leaving the Cloudflare control plane.
**Why distinctive:** The agent host, realtime transport, durable state, and AI routing stack all live on one edge platform. That makes Cloudflare Agents feel less like a pure orchestration runtime and more like an edge-native application substrate for realtime AI systems.
**TORQUE relevance:** LOW - AI Gateway is useful as a reference for provider routing and observability, but it is not the core thing TORQUE should borrow from this project. The more important lesson is the packaging: Cloudflare combines durable execution, networking, and AI control in one deploy target.

## Verdict
Cloudflare Agents is most distinctive when viewed as a Durable Objects-first framework, not as another generic durable workflow engine. The standout ideas are one Durable Object per agent, durable local timers, hibernating WebSockets, and embedded per-agent SQL at the edge. For TORQUE, the most portable concepts are the scheduling model and the live interactive control plane; the broader architecture only becomes compelling if TORQUE ever wants edge-hosted, per-entity stateful runtimes.
