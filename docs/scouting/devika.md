# Findings: Devika

**Tagline:** Open-source autonomous software engineer built around a planner -> researcher -> coder loop.
**Stars:** 19.5k (GitHub, 2026-04-11)
**Language:** Python

## Feature 1: Planner -> Researcher -> Coder Loop
**What it does:** Devika's main execution path takes a high-level prompt, generates a step-by-step plan, extracts search queries, browses and formats external context, and then hands that bundle to a coder agent that writes files into the project directory. Follow-up prompts go through a second action router that can answer questions, run code, patch bugs, add features, deploy, or generate a report.
**Why distinctive:** The system is explicitly staged instead of collapsing everything into one generic agent loop. That separation makes research a first-class phase and gives the UI something concrete to expose while work is in progress.
**TORQUE relevance:** HIGH - This is close to a software-factory control loop: decompose work, gather outside context, then execute a concrete production step. TORQUE could borrow the explicit pre-code research phase and the specialized follow-up actions, but enforce them with stronger typed task contracts than Devika's prompt parsing.

## Feature 2: Prompt-Structured Multi-Step Planning Model
**What it does:** The planner emits a structured textual artifact with a project name, human reply, current focus, numbered plan steps, and a summary. Devika parses that plan into a step dictionary and also harvests the focus string as contextual keywords for the research pass.
**Why distinctive:** This is not a hidden chain-of-thought; it is an operator-visible planning object that feeds later stages. The model is lightweight and easy to understand, but it is still fundamentally a prompt contract rather than a strongly typed workflow graph.
**TORQUE relevance:** HIGH - TORQUE already thinks in persisted workflows and DAGs, so Devika is a useful example of how much value comes from simply making the plan explicit and reusable. The main lesson is to keep the visibility and continuity while upgrading the contract from text sections to durable node/state objects.

## Feature 3: Browser-Driven Research Pass
**What it does:** Devika turns the plan plus contextual keywords into search queries, calls Bing, Google, or DuckDuckGo, opens result pages in a Playwright-backed browser, captures screenshots, extracts page text, and runs a formatter before passing research back into code generation. The architecture docs also describe a separate browser-interaction loop where an LLM chooses click, type, and scroll actions against a live page to pursue an objective.
**Why distinctive:** Research is treated as active acquisition, not just retrieval from an embedding store or a single search API response. Even in its early form, the system couples search, page visitation, content extraction, and UI-visible browser state into one workflow.
**TORQUE relevance:** HIGH - For software-factory work, external research is often the missing stage between intake and implementation. TORQUE could use a similar research worker pattern for docs lookups, vendor pages, and runtime UIs, while avoiding Devika's simpler "take the first link and crawl it" approach when higher-confidence synthesis is needed.

## Feature 4: Persistent Project and Agent State
**What it does:** Devika stores project conversation history and agent state in SQLite via SQLModel, with JSON stacks for messages and state transitions. The persisted state includes current step, internal monologue, browser session, terminal session, token usage, completion flags, and timestamps.
**Why distinctive:** Persistence is not limited to final code output; the project record and the agent's evolving work log are both durable. That gives Devika a lightweight pause, resume, audit, and debugging story without needing a separate orchestration service.
**TORQUE relevance:** HIGH - This maps directly onto TORQUE's need for durable workflow and task state, operator auditability, and recovery after interruptions. Devika's model is simpler than an event journal, but the per-project state log is a strong pattern for capturing tool context that today often disappears between steps.

## Feature 5: Built-In Dashboard and Operator Surface
**What it does:** Devika ships a SvelteKit UI with a control panel for selecting projects, search engines, and models, while the Flask and Socket.IO backend exposes live messages, agent state, browser session, terminal session, token usage, logs, and settings endpoints. The README and server API make the web dashboard the main place to watch the agent work and steer it with follow-up prompts.
**Why distinctive:** The UI is not an afterthought bolted onto a CLI agent. It is the operator surface for both configuration and observability, which makes the agent feel more like a managed workstation than a one-shot prompt runner.
**TORQUE relevance:** MEDIUM - TORQUE already has a control plane, so the lesson here is less about raw capability and more about presentation. Devika shows the value of surfacing live browser and terminal context plus token burn directly in the dashboard when the system is acting autonomously.

## Verdict
Devika's strongest idea for TORQUE is the explicit plan -> research -> code loop backed by persistent per-project state and a live dashboard. The project is still openly experimental, and the planning model is mostly enforced by prompt shape and text parsing rather than typed runtime contracts, but the architecture makes the right stages visible. For a software-factory use case, the main takeaway is not to copy the implementation literally; it is to port the staged research and planning workflow and pair it with stronger orchestration guarantees than Devika currently has.
