# Troubleshooting

Common issues and solutions for TORQUE.

---

## Server Startup

### MCP Server Not Starting

**Symptoms:** `/torque-status` returns an error or no tools appear in Claude Code.

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Node.js < 18 | Upgrade to Node.js 18+ (`node --version` to check) |
| Missing dependencies | Run `cd server && npm install` |
| Port conflict | Another TORQUE instance is running. Kill it or change ports |
| Corrupt database | Delete `~/.local/share/torque/tasks.db` and restart |

**Debug steps:**

1. Check the MCP server log: `~/.local/share/torque/torque-debug.log`
2. Verify `.mcp.json` exists in the project root and references `server/index.js`
3. Try starting manually: `node server/index.js` to see startup errors

### Dashboard Not Loading

**Symptoms:** `http://localhost:3456` returns connection refused or blank page.

**Solutions:**

1. Check if the port is in use: `netstat -an | grep 3456`
2. Dashboard auto-starts with the MCP server. Run `/torque-status` to wake it
3. If port is taken, change it: `configure { key: "dashboard_port", value: "3460" }`
4. Restart the server: `/torque-restart`

### REST API Not Responding

**Symptoms:** `http://127.0.0.1:3457/api/status` returns connection refused.

**Solutions:**

1. The API binds to `127.0.0.1` only — not accessible from other machines
2. Check port: `configure { key: "api_port", value: "3457" }`
3. If using API key auth, include `X-Torque-Key` header

---

## Ollama & Local LLM

### Ollama Not Detected

**Symptoms:** Tasks fail with "Ollama unavailable" or health check shows "down".

**Solutions:**

1. Verify Ollama is running: `curl http://localhost:11434/api/tags`
2. If not running, start it: `ollama serve`
3. Check the configured URL: `get_llm_tuning {}` — look at the host setting
4. Override URL: `configure { key: "ollama_host", value: "http://localhost:11434" }`

### Model Not Found

**Symptoms:** Task fails with "model not found" or similar.

**Solutions:**

1. List available models: `ollama list`
2. Pull the model: `ollama pull codellama`
3. Check TORQUE's view: `list_ollama_models {}`
4. Refresh model list: `refresh_host_models {}`

### Out of Memory (OOM)

**Symptoms:** Ollama crashes, task fails, system becomes unresponsive.

**Solutions:**

1. Set memory limits per host: `set_host_memory_limit { host_id: "...", memory_limit_mb: 8192 }`
2. Use smaller models (7B instead of 14B)
3. Reduce context window: `set_llm_tuning { num_ctx: 4096 }`
4. Reduce GPU layers: `set_hardware_tuning { num_gpu: 50 }`
5. Enable global memory protection: `configure_memory_protection { default_memory_limit_mb: 8192, strict_mode: true }`

### Slow Model Loading

**Symptoms:** First task takes a long time, subsequent ones are fast.

**Explanation:** Ollama loads models into VRAM on first use. Subsequent tasks reuse the loaded model.

**Mitigations:**

1. Increase `keep_alive` to keep models in memory longer: `set_hardware_tuning { keep_alive: "30m" }`
2. TORQUE uses model affinity — it prefers hosts that already have the model loaded
3. Use `run_benchmark` to measure load times per host

---

## Remote Hosts

### Host Stuck as "Down"

**Symptoms:** `list_ollama_hosts` shows a host as "down" even though it's running.

**Solutions:**

1. Wait for the next health check (every 60 seconds by default) — hosts auto-recover
2. Manually recover: `recover_ollama_host { host_id: "..." }`
3. Force a health check: `check_ollama_health {}`
4. Verify connectivity from the TORQUE machine: `curl http://<host-ip>:11434/api/tags`

### Connection Refused to Remote Host

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Ollama bound to 127.0.0.1 | Set `OLLAMA_HOST=0.0.0.0:11434` on the remote machine |
| Firewall blocking port | Open TCP 11434 in the remote machine's firewall |
| Wrong URL | Verify with `list_ollama_hosts` and update if needed |
| Network issue | Ping the remote machine, check routing |

### Models Not Appearing for Remote Host

**Solutions:**

1. Models refresh automatically on health checks
2. Force refresh: `refresh_host_models { host_id: "..." }`
3. Verify models are pulled on the remote machine: `ollama list` (run on remote)
4. Check the host's model list: `list_ollama_hosts {}`

### Network Scan Finds Nothing

**Symptoms:** `scan_network_for_ollama` returns 0 hosts.

**Solutions:**

1. Ensure the remote Ollama binds to `0.0.0.0` (not `127.0.0.1`)
2. Verify the correct subnet: `scan_network_for_ollama { subnet: "192.0.2" }`
3. Check firewall on remote machines (TCP 11434 must be open)
4. Try adding the host manually: `add_ollama_host { name: "Host", url: "http://IP:11434" }`

---

## Task Execution

### Task Stuck in "Running"

**Symptoms:** Task shows "running" but no output is produced.

**Solutions:**

1. Check for activity: `check_task_progress { task_id: "..." }`
2. Check for stalled tasks: `check_stalled_tasks {}`
3. TORQUE auto-detects stalls (configurable via `stall_recovery_enabled`)
4. Cancel and retry: `cancel_task { task_id: "..." }` then `retry_task { task_id: "..." }`
5. Check if the provider process is alive in your task manager / process list

### Task Stuck in "Queued"

**Symptoms:** Task stays in "queued" and never starts.

**Causes & Solutions:**

| Cause | Solution |
|-------|----------|
| Max concurrent reached | Wait for running tasks to finish, or increase `max_concurrent` |
| No healthy provider | Check `check_ollama_health {}` or `health_check {}` |
| Workflow dependency not met | Check `blocked_tasks {}` or `workflow_status { workflow_id: "..." }` |
| Queue processor stalled | Restart server: `/torque-restart` |

### Task Fails Immediately

**Common error patterns:**

| Error | Cause | Solution |
|-------|-------|----------|
| "spawn aider ENOENT" | Aider not installed | `pip install aider-chat` |
| "spawn claude ENOENT" | Claude CLI not installed | Install Claude CLI |
| "Connection refused" | Ollama not running | Start Ollama |
| "model not found" | Model not pulled | `ollama pull <model>` |
| "API key not set" | Missing env variable | Set `ANTHROPIC_API_KEY` or `GROQ_API_KEY` |

### Task Output is Empty

**Symptoms:** Task completes but `get_result` shows no output.

**Solutions:**

1. Check error output: `get_result { task_id: "..." }` — look at `error_output` field
2. Check task logs: `get_task_logs { task_id: "..." }`
3. The model may have refused the task — check for "I cannot" or "I'm unable" patterns
4. Try a different model: `smart_submit_task { task: "...", model: "codellama" }`

---

## Workflows

### Workflow Tasks Stay "Blocked"

**Symptoms:** Tasks in a workflow never transition from "blocked" to "queued".

**Solutions:**

1. Check dependency status: `workflow_status { workflow_id: "..." }`
2. Check which tasks are blocked: `blocked_tasks { workflow_id: "..." }`
3. A dependency may have failed — check the dependency graph: `dependency_graph { workflow_id: "..." }`
4. Skip a failed dependency: `skip_task { task_id: "<failed-dependency-id>" }`
5. Retry from the failed point: `retry_workflow_from { workflow_id: "...", task_id: "<failed-task>" }`

### Workflow Never Completes

**Causes:**

1. A task is stuck (see "Task Stuck" above)
2. A circular dependency exists (shouldn't be possible but check with `dependency_graph`)
3. A failed task is blocking downstream tasks

**Solution:** Check `workflow_status` for the current state of each task.

---

## Quality & Safeguards

### False Positive Validation Failures

**Symptoms:** Tasks fail validation for legitimate code patterns.

**Solutions:**

1. Check which rule triggered: `get_validation_results { task_id: "..." }`
2. Disable a specific rule: `update_validation_rule { rule_id: "...", enabled: false }`
3. Adjust rule severity: `update_validation_rule { rule_id: "...", severity: "warning" }`
4. Remove `auto_fail` from a rule: `update_validation_rule { rule_id: "...", auto_fail: false }`

### Approval Gate Triggered Unexpectedly

**Symptoms:** Task is stuck in "pending_approval" state.

**Explanation:** Approval gates trigger when file size decreases >50%, validation rules fail, or build checks fail.

**Solutions:**

1. Review the task: `preview_task_diff { task_id: "..." }`
2. Approve: `approve_diff { task_id: "..." }`
3. Reject and retry: `reject_task { task_id: "..." }`
4. Disable diff preview requirement: `configure_diff_preview { required: false }`

### Build Check Failing

**Symptoms:** Tasks report build failures after completion.

**Solutions:**

1. Check build output: `get_build_result { task_id: "..." }`
2. Analyze errors: `analyze_build_output { task_id: "..." }`
3. The task may have introduced a real build error — review the changes
4. Disable auto build checks if not needed: `configure_build_check { enabled: false }`

---

## Provider Routing

### Tasks Always Go to Wrong Provider

**Symptoms:** Cloud tasks routed to local LLM or vice versa.

**Solutions:**

1. Test routing: `test_routing { task_description: "your task here" }`
2. List routing rules: `list_routing_rules {}`
3. Check if smart routing is enabled: the config key `smart_routing_enabled` should be `1`
4. Override per-task: `smart_submit_task { task: "...", provider: "claude-cli" }`
5. Add a custom routing rule: `add_routing_rule { name: "...", pattern: "...", target_provider: "..." }`

### Provider Fallback Not Working

**Symptoms:** Task fails instead of falling back to another provider.

**Solutions:**

1. Check fallback chain: `configure_fallback_chain {}` (no args shows current chain)
2. Set fallback: `configure_fallback_chain { chain: ["aider-ollama", "claude-cli"] }`
3. Check fallback provider health: `check_ollama_health {}` or `health_check {}`

---

## Budget & Cost

### Budget Alert Not Firing

**Solutions:**

1. Verify alert exists: `list_budget_alerts {}`
2. Check budget status: `get_budget_status {}`
3. Ensure token usage is being recorded: `get_task_usage { task_id: "..." }`

### Cost Tracking Shows $0

**Explanation:** Local Ollama tasks are free and show $0. Cloud provider costs require the provider to report token usage.

**Solutions:**

1. Check if usage is recorded: `get_cost_summary {}`
2. Cloud tasks should auto-record usage — check `record_usage` calls in task output

---

## Performance

### Server Using Too Much Memory

**Solutions:**

1. Run database maintenance: `optimize_database {}`
2. Archive old tasks: `archive_tasks { status: "completed", older_than_days: 30 }`
3. Clear cache: `clear_cache {}`
4. Reduce max concurrent tasks: `configure { key: "max_concurrent", value: "2" }`

### Database Growing Large

**Solutions:**

1. Check size: `database_stats {}`
2. Archive completed tasks: `archive_tasks { older_than_days: 14 }`
3. Run VACUUM: `optimize_database {}`
4. Enable auto-cleanup: `configure_auto_cleanup { archive_days: 30, cleanup_log_days: 14 }`

### Slow Queue Processing

**Causes:**

1. Too many tasks running concurrently (contention)
2. Large database slowing queries
3. Provider responding slowly

**Solutions:**

1. Check queue depth: `check_status {}`
2. Optimize database: `optimize_database {}`
3. Adjust concurrency: `configure { key: "max_concurrent", value: "3" }`
4. Check provider health: `detect_provider_degradation {}`

---

## Reset & Recovery

### Full Reset

To completely reset TORQUE (deletes all tasks, history, config):

1. Stop the MCP server
2. Delete the database: `rm ~/.local/share/torque/tasks.db`
3. Restart Claude Code

### Reset Ollama State

If Ollama is misbehaving, use the reset scripts:

```bash
# Linux/macOS
bash server/scripts/reset-ollama.sh

# Windows (PowerShell)
powershell server/scripts/reset-ollama.ps1
```

### Recover from Orphaned Tasks

When TORQUE detects tasks left behind from crashed sessions, it automatically cleans them up at startup. If orphans persist:

1. Check for stalled tasks: `check_stalled_tasks {}`
2. Batch cancel stalled tasks: `batch_cancel { status: "running", reason: "orphan cleanup" }`
3. Restart: `/torque-restart`

---

## Logs & Debugging

### Finding Logs

| Log | Location |
|-----|----------|
| Debug log | `~/.local/share/torque/torque-debug.log` |
| Structured log | `~/.local/share/torque/torque.log` (JSON-lines) |
| Task output | `get_task_logs { task_id: "..." }` |
| Audit trail | `get_audit_trail {}` |

### Enabling Verbose Logging

```
configure_audit { enabled: true, log_level: "debug" }
```

### Reading Structured Logs

Logs are in JSON-lines format (one JSON object per line). Use `jq` to parse:

```bash
# Recent errors
tail -100 ~/.local/share/torque/torque.log | jq 'select(.level == "error")'

# Task-related events
tail -100 ~/.local/share/torque/torque.log | jq 'select(.task_id != null)'
```
