## Scheduled workflow specs

Schedule a workflow spec to run on a cron:

    schedule_workflow_spec {
      name: "nightly-factory",
      cron: "0 2 * * *",
      spec_path: "workflows/nightly-factory.yaml",
      timezone: "America/Denver"
    }

The schedule runner dispatches `run_workflow_spec` when the cron fires, creating a fresh workflow each time.

Differences from `schedule_task`:
- Payload is a YAML spec path, not a task payload object
- Spec is parsed and validated at schedule time; if it does not parse, scheduling is rejected
- Each fire creates a new workflow ID (no de-duplication; if you want at-most-one-running, gate it via the spec itself)
