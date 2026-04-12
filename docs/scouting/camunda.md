# Findings: Camunda 8

**Tagline:** BPMN-native orchestration for business processes, events, and human work.
**Stars:** 4.1k (GitHub, 2026-04-11)
**Language:** Java (85.4%)

## Feature 1: Executable BPMN With Parallel Gateways
**What it does:** Camunda 8 uses BPMN 2.0 as the executable workflow definition, so the process diagram is the runtime contract rather than a documentation artifact. That includes first-class gateway semantics such as parallel gateways, where one token splits into concurrent paths and later joins only after each incoming path is taken.
**Why distinctive:** This is the visual-modeling tradition in full, not just a DAG drawn after the fact. Camunda is optimized around business-readable constructs like tasks, events, gateways, scopes, and subprocesses, which gives it richer control-flow semantics than a typical code-first orchestrator.
**TORQUE relevance:** MEDIUM - TORQUE is currently a Node.js DAG orchestrator, so adopting BPMN wholesale would be a large product and UX shift. The useful takeaway is the semantic richness: explicit forks, joins, scopes, and wait states are clearer and more portable than ad hoc branching logic embedded in task handlers.

## Feature 2: Message Correlation As A First-Class Runtime Primitive
**What it does:** Camunda models message events directly in BPMN and then exposes runtime APIs to publish or correlate messages against waiting subscriptions. Message events are intentionally 1:1, and the REST `correlate message` endpoint is strongly consistent and non-buffered, while the separate publish flow supports buffered delivery.
**Why distinctive:** Many orchestrators can "wait for an event," but Camunda makes message waiting part of the workflow language and deployment model. Message start events create subscriptions at deploy time, and correlation is treated as an explicit engine capability rather than an application-level convention.
**TORQUE relevance:** HIGH - TORQUE would benefit from a cleaner external-event wakeup model for paused workflows and long-running tasks. The strongest idea to borrow is the split between durable buffered messages and immediate correlation to a specific waiter, instead of treating every incoming event the same way.

## Feature 3: Timer And Signal Events For Time And Broadcast Semantics
**What it does:** Timer events let a process start on a schedule, pause until a duration or date, or attach interrupting and non-interrupting deadlines and reminders to an activity. Signal events complement that by broadcasting to all matching listeners, including across different processes, which makes them a 1:N coordination primitive instead of message correlation's 1:1 delivery.
**Why distinctive:** Camunda does not bolt schedules and broadcasts on as side APIs; they live in the same BPMN event model as the rest of the process. That means deadlines, recurring reminders, and multi-listener notifications are visible in the diagram and share the same scope and continuation semantics as other BPMN elements.
**TORQUE relevance:** HIGH - TORQUE already has schedules and workflow waiting, but Camunda's distinction between timer, message, and broadcast signal semantics is sharper. A richer wait model would make timeout handling, reminders, and one-to-many operator or system notifications less ad hoc in TORQUE workflows.

## Feature 4: Scoped Error Boundary Events And Business Reactions
**What it does:** Camunda lets tasks or workers throw BPMN errors that are caught by boundary error events or error event subprocesses in the nearest matching scope. If no matching catcher exists, Zeebe raises an incident, while ordinary technical failures are typically handled through retries and incident mechanics instead of cluttering the diagram.
**Why distinctive:** The engine separates modeled business reactions from generic execution failure handling. That gives process authors a way to show meaningful exception paths visually without forcing every transient infrastructure problem into the workflow model.
**TORQUE relevance:** HIGH - TORQUE currently treats many failures as status transitions on tasks and workflows, but it has a weaker notion of scope-specific business exceptions. Camunda's model suggests a better split between "retry/incident" runtime faults and deliberate workflow branches for operator-visible business conditions.

## Feature 5: User Tasks With Tasklist And Form Binding
**What it does:** When a process reaches a user task, Zeebe creates a user task instance and waits for completion, while Tasklist provides the ready-made human work UI. User tasks can carry assignees, candidate users or groups, due dates, priorities, and a form reference, with Camunda Forms supporting binding modes like `latest`, `deployment`, and `versionTag`.
**Why distinctive:** Human work is not an afterthought layered next to the engine; it is part of the same process model, runtime, and tooling stack. Camunda also keeps the form story flexible by supporting Tasklist-rendered Camunda Forms, custom form references, and custom applications on top of the orchestration APIs.
**TORQUE relevance:** MEDIUM - TORQUE does not currently center human workflow or form-driven task completion, so the full Tasklist model is beyond its present scope. Still, approval steps, operator interventions, and review workflows would benefit from a first-class user-task abstraction instead of being simulated with generic blocked tasks and comments.

## Verdict
Camunda 8 is most distinctive where BPMN semantics are the product: gateways, events, scoped error handling, and human tasks are all native runtime concepts instead of helper APIs around a code-defined workflow. For TORQUE, the best ideas to borrow are not the whole visual-modeling stack, but the sharper wait semantics, scope-aware exception handling, and a more explicit human-task layer. The main mismatch is philosophical: Camunda is optimized for business-readable process models, while TORQUE is optimized for developer-authored DAG workflows.
