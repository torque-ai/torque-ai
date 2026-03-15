# Budget & Cost Management

TORQUE tracks token usage and costs across all providers, with budget limits, alerts, and forecasting.

## How Costs Work

| Provider | Cost Model |
|----------|-----------|
| Ollama (local) | Free — $0 per task |
| Claude CLI / Anthropic API | Per-token pricing (input + output) |
| Groq | Per-token pricing (very low) |
| Codex | Per-token pricing |

Local LLM tasks through Ollama are always free. Costs only accrue when using cloud providers.

## Viewing Costs

### Budget Status

```
get_budget_status {}
```

Returns:
- Current budget limit
- Total spent
- Remaining balance
- Percentage used
- Forecasted total for the period

### Cost Summary

```
get_cost_summary {}
get_cost_summary { days: 7 }
get_cost_summary { provider: "claude-cli" }
```

Breaks down costs by provider, showing token counts and total spend.

### Per-Task Usage

```
get_task_usage { task_id: "..." }
```

Shows token consumption for a specific task (input tokens, output tokens, cost).

### Slash Command

```
/torque-budget
```

Shows a combined overview of budget status, spending, and provider performance.

## Setting a Budget

```
set_budget {
  limit: 50.00,
  currency: "USD",
  period: "monthly"
}
```

| Parameter | Description | Default |
|-----------|-------------|---------|
| `limit` | Maximum spend in the period | None (unlimited) |
| `currency` | Currency code | `USD` |
| `period` | Budget period: `daily`, `weekly`, `monthly` | `monthly` |

## Budget Alerts

Get notified when spending reaches a threshold.

### Add an Alert

```
add_budget_alert {
  name: "80-percent-warning",
  threshold: 40.00,
  action: "notify"
}
```

| Action | Description |
|--------|-------------|
| `notify` | Log a warning |
| `pause-tasks` | Stop queuing new cloud tasks |
| `cancel-tasks` | Cancel running cloud tasks |
| `notify-slack` | Send Slack notification (requires integration) |

### List Alerts

```
list_budget_alerts {}
```

### Remove an Alert

```
remove_budget_alert { alert_id: "..." }
```

## Cost Estimation

Estimate cost before running a task:

```
estimate_cost {
  task_description: "Refactor the authentication module",
  provider: "claude-cli"
}
```

Returns estimated token count and cost based on task description length and provider pricing.

## Cost Forecasting

```
forecast_costs {}
forecast_costs { days: 30 }
```

Projects future spending based on historical patterns. Uses recent usage trends to estimate costs for the forecast period.

## Provider Cost Comparison

```
compare_performance {}
```

Shows cost, speed, and quality metrics for each provider side-by-side, helping you choose the most cost-effective provider.

## Rate Limiting

Control token consumption rate per provider.

### Set a Rate Limit

```
set_rate_limit {
  provider: "anthropic",
  max_value: 100,
  window_seconds: 60,
  limit_type: "requests",
  enabled: true
}
```

| Parameter | Description |
|-----------|-------------|
| `provider` | Provider to limit |
| `max_value` | Maximum count in the window |
| `window_seconds` | Time window |
| `limit_type` | `requests` or `tokens` |

### View Rate Limits

```
get_rate_limits {}
```

## Cost Optimization Tips

1. **Use smart routing** — TORQUE automatically sends simple tasks to free local LLMs
2. **Set a budget** — Prevent unexpected cloud costs with a monthly limit
3. **Monitor provider stats** — `provider_stats { provider: "claude-cli" }` shows cost per task
4. **Use alerts** — Set an 80% alert to get warned before hitting the limit
5. **Leverage caching** — `cache_task_result` avoids re-running identical tasks
6. **Reduce context** — Lower `num_ctx` for simple tasks to reduce token count
7. **Use smaller models** — Route documentation tasks to Ollama instead of Claude

## Tools Reference

| Tool | Description |
|------|-------------|
| `get_budget_status` | Budget status and spending |
| `set_budget` | Create or update budget |
| `get_cost_summary` | Cost breakdown by provider |
| `estimate_cost` | Pre-execution cost estimate |
| `forecast_costs` | Predict future costs |
| `add_budget_alert` | Set cost threshold alert |
| `list_budget_alerts` | List alerts |
| `remove_budget_alert` | Delete alert |
| `record_usage` | Record token usage |
| `get_task_usage` | Task usage history |
| `get_rate_limits` | Rate limit config |
| `set_rate_limit` | Set rate limit |
| `compare_performance` | Provider cost comparison |
