# Competitive-Inspired Feature Roadmap

> Master index for all plans derived from the March 2026 competitive analysis.
> See `2026-03-21-competitive-analysis.md` for full research findings.

## Tier 1: High Impact, Moderate Effort

| # | Feature | Plan | Inspired By | Key Benefit |
|---|---------|------|-------------|-------------|
| 1 | Multi-Dimensional Provider Scoring | [tier1-provider-scoring.md](2026-03-21-tier1-provider-scoring.md) | CreedFlow | 4-axis scoring feeds routing decisions |
| 2 | Infrastructure Circuit Breaker | [tier1-circuit-breaker.md](2026-03-21-tier1-circuit-breaker.md) | agent-orchestrator, Gobby | Stop sending work to dead providers |
| 3 | Budget-Aware Routing Downgrade | [tier1-budget-routing.md](2026-03-21-tier1-budget-routing.md) | CreedFlow | Auto cost control at budget thresholds |
| 4 | Structured Resume Context | [tier1-resume-context.md](2026-03-21-tier1-resume-context.md) | agent-orchestrator, Gobby | Higher retry success rate |
| 5 | Verification Mutex | [tier1-verification-mutex.md](2026-03-21-tier1-verification-mutex.md) | agent-orchestrator | Prevent merge conflicts in parallel workflows |

## Tier 2: High Impact, Higher Effort

| # | Feature | Plan | Inspired By | Key Benefit |
|---|---------|------|-------------|-------------|
| 6 | AST Symbol Indexing | [tier2-symbol-indexing.md](2026-03-21-tier2-symbol-indexing.md) | Gobby | 90%+ token savings in context stuffing |
| 7 | Project Templates | [tier2-project-templates.md](2026-03-21-tier2-project-templates.md) | Goblin Forge | Framework-aware task prompts |
| 8 | Lazy Tool Schemas | [tier2-lazy-tool-schemas.md](2026-03-21-tier2-lazy-tool-schemas.md) | Gobby | Reduce MCP context overhead |
| 9 | Active Policy Effects | [tier2-active-policy-effects.md](2026-03-21-tier2-active-policy-effects.md) | Gobby | Policy engine triggers actions, not just blocks |

## Tier 3-4: Medium/Lower Priority

| # | Feature | Plan | Inspired By | Key Benefit |
|---|---------|------|-------------|-------------|
| 10 | CPU Activity Detection | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-10) | EnsoAI | Reduce false stall detections |
| 11 | Provider Comparison Tool | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-11) | CreedFlow | Empirical provider evaluation |
| 12 | Agent Auto-Discovery | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-12) | Goblin Forge | Reduce onboarding friction |
| 13 | TUI Dashboard | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-13) | Goblin Forge | Terminal-native monitoring |
| 14 | Streaming Code Review | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-14) | EnsoAI | AI-powered review pipeline |
| 15 | Batched Log Persistence | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-15) | CreedFlow | Reduce DB I/O |
| 16 | AI Branch Names | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-16) | EnsoAI | Better worktree naming |
| 17 | AI Task Polishing | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-17) | EnsoAI | Better task descriptions |
| 18 | Voice Control | [tier3-misc-features.md](2026-03-21-tier3-misc-features.md#feature-18) | Goblin Forge | Hands-free submission (experimental) |

## Recommended Implementation Order

**Phase 1 (immediate value):** 5 (verification mutex -- smallest, prevents active bugs), 3 (budget routing -- small, wires existing systems), 2 (circuit breaker -- prevents waste)

**Phase 2 (routing intelligence):** 1 (provider scoring -- foundational for smarter routing), 4 (resume context -- improves retry success)

**Phase 3 (context quality):** 7 (project templates -- quick win for free providers), 8 (lazy tool schemas -- reduces context overhead)

**Phase 4 (advanced):** 6 (symbol indexing -- biggest effort but biggest payoff), 9 (active policy effects -- extends policy engine)

**Phase 5 (polish):** 10-18 as time permits, cherry-pick based on user demand
