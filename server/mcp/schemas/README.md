# MCP Schema Catalog

The top-level schema catalog stores one JSON schema file per MCP tool request.

## Naming Convention

Schema files use the format `{namespace}.{action}.json`.

Examples:

    task.submit.json
    task.get.json
    workflow.create.json

## Available Namespaces

- `task`
- `workflow`
- `provider`
- `system`
- `quality`
- `budget`

## Adding A Tool Schema

1. Create a new schema file in `server/mcp/schemas/` named `{namespace}.{action}.json`.
2. Use a standard JSON Schema object with `type`, `properties`, `required`, and `additionalProperties` as needed.
3. Keep the schema aligned with the corresponding tool definition in `server/tool-defs/`.
4. Run the catalog tests after adding or changing a schema.

Example:

    {
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "$id": "workflow.create",
      "title": "workflow.create",
      "type": "object",
      "properties": {
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name"
      ],
      "additionalProperties": false
    }
