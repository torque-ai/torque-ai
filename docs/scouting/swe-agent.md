# Findings: SWE-agent

**Tagline:** Research-oriented software engineering agent that centers the agent-computer interface instead of treating tools as a generic shell wrapper.
**Stars:** 19k
**Language:** Python

## Feature 1: Syntax-gated editing
**What it does:** SWE-agent runs a linter whenever the agent issues an edit command and blocks the edit if the result is not syntactically valid. This turns syntax checking into an inline control in the action loop instead of a later cleanup step.
**Why distinctive:** Most agent systems rely on post hoc verification or retries after the model has already corrupted its working state. SWE-agent pushes the guardrail into the ACI itself, which is a sharper contract between the model and the environment.
**TORQUE relevance:** HIGH — TORQUE already has verify gates, but an edit-level syntax veto inside tool execution would reduce wasted retries, especially for codex/claude-cli/ollama runs that currently discover bad edits later in the task lifecycle.

## Feature 2: Windowed file viewing and terse repo search
**What it does:** Instead of raw `cat` and verbose grep output, SWE-agent gives the model a purpose-built file viewer with scrolling/search plus a full-directory search tool that returns only succinct match listings. The docs explicitly note that the viewer works best around 100 lines per turn and that showing too much match context hurts model performance.
**Why distinctive:** This is not just "better tooling"; it is an experimentally tuned context-throttling strategy for repository work. The interface is optimized for model cognition, not for human terminal convenience.
**TORQUE relevance:** HIGH — TORQUE's MCP/tool surface would benefit from repo-navigation tools designed for agent consumption, especially in long workflows where token discipline and clean intermediate observations matter.

## Feature 3: Tool bundles with a structured state command
**What it does:** SWE-agent packages tools as bundles with executables, config, install logic, and a `state` command that runs after every action to emit JSON such as the current working directory and open file. That state is then available for prompt templating and downstream control logic.
**Why distinctive:** The key idea is that tool output alone is not enough; the agent also gets a stable machine-readable snapshot after each step. That creates a tighter feedback loop than plain shell transcripts and makes tool extensions more modular.
**TORQUE relevance:** HIGH — TORQUE already has a high-fan-in tool and MCP layer, so a first-class post-tool state contract could improve dashboard visibility, smarter routing context, and provider-agnostic workflow checkpoints.

## Feature 4: Trajectory-first observability and replay
**What it does:** SWE-agent saves per-run trajectories containing response, thought, action, observation, state, exact query payloads, config, and logs. It also exposes CLI and web inspectors plus `run-replay` so a recorded trajectory or demo can be re-executed in the environment.
**Why distinctive:** Many automation systems preserve outputs and logs, but SWE-agent treats the entire action trace as a reusable artifact. That makes failures inspectable, regressions reproducible, and tool changes debuggable without reconstructing a run from scattered logs.
**TORQUE relevance:** HIGH — TORQUE has workflows, dashboarding, and multi-provider execution, so replayable task traces would be valuable for provider comparisons, stalled-task diagnosis, and verifying that workflow changes preserve behavior.

## Feature 5: Demonstrations distilled from successful trajectories
**What it does:** SWE-agent can convert a successful trajectory into an editable YAML demonstration, then replay it to validate that the example still works. It also supports `human_thought` mode for manually authoring example trajectories turn by turn.
**Why distinctive:** This is a lightweight improvement loop that turns real executions into reusable behavioral priors without retraining a model. The bridge from trace to demo is especially useful because it lets operators curate agent behavior in a concrete, inspectable format.
**TORQUE relevance:** MEDIUM — TORQUE could use this idea for workflow exemplars, provider-specific playbooks, or reusable repair traces, but it is less urgent than strengthening the live tool/state contract and replay/debug surfaces first.

## Verdict
The two features most worth porting into TORQUE are the ACI-style tool contract and the trajectory replay stack. First, TORQUE would benefit from purpose-built agent tools that enforce syntax validity, expose structured post-action state, and present repositories in a model-friendly way rather than as generic shell noise. Second, replayable trajectories would give TORQUE a much stronger debugging and governance story across providers, making it easier to compare executor behavior, investigate failures, and turn successful runs into reusable workflow knowledge.
