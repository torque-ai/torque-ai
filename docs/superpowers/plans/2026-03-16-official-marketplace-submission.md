# TORQUE — Official Anthropic Marketplace Submission Plan

**Date:** 2026-03-16
**Status:** Pre-submission preparation
**Goal:** Get TORQUE listed in the official `claude-plugins-official` marketplace so users can discover and install it via the `/plugin` Discover tab.

---

## Submission URLs

- `https://claude.ai/settings/plugins/submit`
- `https://platform.claude.com/plugins/submit`

Fill in:
- Plugin name: `torque`
- Repository: `https://github.com/torque-ai/torque-ai`
- Description: AI task orchestration with multi-provider routing, DAG workflows, and quality gates
- Category: Development

---

## Pre-Submission Checklist

### Plugin Files (ALL DONE)

- [x] `.claude-plugin/plugin.json` — name, version, description, author, mcpServers config
- [x] `.claude-plugin/marketplace.json` — self-hosted marketplace catalog
- [x] `skills/` — 8 skills converted from commands (torque-submit, status, review, workflow, budget, config, cancel, restart)
- [x] `README.md` — plugin install as primary method, Superpowers companion, features, providers
- [x] `CLAUDE.md` — project instructions for Claude Code
- [x] `LICENSE` — BSL-1.1
- [x] `.claude/commands/` — preserved for backward compatibility

### Testing (TODO — requires interactive sessions)

- [ ] **Validate marketplace** — run `claude plugin validate .` from `torque-public/` directory
  - Expected: no errors
  - If errors: fix and re-validate before continuing

- [ ] **Test local plugin loading** — run `claude --plugin-dir .` from `torque-public/`
  - Verify: MCP server starts (look for "TORQUE" in server output)
  - Verify: all 8 skills appear (run `/torque:torque-submit` etc.)
  - Verify: `ping` tool responds
  - Verify: `submit_task` tool is available

- [ ] **Test marketplace install from local path**
  - Open Claude Code in a DIFFERENT directory (not torque-public)
  - Run: `/plugin marketplace add /path/to/torque-public`
  - Run: `/plugin install torque@torque-ai`
  - Verify: plugin installs, MCP server starts, skills work

- [ ] **Push to GitHub and test remote install**
  - Push all plugin packaging commits to `github.com/torque-ai/torque-ai`
  - Open Claude Code in a fresh directory
  - Run: `/plugin marketplace add torque-ai/torque-ai`
  - Run: `/plugin install torque@torque-ai`
  - Verify: installs from GitHub, MCP server starts, all tools available

### Security (MOSTLY DONE — verify + document)

- [x] Security audit completed (2026-03-14): 3 CRITICAL + 5 HIGH vulnerabilities fixed
  - C1: Env var injection — `process.env` spread no longer leaks API keys to child processes
  - C2: V2 auth defaults to strict — config/webhooks/policies require auth
  - C3: Context stuffing no longer sends .env files to cloud APIs
  - H1: Double-encoding path traversal blocked
  - H2: Error output stored redacted
  - H3: Dashboard WS broadcasts redacted
  - H4: SSRF IPv6 bypass blocked
  - H5: Per-tool auth available
  - H6: Webhook encryption added

- [ ] **Run `npm audit`** in `server/` directory
  - Fix any high/critical vulnerabilities
  - Document known low-severity issues with justification if unfixable

- [ ] **Write PRIVACY.md** — brief privacy statement covering:
  - TORQUE runs entirely locally, no telemetry, no phone-home
  - No data sent to TORQUE AI (no backend exists)
  - Provider API calls go directly to user-configured providers
  - BYOK: user's API keys stay on their machine
  - SQLite database is local only
  - Dashboard is local only (localhost:3456)

- [ ] **Write SECURITY.md** — security summary covering:
  - Threat model: TORQUE spawns child processes and makes network calls
  - What's sandboxed and what isn't
  - How API keys are handled (in-memory only, not logged, not transmitted)
  - The security audit scope and results (3C + 5H fixed)
  - How to report vulnerabilities (security@torque-ai or GitHub security advisories)

### Personal Data Scrub (VERIFY)

- [ ] **Run personal data grep** — verify no personal identifiers shipped:
  ```bash
  grep -ri "192\.168\.1\.183\|192\.168\.1\.17\|BahumutsOmen\|Werem\|Kenten\|bahumut" \
    server/ skills/ .claude-plugin/ CLAUDE.md README.md
  ```
  Expected: no matches

### Quality (VERIFY)

- [ ] **Run test suite** to confirm tests pass:
  ```bash
  ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx vitest run"
  ```
  Expected: 15K+ tests pass, no new failures

- [ ] **Run ESLint** — confirm zero errors:
  ```bash
  ssh kenten@192.168.1.183 "cd C:\Users\Kenten\Projects\Torque && npx eslint server/"
  ```

---

## Anthropic Review — Anticipated Concerns & Responses

### Concern 1: Child Process Spawning

**What they'll ask:** TORQUE spawns external processes (Codex CLI, Claude CLI, shell commands). Is this safe?

**Response:**
- Child processes are spawned only when the user explicitly submits a task — never automatically
- `verify_command` is user-configured and runs in the user's own project directory
- Env vars are sanitized before passing to child processes (C1 fix — no API key leakage)
- All process execution is logged and auditable via the audit pipeline
- The progressive tier system starts with 29 core tools — dangerous tools require explicit unlock

### Concern 2: Network Calls

**What they'll ask:** TORQUE makes HTTP calls to external services. What's the scope?

**Response:**
- Ollama hosts on the user's LAN (user-configured, health-checked)
- Cloud provider APIs (DeepInfra, Anthropic, Groq, etc.) — BYOK, user provides keys
- No calls to TORQUE AI servers (no backend exists)
- SSRF protections in place (H4 fix — IPv6 bypass blocked, private IP validation)
- All network calls are logged

### Concern 3: 500+ Tools Surface Area

**What they'll ask:** That's a lot of tools. How is access controlled?

**Response:**
- Progressive tier unlock: users start with 29 core tools (Tier 1)
- Tier 2 (80 tools) and Tier 3 (500+) require explicit unlock via `unlock_tier`
- This is a deliberate design choice to minimize context usage and prevent overwhelming new users
- Per-tool authorization is available (H5 fix)

### Concern 4: BSL-1.1 License

**What they'll ask:** Most plugins are MIT/Apache. Why BSL?

**Response:**
- BSL-1.1 is free for ALL use — individual, commercial, enterprise
- Only restriction: cannot offer TORQUE as a competing commercial hosted service
- Converts to Apache 2.0 after 3 years (automatic)
- This is the same license used by MariaDB, CockroachDB, Sentry, and other major open source projects

### Concern 5: Data/Privacy

**What they'll ask:** What data does the plugin access or store?

**Response:**
- All data stays local (SQLite on the user's machine)
- No telemetry, no analytics, no phone-home
- Provider API keys are held in memory only, never written to disk unencrypted
- Task outputs and code content never leave the user's machine
- See PRIVACY.md for full statement

---

## Files to Create Before Submission

### PRIVACY.md

```markdown
# Privacy

TORQUE runs entirely on your machine. No data is transmitted to TORQUE AI or any third party.

## What stays local
- All task data (submissions, outputs, results) — stored in local SQLite
- Your provider API keys — held in memory, never logged or transmitted
- Your code and project files — never uploaded
- Dashboard data — served from localhost only

## External connections TORQUE makes
- **Ollama hosts** — machines YOU registered on your local network
- **Cloud LLM providers** — APIs YOU configured with YOUR API keys (DeepInfra, Anthropic, Groq, etc.)
- **No telemetry** — TORQUE does not phone home, collect analytics, or track usage

## BYOK (Bring Your Own Keys)
Your API keys are your responsibility. TORQUE uses them to make API calls on your behalf and does not store, share, or transmit them beyond the direct provider API call.
```

### SECURITY.md

```markdown
# Security

## Reporting Vulnerabilities

Please report security vulnerabilities via GitHub Security Advisories on this repository. Do not open public issues for security concerns.

## Threat Model

TORQUE is an MCP server that orchestrates AI task execution. It:
- Spawns child processes (Codex CLI, Claude CLI, shell commands) on the user's behalf
- Makes HTTP calls to user-configured LLM providers and Ollama hosts
- Stores task data in a local SQLite database

### What's protected
- **API key isolation** — env vars are sanitized before passing to child processes (prevents key leakage)
- **Path traversal** — file paths are validated against traversal attacks
- **SSRF** — private IP and IPv6 bypass protections on outbound requests
- **Output redaction** — sensitive data is redacted from logs and dashboard
- **Auth** — V2 API defaults to strict authentication
- **Webhook encryption** — webhook payloads are encrypted at rest

### Security audit
A comprehensive security audit was completed on 2026-03-14:
- **3 CRITICAL** vulnerabilities identified and fixed
- **5 HIGH** vulnerabilities identified and fixed
- **16 MEDIUM** and **3 LOW** vulnerabilities identified and fixed
- All fixes are included in the current release

### Progressive tool access
Users start with 29 core tools. Advanced tools (500+) require explicit unlock, reducing the attack surface for new installations.
```

---

## Submission Steps (in order)

1. [ ] Create PRIVACY.md in repo root
2. [ ] Create SECURITY.md in repo root
3. [ ] Run `npm audit` and fix any high/critical issues
4. [ ] Run personal data grep — verify clean
5. [ ] Run test suite — confirm passing
6. [ ] Run ESLint — confirm zero errors
7. [ ] Validate marketplace — `claude plugin validate .`
8. [ ] Test local plugin — `claude --plugin-dir .`
9. [ ] Push to GitHub
10. [ ] Test remote install — `/plugin marketplace add torque-ai/torque-ai`
11. [ ] Submit via `claude.ai/settings/plugins/submit`
12. [ ] Monitor for review feedback — respond promptly

---

## After Approval

- TORQUE appears in the `/plugin` Discover tab for all Claude Code users
- Self-hosted marketplace remains active as a backup distribution channel
- Monitor GitHub issues for plugin-specific problems
- Keep plugin.json version in sync with server releases
