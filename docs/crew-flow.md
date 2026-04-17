# Crew/Flow Split

A workflow node can be a `crew`: a bounded autonomous subteam that works toward a shared objective while the surrounding workflow remains deterministic.

## When to use

- Open-ended work where the result shape is known but the path is not.
- Multi-perspective review where separate roles should challenge or refine each other.
- Research and synthesis tasks that benefit from explicit turn-taking.

## Example

    - node_id: research
      kind: crew
      crew:
        objective: Pick a JSON schema validation library and justify the recommendation.
        mode: round_robin
        max_rounds: 4
        roles:
          - name: surveyor
            description: Lists candidate libraries and their trade-offs
            provider: claude-cli
          - name: critic
            description: Identifies weaknesses in the surveyor's picks
            provider: anthropic
          - name: arbiter
            description: Produces the final recommendation once confident
            provider: claude-cli
        output_schema:
          type: object
          required: [pick, alternatives, done]
          properties:
            pick: { type: string }
            alternatives: { type: array }
            done: { type: boolean }

## Router modes

The `router` field controls which agent speaks next each turn.

- `round_robin` (default) cycles through roles in order.
- `code` uses a JavaScript function you provide to choose the next role or stop.
- `llm` asks a routing agent to choose the next speaker.
- `hybrid` lets code narrow candidates before an LLM picks among them.

    - node_id: plan
      kind: crew
      crew:
        objective: Produce a review-ready implementation plan.
        roles:
          - name: planner
          - name: critic
          - name: writer
        max_rounds: 8
        router:
          mode: hybrid
          code_fn: |
            // Must produce a list of candidate names, or [] to stop.
            if (turn.turn_count === 0) return ['planner'];
            const last = turn.history[turn.history.length - 1];
            if (last?.role === 'writer') return ['critic'];
            return ['writer', 'critic'];
          agent_model: gpt-5.3-codex-spark

## Termination

- `output_matched_schema` means a role produced output that matched `output_schema`.
- `router_stopped` means the router returned `null` or no candidates.
- `max_rounds` means the round limit was reached and the final output is the last turn's output.
