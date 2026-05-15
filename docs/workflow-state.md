# Typed Shared Workflow State

Typed shared workflow state gives every TORQUE workflow an optional key-value
store that tasks can read and update through reducer-driven patches.  State is
persisted per-workflow in SQLite, validated against an optional JSON Schema, and
checkpointed after each successful task so workflows can be forked from any
prior point.

Source modules:

| Module | Role |
|--------|------|
| `server/workflow-state/workflow-state.js` | Core WorkflowState service (CRUD + patch) |
| `server/workflow-state/reducers.js` | Built-in reducer strategies |
| `server/workflow-state/checkpoint-store.js` | Checkpoint persistence |
| `server/workflow-state/forker.js` | Fork a workflow from a checkpoint |
| `server/migrations/036-workflow-state-and-fork-columns.sql` | Schema migration |

## Database Schema

Migration `036-workflow-state-and-fork-columns.sql` creates the
`workflow_state` table and adds fork columns to `workflows`:

    CREATE TABLE IF NOT EXISTS workflow_state (
      workflow_id    TEXT PRIMARY KEY,
      state_json     TEXT NOT NULL DEFAULT '{}',
      schema_json    TEXT,
      reducers_json  TEXT,
      version        INTEGER NOT NULL DEFAULT 1,
      updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
    );

    ALTER TABLE workflows ADD COLUMN parent_workflow_id TEXT;
    ALTER TABLE workflows ADD COLUMN fork_checkpoint_id TEXT;

Note: early design documents referred to a `state_data` column on the
`workflows` table.  The shipped schema uses a dedicated `workflow_state` table
with the column named `state_json` instead, keeping state isolated from the
core workflow row.

The `workflow_checkpoints` table (created by the checkpoint store) stores
point-in-time snapshots of workflow state for replay and forking.

## DI Registration

All workflow-state services are registered in `server/container.js`:

    _defaultContainer.register('workflowState', ['db'], ...)
    _defaultContainer.register('checkpointStore', ['db'], ...)
    _defaultContainer.register('forker', ['db', 'checkpointStore', 'workflowState'], ...)

Resolve via `container.get('workflowState')` at runtime.

## WorkflowState API

`createWorkflowState({ db })` returns an object with four methods.

### `getState(workflowId)` -> `object`

Returns the current state object for a workflow.  If no row exists, returns
`{}`.  The raw `state_json` TEXT column is parsed with `safeJsonParse`.

### `getMeta(workflowId)` -> `{ schema, reducers, version, updated_at }`

Returns the JSON Schema, reducer map, version counter, and last-updated
timestamp for a workflow's state row.  If no row exists, returns defaults:

    { schema: null, reducers: {}, version: 1, updated_at: null }

### `setStateSchema(workflowId, schema?, reducers?)`

Configures the optional JSON Schema and per-field reducer map for a workflow.
Creates the state row if it does not exist (via `INSERT OR IGNORE`).

Parameters:

- `schema` -- a JSON Schema object validated by Ajv on every `applyPatch`.
  Pass `null` to disable validation.
- `reducers` -- an object mapping field names to reducer strategy strings.
  Defaults to `{}` (all fields use `replace`).

Example:

    const ws = container.get('workflowState');

    ws.setStateSchema('wf_abc123', {
      type: 'object',
      properties: {
        test_results: { type: 'array', items: { type: 'string' } },
        total_score:  { type: 'number' },
        config:       { type: 'object' }
      },
      required: ['test_results']
    }, {
      test_results: 'append',
      total_score:  'numeric_sum',
      config:       'merge_object'
    });

### `applyPatch(workflowId, patch)` -> `{ ok, state?, version?, errors? }`

Applies a key-value patch to the workflow's state using the configured reducers,
then validates the result against the schema (if set).

Returns `{ ok: true, state, version }` on success.  Returns
`{ ok: false, errors: [...] }` if schema validation fails -- the state is
**not** persisted in that case.  The version counter increments atomically on
every successful patch.

Throws if `patch` is not a plain object.

Example:

    const result = ws.applyPatch('wf_abc123', {
      test_results: ['auth.test passed'],
      total_score: 5,
      config: { verbose: true }
    });
    // result: { ok: true, state: { test_results: ['auth.test passed'], total_score: 5, config: { verbose: true } }, version: 2 }

## Reducers

`server/workflow-state/reducers.js` exports `reduceField(strategy, current,
incoming)` and `reduceState(currentState, patch, reducers)`.

Four built-in strategies are available.  Each is specified as a string in the
reducer map passed to `setStateSchema`.

### `replace` (default / `last_write_wins`)

Overwrites the current value with the incoming value.  If incoming is
`undefined`, the current value is preserved.  This is the default when no
reducer is configured for a field.

    // reducer map: { status: 'replace' }
    // current: { status: 'running' }
    // patch:   { status: 'completed' }
    // result:  { status: 'completed' }

### `append`

Treats the field as an array.  Incoming values are concatenated onto the
existing array.  If the current value is not an array, it is wrapped in one.

    // reducer map: { logs: 'append' }
    // current: { logs: ['step 1 done'] }
    // patch:   { logs: 'step 2 done' }
    // result:  { logs: ['step 1 done', 'step 2 done'] }

    // patch with array value:
    // patch:   { logs: ['step 3', 'step 4'] }
    // result:  { logs: ['step 1 done', 'step 2 done', 'step 3', 'step 4'] }

### `merge_object`

Shallow-merges the incoming object into the current object (`{ ...current,
...incoming }`).  Non-object values on either side are treated as `{}`.

    // reducer map: { metadata: 'merge_object' }
    // current: { metadata: { author: 'alice' } }
    // patch:   { metadata: { reviewer: 'bob' } }
    // result:  { metadata: { author: 'alice', reviewer: 'bob' } }

### `numeric_sum`

Adds the incoming number to the current number.  Non-numeric values are
treated as 0.

    // reducer map: { score: 'numeric_sum' }
    // current: { score: 10 }
    // patch:   { score: 5 }
    // result:  { score: 15 }

## Schema Validation

When a JSON Schema is configured via `setStateSchema`, every `applyPatch` call
compiles the schema with Ajv (`{ strict: false, allErrors: true }`) and
validates the *post-reduce* state before persisting.  If validation fails, the
patch is rejected and the state remains unchanged.  The error response includes
all Ajv error paths and messages.

Example validation error:

    {
      ok: false,
      errors: ['/test_results: must be array']
    }

## Checkpoints

`server/workflow-state/checkpoint-store.js` provides `createCheckpointStore({ db })`.

### `writeCheckpoint({ workflowId, stepId?, taskId?, state, version })` -> `string`

Writes a snapshot of workflow state to the `workflow_checkpoints` table.
Returns the generated checkpoint ID (`cp_<uuid12>`).  The task finalizer calls
this automatically when a task completes successfully within a workflow.

### `listCheckpoints(workflowId)` -> `array`

Returns all checkpoints for a workflow, ordered by `taken_at` ascending.

### `getCheckpoint(checkpointId)` -> `object | null`

Retrieves a single checkpoint by ID, with the `state_json` column parsed into
a `state` property.

## Forking

`server/workflow-state/forker.js` provides `createForker({ db, checkpointStore,
workflowState })`.

### `fork({ checkpointId, name?, state_overrides? })` -> `{ new_workflow_id, resumes_from_step, cloned_step_count }`

Creates a new workflow by cloning an existing workflow from a checkpoint.  The
entire operation runs inside a SQLite transaction.

1. Reads the checkpoint and its source workflow.
2. Creates a new `workflows` row with `parent_workflow_id` and `fork_checkpoint_id`.
3. Copies the schema and reducers from the source; seeds state from
   `state_overrides` (if provided) or the checkpoint's saved state.
4. Validates the seed state against the source schema.
5. Clones all tasks that were not yet completed at the checkpoint.
6. Remaps task dependencies to the new task IDs.

## Task Finalizer Integration

`server/execution/task-finalizer.js` reads from the `workflow_state` table
directly when building checkpoint snapshots after task completion.  It resolves
the current state and version from `workflow_state` for the task's workflow,
then writes a checkpoint via the checkpoint store.

## Future Work

The following are planned but not yet implemented:

- **MCP tools** (`get_workflow_state`, `set_workflow_state`) for external callers
- **REST endpoints** (`GET /api/workflows/:id/state`, `PUT /api/workflows/:id/state`)
- **`__state_updates` output contract** -- tasks emitting state patches in their
  output, with the close-handler applying them atomically
- **Conditional edges** (plan #28) -- branching workflow execution based on state values
- **Custom reducer functions** -- user-defined JS reducers beyond the four built-in strategies
- **Dashboard UI** for viewing and editing workflow state
