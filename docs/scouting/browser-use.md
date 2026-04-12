# Findings: Browser Use

**Tagline:** Browser-native agent framework that grounds web actions in structured page state instead of pure screenshots.
**Stars:** 87.4k (GitHub, 2026-04-12)
**Language:** Python (97.9%)

## Feature 1: Accessibility-Tree-First Page State
**What it does:** Browser Use builds browser state from more than a screenshot. In the open-source code, `browser_use/dom/service.py` collects a DOM snapshot plus `Accessibility.getFullAXTree` across frames, then maps interactive elements into an agent-usable state representation.  
**Why distinctive:** The important design choice is that the model is grounded in semantic browser structure first, not only pixels or raw CSS selectors. That gives the agent labeled, indexed elements and lets Browser Use prune noise with settings like `paint_order_filtering` instead of forcing the model to infer everything visually.  
**TORQUE relevance:** HIGH - TORQUE already has `peek_ui`, but Browser Use points to a more agent-native abstraction on top of browser control. An accessibility-aware element graph would make TORQUE browser tasks more reliable than OCR-heavy or coordinate-heavy control loops.

## Feature 2: Vision + DOM Hybrid Observation
**What it does:** Browser Use supports `use_vision` with an `"auto"` mode that includes screenshots only when needed, plus explicit screenshot requests for visual confirmation. It also supports `highlight_elements`, so the visual pass can line up with the same interactive elements the DOM pass exposes.  
**Why distinctive:** This is a hybrid observation model rather than a screenshot-only agent. The agent can stay on cheaper, more structured DOM state for most steps, then escalate to vision when layout, rendering, or ambiguous UI details actually matter.  
**TORQUE relevance:** HIGH - This is the clearest product insight for TORQUE. `peek_ui` already gives raw browser capture; Browser Use shows how to wrap that in a policy that prefers structure first and uses vision as a fallback, which is a better fit for LLM planning and cost control.

## Feature 3: Agent-Friendly Action Primitives
**What it does:** Browser Use exposes a compact action vocabulary such as `click`, `input`, `scroll`, `find_text`, `extract`, `switch`, and `close`, and its MCP server mirrors that with tools like `browser_click`, `browser_type`, `browser_get_state`, and `browser_extract_content`. The agent can also batch work with `max_actions_per_step`, which is useful for multi-field form filling.  
**Why distinctive:** This sits above raw Playwright calls. Instead of asking the model to author imperative browser scripts every step, Browser Use gives it stable, high-level browser verbs that already match common agent intentions like interact, inspect state, and extract content.  
**TORQUE relevance:** HIGH - TORQUE has low-level browser control today, but Browser Use is a better reference for agent-facing primitives. A small state/action/extract vocabulary would make TORQUE easier to drive from LLMs and easier to secure than exposing generic browser scripting as the default surface.

## Feature 4: Multi-Tab and Persistent Session Handling
**What it does:** Multi-tab browsing is first-class: built-in tools support `switch` and `close`, while the MCP server adds `browser_list_tabs`, `browser_switch_tab`, and `browser_close_tab`. Separate docs also show `keep_alive=True` and follow-up tasks that preserve browser state, cookies, local storage, and page context across chained runs.  
**Why distinctive:** A lot of browser-agent demos are effectively single-page or single-tab loops. Browser Use treats tab management and session continuity as core workflow concerns, which matches real browsing tasks like comparing pages, opening search results, or continuing a task after a handoff.  
**TORQUE relevance:** HIGH - This lines up with real operator workflows more than one-shot automation does. TORQUE could benefit from explicit tab/session objects for long-running browser tasks instead of treating each step as an isolated page interaction.

## Feature 5: Authenticated Browsing Through Real Profiles and Storage State
**What it does:** Browser Use can attach to an existing Chrome profile with `Browser.from_system_chrome()`, reuse active authenticated sessions, and export/import Playwright-format `storage_state` files for headless or CI runs. When a `storage_state` path is provided, it auto-loads cookies on startup and auto-saves updates on shutdown.  
**Why distinctive:** Authentication is treated as durable browser state, not as an afterthought bolted onto prompting. That makes logged-in automation practical for real systems, reduces repeated login flows, and provides a cleaner path for CI or remote execution than asking the model to handle auth fresh each run.  
**TORQUE relevance:** HIGH - This is directly relevant if TORQUE wants browser agents to work against internal dashboards or SaaS tools. Saved profiles and storage state are a more robust integration model than re-entering credentials, and they fit well with TORQUE’s existing browser tooling direction.

## Verdict
Browser Use is most interesting as an agent layer on top of browser automation, not as another scraping or research tool. Its standout ideas are the accessibility-aware page model, the DOM-plus-vision hybrid loop, and the decision to expose browser work as compact agent primitives rather than raw scripting. For TORQUE, the best takeaway is not "add another Playwright wrapper," but "add a structured browser-state contract that makes browser control legible to LLMs."
