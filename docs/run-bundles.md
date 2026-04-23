# Run Bundles

Every workflow produces a self-contained artifact bundle when the workflow finalizes. If the workflow has a `working_directory`, the bundle is written to `<working_directory>/runs/<workflow_id>/`. If `working_directory` is null, TORQUE writes the bundle under `<TORQUE_DATA_DIR>/workflow-bundles/<workflow_id>/` so the server process cwd does not get littered with bundle output. A bundle can also be rebuilt manually.

    POST /api/v2/workflows/<workflow_id>/bundle

MCP tool:

    {
      "name": "build_run_bundle",
      "arguments": {
        "workflow_id": "<workflow_id>"
      }
    }

Bundle contents:

    runs/<workflow_id>/
      manifest.json
      events.jsonl
      tasks/<task_id>.json
      retro.md

`retro.md` is written when retrospective data exists for the workflow. The core replay data is `manifest.json` plus the task snapshots under `tasks/`.

## Replay

Recreate a workflow from a bundle:

    POST /api/v2/runs/replay
    {
      "bundle_dir": "<working_directory>/runs/<workflow_id>"
    }

MCP tool:

    {
      "name": "replay_workflow",
      "arguments": {
        "bundle_dir": "<working_directory>/runs/<workflow_id>"
      }
    }

For null-working-directory workflows, pass the fallback path returned by `build_run_bundle`, for example `<TORQUE_DATA_DIR>/workflow-bundles/<workflow_id>`.

Replay creates the same DAG with the same task descriptions and a fresh `workflow_id`. It is useful for regression testing, comparing provider performance, and sharing reproducible incident scenarios with teammates.

Bundles are git-friendly: commit them to share workflow runs with teammates.
