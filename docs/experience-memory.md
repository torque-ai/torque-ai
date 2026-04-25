# Experience Memory

TORQUE remembers what worked. Every task that completes successfully with `tests:pass`, or with no `tests:*` verification tag at all, is recorded in the `task_experiences` table alongside an embedding of its description.

When a new task starts, TORQUE looks up the top 3 most similar past experiences for the same project and appends them to the task prompt as `## Related past experiences`.

## Why

- Cheap, automatic improvement loop with no fine-tuning
- Lets agents reuse concrete patterns from prior successful work
- Compounds over time as each project builds a richer local experience pool

## Embeddings

A real embedding provider can be wired later via `TORQUE_EMBEDDING_PROVIDER`. Until then, TORQUE falls back to a local hash-based vector. Retrieval quality is weaker than a semantic embedding model, but the feature still works without external dependencies.

## MCP Tools

    find_related_experiences { task_description: "...", project: "torque", top_k: 5 }
    record_experience { task_description: "...", output_summary: "...", project: "torque" }

`find_related_experiences` returns a text summary plus `structuredData.results`. `record_experience` writes a manual success entry into the local store.

## Smoke

1. Submit and complete a task successfully for a project.
2. Submit a second task with a similar description in the same project.
3. Confirm the second task's execution description contains `## Related past experiences` referencing the first task.

## Privacy

Experiences stay in the local TORQUE database. Nothing is sent to an external service unless an embedding provider is explicitly configured.
