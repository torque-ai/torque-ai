# Cloud Inference Notes

For open-weight cloud inference at scale, TORQUE ships two specialist providers using OpenAI-compatible APIs. Both start disabled until their API keys are configured.

| Provider | Env Var | Default Model | Concurrency | Pricing (per 1M tokens) |
|----------|---------|---------------|-------------|-------------------------|
| **deepinfra** | `DEEPINFRA_API_KEY` | `Qwen/Qwen2.5-72B-Instruct` | 200 per model | $0.13–$1.00 input |
| **hyperbolic** | `HYPERBOLIC_API_KEY` | `Qwen/Qwen2.5-72B-Instruct` | 120 req/min on Pro | $0.40–$4.00 input |

> Pricing is approximate and decays — check the provider dashboards for current rates before relying on the numbers here.

## When to pick which

- **deepinfra** — high-concurrency batch work. The 200-concurrent-per-model ceiling makes it the right choice when a workflow has many parallel large-model tasks.
- **hyperbolic** — when you specifically want larger Qwen variants (up to 405B) or faster sustained throughput on a Pro plan.
- For most non-batch work, prefer `codex` / `codex-spark` (subscription CLI) or `groq` / `cerebras` (low-latency free tier) before reaching for the open-weight 72B options.

## Mixed-provider workflow pattern

`step_providers` lets you route different stages of a workflow to different providers. The common pattern is to keep cheap, simple steps on local Ollama and route reasoning- or test-heavy steps to a cloud specialist:

    step_providers: {
      types:  "ollama",
      events: "ollama",
      data:   "ollama",
      system: "deepinfra",
      tests:  "deepinfra",
      wire:   "ollama"
    }

This keeps cost down while still getting large-model coverage on the steps that benefit from it. The stage names match the canonical feature-workflow shape produced by `generate_feature_tasks` / `run_batch`.

## Enabling

1. Set the API key in your shell: `export DEEPINFRA_API_KEY=<key>`
2. Enable the provider: `configure_provider { provider: "deepinfra", enabled: true }`
3. (Optional) Pick a non-default model on submission: `submit_task { ..., provider: "deepinfra", model: "Qwen/Qwen2.5-Coder-32B-Instruct" }`

Both providers are referenced in routing-template chains as fallback specialists; see `docs/routing-templates.md` for which presets use them and at what position.
