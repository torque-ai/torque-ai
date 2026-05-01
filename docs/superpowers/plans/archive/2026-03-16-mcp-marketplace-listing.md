# TORQUE MCP Marketplace Listing Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** List TORQUE on all major MCP marketplaces and registries to maximize discovery. All listings are free — monetization happens only through TORQUE Cloud (hosted SaaS), not at the MCP level.

**Architecture:** TORQUE is already an MCP server. Listing requires creating accounts and writing marketplace-specific metadata. No hosted/monetized MCP server setup needed.

**Depends on:** Plugin packaging plan (`.claude-plugin/plugin.json`, skills, README) should be complete first — the marketplace listings reference the same metadata.

**Monetization update (2026-03-17):** Per strategy decision, all MCP/plugin listings are free. No MCPize per-use billing, no MCP Hive pay-per-request. Revenue comes only from TORQUE Cloud.

---

## Marketplace Landscape

| Platform | Type | Monetization | Status | Priority |
|----------|------|-------------|--------|----------|
| **Claude Code Official** | Plugin marketplace | Free | Live | High — biggest audience |
| **MCPize** | Hosted marketplace | Free listing (no billing) | Live | Medium — discovery only |
| **MCP Hive** | Marketplace | Free listing | Launching May 11, 2026 | Medium — founding provider visibility |
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

## Chunk 3: MCPize — Free Listing (Discovery Only)

> **Updated 2026-03-17:** Per monetization strategy decision, MCPize listing is free — no per-use billing, no pricing tiers. Revenue comes only from TORQUE Cloud.

### Task 6: List on MCPize

- [ ] **Step 1: Sign up at mcpize.com**

Create a developer account. List TORQUE as a free, open-source MCP server.

- [ ] **Step 2: Create listing**

Title: TORQUE — AI Task Orchestration
Description: Multi-provider task orchestration with DAG workflows, quality gates, and distributed execution. Free and open source.
Link to: `https://github.com/torque-ai/torque-ai`
Pricing: Free (self-hosted)

---

## Chunk 4: MCP Hive — Founding Provider (Free Listing)

MCP Hive launches May 11, 2026. Applying as a founding provider gets visibility and influence over platform policies.

> **Updated 2026-03-17:** No pay-per-use billing. Apply for founding provider status for visibility and community influence only.

### Task 7: Apply as founding provider

- [ ] **Step 1: Visit mcp-hive.com and apply for Project Ignite**

Apply for founding provider status (first 100 providers):
- Server name: TORQUE
- Category: Development / Orchestration
- Description: Full AI task orchestration — multi-provider routing, DAG workflows, quality gates
- Pricing model: Free (open source, self-hosted)
- Note: Mention TORQUE Cloud as a future hosted option

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
| MCPize | Update listing manually (if needed) |
| MCP Hive | Update listing manually (if needed) |
| npm | `npm publish` bumped version |

- [ ] **Step 2: Add version sync check to release process**

Before any release, verify all marketplace listings reference the same version:
- plugin.json version
- marketplace.json version
- package.json version
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

| Chunk | Tasks | Effort |
|-------|-------|--------|
| 1: Free directories (Smithery, MCP Market, mcpservers) | Tasks 1-4 | 1-2 hours |
| 2: Claude Code Official | Task 5 | 30 min + review wait |
| 3: MCPize (free listing) | Task 6 | 30 min |
| 4: MCP Hive (founding provider) | Task 7 | 30 min |
| 5: Maintenance | Task 8 | 1 hour setup |

**Total: ~half a day.** All listings are free. No monetized hosting setup needed.

**Adoption funnel (all free):**

```
Discovery (directories)
  → Smithery, MCP Market, mcpservers.org, MCPize, MCP Hive
  → Link to GitHub repo

Adoption (plugin)
  → Claude Code Official marketplace
  → /plugin install torque — zero friction
  → All 500+ tools, unlimited, free

Revenue (cloud — future)
  → TORQUE Cloud (hosted SaaS)
  → $9/mo Pro for managed infrastructure
  → Only monetization point in the entire ecosystem
```
