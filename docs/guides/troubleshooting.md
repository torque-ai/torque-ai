# Troubleshooting

Common issues and how to fix them.

**Start here:** Run `torque doctor` to check your setup. It verifies Node.js version, server connectivity, Ollama detection, CLI tools, API keys, and MCP configuration in one command.

## Server Won't Start

### Port already in use

```
Error: listen EADDRINUSE :::3457
```

Another process is using one of TORQUE's ports (3456, 3457, or 3458). Either stop the other process or configure different ports:

```bash
export TORQUE_DASHBOARD_PORT=4456
export TORQUE_API_PORT=4457
export TORQUE_MCP_SSE_PORT=4458
torque start
```

### Server started but health check timed out

```bash
# Check if the server is actually running
curl http://127.0.0.1:3457/healthz

# Check for errors in the log output
torque start   # Run in foreground to see logs
```

### Stale PID file

If TORQUE was killed unexpectedly, a stale PID file may remain:

```bash
torque stop    # Cleans up PID files automatically
torque start
```

## Ollama Not Detected

### During `torque init`

`torque init` checks `http://localhost:11434`. If Ollama is running on a different host or port:

```bash
export OLLAMA_HOST=http://192.168.1.100:11434
torque init
```

### Ollama is installed but not running

```bash
ollama serve
```

Then restart TORQUE — it will detect Ollama on the next health check (runs every 60 seconds).

### Remote Ollama host won't connect

On the remote machine, verify Ollama is bound to all interfaces:

```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

Check firewall allows inbound TCP on port 11434.

## Tasks Fail Immediately

### No providers available

If no providers are configured, tasks have nowhere to go. Run `torque health` to see what's connected.

At minimum, you need one of:
- Ollama running locally
- Codex CLI installed and authenticated
- A cloud API key set and the provider enabled

### Provider-specific failures

Check which provider was selected and its status:

```bash
torque result <task-id>    # Shows which provider ran the task
torque health              # Shows provider connectivity
```

## Tasks Stuck in "Running"

### Stall detection

TORQUE has built-in stall detection. If a task exceeds the stall threshold for its provider, it's automatically cancelled and resubmitted. Default thresholds:

- Ollama: 180 seconds
- Codex: 600 seconds
- API providers: 180 seconds

If auto-resubmit is disabled:

```bash
torque cancel <task-id>
torque submit "same task description"    # Resubmit manually
```

### Ollama model loading

Large models take time to load into VRAM on first use. The first task after pulling a new model may appear stuck while loading. Subsequent tasks will be fast.

## MCP Connection Issues

### Claude Code can't connect to TORQUE

1. Verify the server is running: `curl http://127.0.0.1:3458/sse`
2. Check `.mcp.json` points to the correct port:

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse"
    }
  }
}
```

3. Restart Claude Code after changing `.mcp.json`

### Authentication errors

TORQUE generates an API key on first startup. If connecting via SSE with authentication enabled:

```json
{
  "mcpServers": {
    "torque": {
      "type": "sse",
      "url": "http://127.0.0.1:3458/sse?apiKey=${TORQUE_API_KEY}"
    }
  }
}
```

The key is saved to `<data_dir>/.torque-api-key` on first startup.

## Dashboard Not Loading

### Blank page at localhost:3456

The dashboard is a React SPA built during `npm run build:dashboard`. If running from source:

```bash
cd dashboard && npm install && npm run build
```

The built assets are served by the TORQUE server automatically.

### WebSocket connection failed

The dashboard uses WebSocket for real-time updates. If you're behind a reverse proxy, ensure WebSocket upgrade is allowed.

## Docker Issues

### Ollama not reachable from Docker

Docker containers can't reach `localhost` on the host. The `docker-compose.yml` uses `host.docker.internal`:

```yaml
environment:
  - OLLAMA_HOST=http://host.docker.internal:11434
```

On Linux, you may need to add `--add-host=host.docker.internal:host-gateway` or use the host's LAN IP instead.

### Data persistence

Task history and configuration are stored in a Docker volume (`torque-data`). To reset:

```bash
docker compose down -v    # Warning: deletes all data
docker compose up -d
```

## Performance

### Tasks are slow

- **Model loading** — first task with a model is slow while it loads into VRAM. Subsequent tasks reuse the loaded model.
- **Context window** — larger `num_ctx` values use more VRAM and slow down inference. The default (8192) balances quality and speed.
- **Concurrency** — too many concurrent tasks on one Ollama host will queue internally. Check host load with `list_ollama_hosts`.

### High memory usage

TORQUE uses SQLite for persistence. The database grows with task history. Configure auto-archiving:

```
set_project_defaults { auto_archive_days: 30 }
```

## Getting Help

- Check the [Provider Guide](providers.md) for provider-specific setup
- See [`CLAUDE.md`](../../CLAUDE.md) for the full architecture reference
- File issues at [GitHub](https://github.com/torque-ai/torque-ai/issues)
