# OpenRouter NetSim Canary

This canary validates that OpenRouter can still execute read-only repository tool calls against NetSim.

Workflow spec: `workflows/openrouter-netsim-canary.yaml`

## Schedule it (hourly example)

```powershell
curl.exe -sS -X POST http://127.0.0.1:3457/api/v2/schedules/workflow-spec `
  -H "Content-Type: application/json" `
  -d "{\"name\":\"openrouter-netsim-canary-hourly\",\"cron\":\"15 * * * *\",\"spec_path\":\"workflows/openrouter-netsim-canary.yaml\",\"working_directory\":\"C:/path/to/NetSim\"}"
```

## Verify schedule + runs

```powershell
curl.exe -sS "http://127.0.0.1:3457/api/v2/schedules?enabled_only=true&limit=50"
```

Use `run_scheduled_task_now` for immediate execution when needed.
