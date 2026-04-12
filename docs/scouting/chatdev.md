# ChatDev Scouting Report

**Source:** `OpenBMB/ChatDev`  
**Reviewed:** `2026-04-11`  
**Scope:** `main` README for current repo status, then legacy `chatdev1.0` README, `wiki.md`, `CompanyConfig/Default`, and `WareHouse` conventions for the original software-company waterfall.  
**Note:** On January 7, 2026, ChatDev moved its classic software-company system to the `chatdev1.0` branch and made ChatDev 2.0 the default branch. The feature analysis below is about the legacy multi-agent waterfall.

## Feature 1: Three-Layer CompanyConfig

**What it does:** ChatDev splits one "company" into three configuration layers: `ChatChainConfig.json` for phase order and loop controls, `PhaseConfig.json` for per-phase prompts and participants, and `RoleConfig.json` for agent identities and background prompts. This lets one workflow change process, seminar content, and personas independently.

**Why it's distinctive:** Many agent systems pack workflow, prompts, and roles into one spec. ChatDev's separation makes the organization model portable and easy to fork into variants like `Default`, `Art`, and `Human` without rewriting the whole stack.

**Relevance to TORQUE:** HIGH

## Feature 2: Waterfall with Bounded Repair Subloops

**What it does:** The legacy chain stays easy to read as a fixed software-delivery waterfall, but high-risk stages such as code review and testing can be declared as `ComposedPhase` loops with `cycleNum` limits and optional break conditions. That gives ChatDev an iterative repair mechanism inside an otherwise linear top-level flow.

**Why it's distinctive:** This is a useful middle ground between a rigid one-shot pipeline and a fully general graph engine. It preserves a manager-friendly "phase by phase" model while still allowing localized convergence loops where defects are most likely to appear.

**Relevance to TORQUE:** HIGH

## Feature 3: Built-In Reflection Passes

**What it does:** Individual phases can enable `need_reflect`, which triggers a follow-up refinement conversation after the main seminar. The wiki also notes that `Chief Executive Officer` and `Counselor` must exist so reflection can work consistently across custom companies.

**Why it's distinctive:** Reflection is not treated as vague prompting advice; it is a first-class workflow behavior with named roles and explicit placement in the chain. That makes post-step synthesis repeatable instead of depending on whether one agent happened to self-correct.

**Relevance to TORQUE:** MEDIUM

## Feature 4: Artifactized Run Folders in `WareHouse`

**What it does:** Every generated project is written to a dedicated `WareHouse/<name>_<org>_<timestamp>` folder containing the software files, manual, prompt, company configs, metadata, and a build log that can be replayed later. The visualizer can also render live logs, replay logs, and the ChatChain itself.

**Why it's distinctive:** ChatDev treats each run as a shareable evidence bundle, not just an execution that happened. That gives users a durable artifact with provenance, replay, and enough context to inspect how the virtual company arrived at the output.

**Relevance to TORQUE:** HIGH

## Feature 5: Workflow Overlays for Human, Git, Art, and Memory Modes

**What it does:** ChatDev layers optional behaviors onto the base workflow through config presets and flags: `Human` inserts reviewer interaction, `Art` adds an image-generation phase, `git_management` checkpoints major code-changing phases, `incremental_develop` works from an existing codebase, and `with_memory` pulls from an experience pool. Missing config files in a variant fall back to `Default`, so overlays stay lightweight.

**Why it's distinctive:** The important idea is not any one mode by itself, but that capability changes are packaged as thin workflow overlays instead of separate products. That keeps the core waterfall stable while enabling opinionated execution flavors for different risk and collaboration patterns.

**Relevance to TORQUE:** HIGH

## Verdict

ChatDev's legacy system is less dynamic than TORQUE's DAG runtime and multi-provider router, but it is strong at turning a multi-agent software process into something legible, configurable, and replayable. The best ideas for TORQUE are the clean split between workflow, phase, and persona config; bounded repair loops inside a simple top-level flow; and `WareHouse`-style per-run artifact bundles with optional human or policy overlays.
