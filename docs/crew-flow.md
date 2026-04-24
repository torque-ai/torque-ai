# Crew/Flow Split

A workflow node can be a `crew` - a bounded autonomous subteam working toward an open-ended objective. The surrounding workflow stays deterministic; only the crew node is autonomous.

## When to use

- Open-ended research where the answer shape is known but the path isn't
- Multi-perspective review (e.g., security + arch + UX critics on the same change)
- Brainstorming or ideation tasks that benefit from cross-pollination

## When NOT to use

- Anything reproducible - use a regular task
- Tasks where you know exactly what should happen - use the architect/editor split (Plan 18) instead

## Example

    - node_id: research
      task: Research best library for JSON schema validation
      kind: crew
      crew:
        objective: Pick a library, justify the choice, list 2 alternatives with trade-offs.
        mode: round_robin
        max_rounds: 4
        roles:
          - name: surveyor
            description: Lists candidate libraries and their key properties
            provider: claude-cli
          - name: critic
            description: Identifies weaknesses in the surveyor's picks
            provider: anthropic
          - name: arbiter
            description: Synthesizes a final recommendation. Set "done": true when confident.
            provider: claude-cli
        output_schema:
          type: object
          required: [pick, alternatives, done]
          properties:
            pick: { type: string }
            alternatives: { type: array }
            done: { type: boolean }

## Modes

- `round_robin` - each role takes a turn in declared order, repeating up to `max_rounds`
- `parallel` - all roles run concurrently each round, results merged into shared history
- `hierarchical` - first role is manager, decides which worker role to delegate to next via `output.delegate_to`

## Termination

- `output_matched_schema` - any role's output matches `output_schema` (and `done: true` if the schema requires it)
- `max_rounds` - round limit hit; final output is the last role's output
