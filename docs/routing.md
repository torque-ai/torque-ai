# Routing

This guide covers workflow-level routing controls, including model stylesheets.

## Model stylesheets

You can assign providers and models to tasks using CSS-like rules. Supply them on `create_workflow` as `model_stylesheet`, or at the top of a workflow spec YAML.

### Selectors

| Selector | Matches | Specificity |
|---|---|---|
| `*` | All tasks | 0 |
| `.tag-name` | Tasks with that tag | 1 |
| `#node-id` | The task with that node_id | 2 |

Later rules beat earlier rules of equal specificity. Higher specificity always beats lower.

### Properties

- `provider` — one of `codex`, `claude-cli`, `ollama`, `ollama-cloud`, `anthropic`, `cerebras`, `deepinfra`, `google-ai`, `groq`, `hyperbolic`, `openrouter`
- `model` — model ID
- `reasoning_effort` — `low` / `medium` / `high`
- `routing_template` — routing template name

### Example

    version: 1
    name: ensemble
    model_stylesheet: |
      /* Default everything to a cheap local model */
      * { provider: ollama; reasoning_effort: medium; }
      /* Coding steps get Codex on high reasoning */
      .coding { provider: codex; reasoning_effort: high; }
      /* Reviews use a different vendor for fresh eyes */
      .review { provider: claude-cli; }
      /* This specific node always uses Opus */
      #final-synthesis { model: claude-opus-4-6; }
    tasks:
      - node_id: plan
        task: Write a plan
      - node_id: implement
        task: Implement the plan
        tags: [coding]
      - node_id: critique
        task: Critique the implementation
        tags: [review]
      - node_id: final-synthesis
        task: Produce the final summary

### Precedence with explicit fields

An explicit `provider` / `model` on a task always wins over the stylesheet. Stylesheets only fill fields the task left unset.

### Precedence with routing templates

`routing_template` from the stylesheet follows the same rule — task-level `routing_template` beats stylesheet. The existing smart-routing fallback chain still runs downstream; the stylesheet just picks the preferred provider/model upfront.
