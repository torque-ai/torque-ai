---
name: torque-budget
description: View TORQUE cost tracking, budget status, and provider statistics
allowed-tools:
  - mcp__torque__get_cost_summary
  - mcp__torque__get_budget_status
  - mcp__torque__set_budget
  - mcp__torque__get_rate_limits
  - mcp__torque__get_provider_stats
  - mcp__torque__get_provider_quality
  - AskUserQuestion
---

# TORQUE Budget

View cost tracking, budget status, rate limits, and provider performance.

## Instructions

1. Call these in parallel:
   - `get_cost_summary` — costs by provider
   - `get_budget_status` — current budget and usage
   - `get_rate_limits` — rate limit status
   - `get_provider_stats` — success rates by provider

2. Present as:

```
## TORQUE Budget & Performance

### Costs
| Provider | Tasks | Cost | Avg Cost/Task |
|----------|-------|------|---------------|
| Local LLM | X | FREE | $0.00 |
| Claude | X | $X.XX | $X.XX |
| Codex | X | $X.XX | $X.XX |

### Budget
**Used:** $X / $X limit | **Remaining:** $X
**Forecast:** On track / Over budget by [date]

### Rate Limits
[Current rate limit status per provider]

### Provider Quality
| Provider | Success Rate | Avg Quality | Avg Duration |
|----------|-------------|-------------|--------------|
[Per-provider stats]
```

3. If budget is >80% used, warn the user and suggest increasing local LLM usage.
4. If a provider has <70% success rate, flag it and suggest routing adjustments.

After writing, verify the file exists.