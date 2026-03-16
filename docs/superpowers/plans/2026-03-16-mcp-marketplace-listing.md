# TORQUE MCP Marketplace Listing Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List TORQUE on all major MCP marketplaces and registries to maximize discovery and open the monetization funnel. This is the middle layer between the free Claude Code plugin (adoption) and TORQUE Cloud (full SaaS).

**Architecture:** TORQUE is already an MCP server. Listing requires creating accounts, writing marketplace-specific metadata, and for monetized platforms (MCPize), configuring a hosted version with pricing tiers.

**Depends on:** Plugin packaging plan (`.claude-plugin/plugin.json`, skills, README) should be complete first — the marketplace listings reference the same metadata.

---

## Marketplace Landscape

| Platform | Type | Monetization | Status | Priority |
|----------|------|-------------|--------|----------|
| **Claude Code Official** | Plugin marketplace | No (free listings) | Live | High — biggest audience |
| **MCPize** | Hosted + monetized marketplace | 85% revenue share | Live | High — only monetized platform |
| **MCP Hive** | Pay-per-use marketplace | Creator sets pricing | Launching May 11, 2026 | Medium — apply as founding provider |
| **Smithery** | Registry / discovery | No (directory) | Live | Medium — SEO + discovery |
| **MCP Market** | Directory | No (directory) | Live | Low — listing for visibility |
| **mcpservers.org** | Curated directory | No (directory) | Live | Low — listing for visibility |
| **Apify** | Hosted MCP store | Revenue share | Live | Low — more for scraping/data tools |

---

## Chunk 1: Free Directory Listings (Discovery)

These are quick submissions that get TORQUE visible in search results and directories. No hosting required — they link to the GitHub repo.

### Task 1: Submit to Smithery

**Files:** None (web submission)

- [ ] **Step 1: Publish via Smithery CLI**

```bash
npm install -g @anthropics/smithery-cli
smithery mcp publish https://github.com/torque-ai/torque-ai -n torque-ai/torque
```

Or submit via the web interface at smithery.ai.

- [ ] **Step 2: Verify listing**

Search for "torque" on smithery.ai. Verify description, repo link, and tool count are correct.

- [ ] **Step 3: Optimize the listing**

Smithery pulls metadata from the repo. Ensure the repo has:
- Clear README with feature list (from plugin packaging plan)
- `package.json` with proper `name`, `description`, `keywords`
- Working MCP server that responds to `tools/list`

### Task 2: Submit to MCP Market

**Files:** None (web submission)

- [ ] **Step 1: Submit at mcpmarket.com**

Visit mcpmarket.com and submit TORQUE:
- Name: TORQUE
- URL: https://github.com/torque-ai/torque-ai
- Description: AI task orchestration — multi-provider routing, DAG workflows, quality gates, distributed execution across Codex, Claude, Ollama, DeepInfra, and more
- Category: Development / Orchestration
- Tags: orchestration, tasks, workflows, llm, multi-provider, codex, ollama

- [ ] **Step 2: Verify listing appears**

### Task 3: Submit to mcpservers.org

**Files:** None (web submission)

- [ ] **Step 1: Submit at mcpservers.org/submit**

Same metadata as Task 2.

- [ ] **Step 2: Verify listing**

### Task 4: Commit any repo changes needed for listings

If any listing platform requires specific files (e.g., a `server.json` or metadata file), add them.

```bash
git add -A
git commit -m "chore: add marketplace metadata for MCP directory listings"
```

---

## Chunk 2: Claude Code Official Marketplace

Already covered in the plugin packaging plan (`2026-03-16-plugin-packaging.md`, Task 7). This chunk tracks the submission as a dependency.

### Task 5: Submit to Claude Code Official Marketplace

- [ ] **Step 1: Verify plugin packaging is complete**

All tasks from the plugin packaging plan (Chunks 1-3) must be done:
- `.claude-plugin/plugin.json` with MCP server config
- 8 skills in `skills/` directory
- README with install instructions
- Superpowers companion recommendation

- [ ] **Step 2: Submit via official form**

Go to: `https://claude.ai/settings/plugins/submit` or `https://platform.claude.com/plugins/submit`

Fill in:
- Plugin name: `torque`
- Repository: `https://github.com/torque-ai/torque-ai`
- Description: AI task orchestration with multi-provider routing, DAG workflows, and 30+ quality safeguards
- Category: Development

- [ ] **Step 3: Monitor review and respond to feedback**

Track the review status. Be prepared to:
- Explain the child process spawning (for Codex/Ollama providers)
- Reference the security audit (3 critical + 5 high fixes already applied)
- Demonstrate the progressive tier unlock (starts with 29 safe tools)

---

## Chunk 3: MCPize — Monetized Hosted Listing

This is the monetization play. MCPize hosts your MCP server and handles billing. Users connect to the hosted endpoint and pay per use or subscribe.

### Task 6: Set up MCPize developer account

- [ ] **Step 1: Sign up at mcpize.com**

Create a developer account. Connect Stripe for payouts (85% revenue share).

- [ ] **Step 2: Review MCPize's hosting model**

MCPize hosts the MCP server in their cloud. This means:
- TORQUE runs on MCPize infrastructure, not yours
- Users connect via MCPize's MCP endpoint URL
- MCPize handles SSL, scaling, and payments
- You deploy via `mcpize deploy` CLI

**Key constraint for TORQUE:** The MCPize-hosted version can only use cloud providers (DeepInfra, Anthropic, Groq, Hyperbolic) since there's no local agent connection. Users bring their own API keys for these providers. Local providers (Ollama, Codex CLI, Claude CLI) are NOT available in the hosted version — they require the full self-hosted install or TORQUE Cloud with agent.

### Task 7: Configure TORQUE for MCPize hosting

**Files:**
- Create: `mcpize.config.json` (or equivalent MCPize config)

- [ ] **Step 1: Initialize MCPize project**

```bash
npm install -g mcpize
mcpize init torque --template node
```

Or manually create the MCPize configuration.

- [ ] **Step 2: Configure the hosted server**

The hosted TORQUE instance needs:
- Cloud-only provider support (disable Ollama/Codex/Claude CLI providers)
- BYOK key injection via MCPize's env var system
- Reduced tool set for the hosted experience (Tier 1 core tools by default)
- Clear messaging that local providers require self-hosted install

Create a hosting-specific configuration or startup flag:

```bash
# Start TORQUE in cloud-only mode (no local providers)
TORQUE_MODE=cloud-hosted node server/index.js
```

The server already supports provider enable/disable. The cloud-hosted mode:
- Disables: ollama, hashline-ollama, aider-ollama (require local Ollama)
- Disables: codex, claude-cli (require local CLI subscriptions)
- Enables: deepinfra, hyperbolic, anthropic, groq (cloud API providers)
- Starts with Tier 1 tools (29 core tools)

- [ ] **Step 3: Define pricing model**

Configure in MCPize dashboard:

| Tier | Price | Includes |
|------|-------|---------|
| **Free** | $0 | 50 tool calls/day, Tier 1 tools only, 1 provider |
| **Pro** | $9/mo | Unlimited tool calls, all tiers, unlimited providers |

This mirrors the TORQUE Cloud pricing for consistency. The free tier is generous enough to try TORQUE (50 calls = several task submissions + status checks + reviews), restrictive enough to convert.

- [ ] **Step 4: Deploy to MCPize**

```bash
mcpize deploy
```

Verify the hosted endpoint works:
- Connect from Claude Code using the MCPize-provided MCP URL
- Submit a task using a cloud provider
- Verify tool calls are metered correctly

- [ ] **Step 5: Write the MCPize listing page**

Create compelling marketplace listing:

**Title:** TORQUE — AI Task Orchestration

**Tagline:** Delegate work to multiple LLMs in parallel. Smart routing, workflows, quality gates.

**Description:**
TORQUE is a full orchestration platform for AI-assisted development. Submit tasks, and TORQUE routes them to the best available provider — DeepInfra for batch work, Anthropic for architecture, Groq for speed. Chain tasks into DAG workflows with automatic dependency resolution. 30+ quality safeguards catch stub implementations, truncated outputs, and regressions before they reach your codebase.

**Features list:**
- Smart complexity-based provider routing
- DAG workflow engine with parallel execution
- 30+ quality safeguards (baselines, validation, approval gates)
- Progressive tool unlock (29 core → 500+ full)
- Real-time task status and notifications
- Auto-retry with provider fallback

**Use cases:**
- Delegate code generation to cloud LLMs while you keep working
- Run test generation across multiple providers simultaneously
- Create multi-step feature workflows (types → data → system → tests)
- Cost-optimize by routing simple tasks to cheap providers

**Limitations (cloud-hosted):**
- Local providers (Ollama, Codex CLI, Claude CLI) require self-hosted install
- For local provider support + dashboard, see [TORQUE self-hosted](https://github.com/torque-ai/torque-ai)

- [ ] **Step 6: Commit any server changes**

```bash
git add -A
git commit -m "feat: add cloud-hosted mode for MCPize deployment"
```

### Task 8: Add upsell paths in the hosted experience

- [ ] **Step 1: Add upgrade messaging to tier-gated responses**

When a user hits a free tier limit on MCPize, the error response should include paths to upgrade:

```json
{
  "error": "tier_limit",
  "limit": "daily_tool_calls",
  "current": 50,
  "max": 50,
  "options": [
    { "action": "Upgrade to Pro on MCPize", "url": "<mcpize-upgrade-url>" },
    { "action": "Self-host for unlimited free usage", "url": "https://github.com/torque-ai/torque-ai" },
    { "action": "Try TORQUE Cloud (coming soon)", "url": "<torque-cloud-url>" }
  ]
}
```

- [ ] **Step 2: Commit**

```bash
git add -A
git commit -m "feat: add tiered upgrade messaging for hosted deployment"
```

---

## Chunk 4: MCP Hive — Founding Provider Application

MCP Hive launches May 11, 2026. Applying as a founding provider gets priority onboarding, zero platform fees, and influence over platform policies.

### Task 9: Apply as founding provider

- [ ] **Step 1: Visit mcp-hive.com and apply for Project Ignite**

Apply for founding provider status (first 100 providers):
- Server name: TORQUE
- Category: Development / Orchestration
- Description: Full AI task orchestration — multi-provider routing, DAG workflows, quality gates
- Pricing model: Pay-per-use (tool calls) with free tier

Benefits of founding provider:
- Priority onboarding support
- Influence over platform policies
- Zero platform fees (founding period)
- Extended trial for integration

- [ ] **Step 2: Prepare for MCP Hive's pay-per-use model**

MCP Hive uses a "AI apps pay per request, providers earn per response" model. Configure:

| Tool Category | Price per call |
|--------------|---------------|
| Task submission (submit_task, smart_submit_task) | $0.01 |
| Status/query (task_info, list_tasks, workflow_status) | $0.001 |
| Workflow creation (create_workflow, run_batch) | $0.02 |
| Await tools (await_task, await_workflow) | $0.005 |
| Configuration (set_project_defaults, etc.) | Free |
| Ping/meta | Free |

Pricing rationale: submission tools create real value (orchestrate LLM calls), query tools are low-cost reads, workflow tools are highest value (multi-step orchestration).

- [ ] **Step 3: Document pricing rationale for the application**

---

## Chunk 5: Ongoing Marketplace Maintenance

### Task 10: Create a marketplace maintenance checklist

- [ ] **Step 1: Document the update process for each platform**

When TORQUE ships a new version:

| Platform | Update Process |
|----------|---------------|
| Claude Code Official | Update plugin.json version, push to GitHub, marketplace auto-updates |
| Self-hosted marketplace | Update marketplace.json version, push to GitHub |
| Smithery | Re-publish via CLI: `smithery mcp publish` |
| MCP Market | Update listing manually (if needed) |
| mcpservers.org | Update listing manually (if needed) |
| MCPize | `mcpize deploy` to push new version |
| MCP Hive | Platform-specific update process (TBD after launch) |
| npm | `npm publish` bumped version |

- [ ] **Step 2: Add version sync check to release process**

Before any release, verify all marketplace listings reference the same version:
- plugin.json version
- marketplace.json version
- package.json version
- MCPize deployment version
- npm package version

Create a simple script or checklist:

```bash
# check-versions.sh
echo "plugin.json: $(jq -r .version .claude-plugin/plugin.json)"
echo "marketplace.json: $(jq -r '.plugins[0].version' .claude-plugin/marketplace.json)"
echo "package.json: $(jq -r .version package.json)"
echo "server/package.json: $(jq -r .version server/package.json)"
```

- [ ] **Step 3: Commit**

```bash
git add check-versions.sh
git commit -m "chore: add version sync check for marketplace releases"
```

---

## Summary

| Chunk | Tasks | Effort | Revenue |
|-------|-------|--------|---------|
| 1: Free directories (Smithery, MCP Market, mcpservers) | Tasks 1-4 | 1-2 hours | None (discovery) |
| 2: Claude Code Official | Task 5 | 30 min + review wait | None (adoption funnel) |
| 3: MCPize (monetized) | Tasks 6-8 | 1-2 days | 85% of subscriptions |
| 4: MCP Hive (founding provider) | Task 9 | 1-2 hours | Per-use revenue (post-May) |
| 5: Maintenance | Task 10 | 1 hour setup | Ongoing |

**Total: ~2-3 days** (Chunk 3 is the largest — requires cloud-hosted mode configuration).

**Monetization funnel after completion:**

```
Discovery (free directories)
  → Smithery, MCP Market, mcpservers.org find TORQUE
  → Link to GitHub repo

Adoption (free plugin)
  → Claude Code Official marketplace
  → /plugin install torque — zero friction
  → 29 core tools, works immediately

Try paid (MCPize hosted)
  → 50 free tool calls/day on hosted endpoint
  → $9/mo Pro for unlimited — 85% to us
  → Cloud providers only (DeepInfra, Anthropic, Groq)

Full experience (TORQUE Cloud — future)
  → Self-hosted server + local agent
  → All 10 providers including local Ollama, Codex, Claude
  → Dashboard, workflows, full orchestration
  → $9/mo Pro
```

Each layer funnels users toward higher engagement and revenue.
