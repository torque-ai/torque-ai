# Multi-Host Guide

TORQUE can distribute tasks across multiple Ollama instances on your local network, enabling parallel execution and load balancing.

## Architecture

```
TORQUE MCP Server
    │
    ├── Local Ollama (localhost:11434)
    │
    ├── Remote Host A (192.0.2.50:11434)
    │
    └── Remote Host B (192.0.2.51:11434)
```

Each host runs its own Ollama instance with its own GPU and models. TORQUE selects the best host based on availability, model affinity, and capacity.

## Setting Up a Remote Host

### 1. Install Ollama on the Remote Machine

```bash
# Linux/macOS
curl -fsSL https://ollama.ai/install.sh | sh

# Windows
# Download from https://ollama.ai/download
```

### 2. Bind to All Interfaces

By default, Ollama only listens on `127.0.0.1`. To accept connections from other machines:

**Linux (systemd):**
```bash
sudo systemctl edit ollama
```

Add:
```ini
[Service]
Environment="OLLAMA_HOST=0.0.0.0:11434"
```

Then restart:
```bash
sudo systemctl restart ollama
```

**Linux (manual):**
```bash
OLLAMA_HOST=0.0.0.0:11434 ollama serve
```

**Windows:**
Set the environment variable `OLLAMA_HOST=0.0.0.0:11434` and restart Ollama.

### 3. Open Firewall

Ensure TCP port `11434` is open for inbound connections from your LAN.

**Linux (ufw):**
```bash
sudo ufw allow from 192.0.2.0/24 to any port 11434
```

**Windows:**
```powershell
New-NetFirewallRule -DisplayName "Ollama" -Direction Inbound -LocalPort 11434 -Protocol TCP -Action Allow
```

### 4. Pull Models

On the remote machine, pull the models you want available:

```bash
ollama pull codellama
ollama pull llama3
ollama pull deepseek-coder-v2:16b
```

### 5. Register the Host in TORQUE

```
add_ollama_host { name: "WorkStation", url: "http://192.0.2.50:11434" }
```

Or via slash command:

```
/torque-submit add host name=WorkStation url=http://192.0.2.50:11434
```

## Host Management

### Listing Hosts

```
list_ollama_hosts {}
```

Shows all registered hosts with:
- Name and URL
- Status (online/offline/error)
- Available models
- Response time
- Current task load

### Checking Health

```
check_ollama_health {}
```

Tests connectivity to all registered hosts and updates their status.

### Enabling/Disabling Hosts

Temporarily disable a host without removing it:

```
disable_ollama_host { host_id: "host-abc123" }
enable_ollama_host { host_id: "host-abc123" }
```

### Removing a Host

```
remove_ollama_host { host_id: "host-abc123" }
```

### Recovering a Down Host

Hosts are auto-recovered during health checks, but you can manually trigger recovery:

```
recover_ollama_host { host_id: "host-abc123" }
```

### Refreshing Models

Model lists refresh automatically on health checks. Force a refresh:

```
refresh_host_models { host_id: "host-abc123" }
```

Or refresh all hosts:

```
refresh_host_models {}
```

## Capacity Management

### Max Concurrent Tasks Per Host

Limit how many tasks run simultaneously on a host:

```
set_host_max_concurrent { host_id: "host-abc123", max_concurrent: 2 }
```

Set to `0` for unlimited (default).

### Viewing Capacity

```
get_host_capacity {}
```

Shows a table of all hosts with:
- Current running tasks
- Maximum allowed
- Available slots
- Memory limits

## Memory Protection

Prevent out-of-memory errors by setting memory limits per host.

### Per-Host Memory Limit

```
set_host_memory_limit { host_id: "host-abc123", memory_limit_mb: 8192 }
```

Models larger than the limit (with 15% overhead) will not be loaded on that host. Set to `0` to disable.

### Global Memory Protection

```
configure_memory_protection {
  default_memory_limit_mb: 8192,
  strict_mode: true,
  reject_unknown_sizes: false
}
```

| Setting | Description |
|---------|-------------|
| `default_memory_limit_mb` | Default limit for new hosts |
| `strict_mode` | Reject models with unknown sizes |
| `reject_unknown_sizes` | Block models that don't report size |

### Checking Status

```
get_memory_protection_status {}
```

Shows protection level (Low/Medium/High/Maximum) and per-host compatibility tables.

## Model Affinity

TORQUE tracks which model was last loaded on each host. When routing tasks, it prefers hosts that already have the requested model loaded, avoiding model swap overhead.

This is automatic and requires no configuration.

## Host Priority

Set priority for host selection (lower = preferred):

```
set_host_priority { host_id: "host-abc123", priority: 1 }
```

## Per-Host Settings

Configure optimization settings per host:

```
set_host_settings {
  host_id: "host-abc123",
  num_gpu: 70,
  keep_alive: "10m"
}
```

View current settings:

```
get_host_settings { host_id: "host-abc123" }
```

## LAN Discovery

### Automatic Discovery (mDNS)

TORQUE can discover Ollama instances on your LAN using mDNS/Bonjour:

```
get_discovery_status {}
```

### Manual Network Scan

Scan your network for Ollama instances:

```
scan_network_for_ollama { subnet: "192.0.2" }
```

### Auto-Scan Configuration

Schedule periodic network scans:

```
configure_auto_scan {
  enabled: true,
  interval_minutes: 30,
  subnet: "192.0.2"
}
```

### Discovery Settings

```
set_discovery_config {
  enabled: true,
  auto_add: true,
  scan_on_startup: true
}
```

## Auto Health Monitoring

TORQUE checks all enabled hosts every 60 seconds (configurable):

```
configure { key: "health_check_interval_seconds", value: "30" }
```

Behavior:
- Hosts that come back online are **auto-recovered**
- Model lists are **refreshed** on each successful check
- First check runs 15 seconds after server startup
- Failed checks increment a consecutive failure counter
- Hosts are marked as `down` after persistent failures

## GPU Metrics

### nvidia-smi Integration

The GPU metrics server (port 9394) polls `nvidia-smi` for:
- GPU utilization percentage
- VRAM usage (used/total)
- Temperature
- Power draw

### Remote GPU Metrics

For remote hosts, install and run the GPU metrics companion script:

```bash
# On the remote machine
node scripts/gpu-metrics-server.js
```

This exposes GPU data at `http://<host>:9394/metrics` for the dashboard to consume.

## Benchmarking

Run performance benchmarks on a host:

```
run_benchmark { host_id: "host-abc123", model: "codellama" }
```

Returns:
- Tokens per second
- Time to first token
- Total generation time

## Tools Reference

| Tool | Description |
|------|-------------|
| `add_ollama_host` | Register a new remote host |
| `remove_ollama_host` | Remove a host |
| `list_ollama_hosts` | List all hosts with status |
| `enable_ollama_host` | Enable a disabled host |
| `disable_ollama_host` | Disable a host |
| `recover_ollama_host` | Manually recover a downed host |
| `check_ollama_health` | Check connectivity to all hosts |
| `refresh_host_models` | Force model list refresh |
| `set_host_memory_limit` | Set VRAM/memory limit |
| `set_host_max_concurrent` | Set concurrency limit |
| `get_host_capacity` | View capacity across hosts |
| `configure_memory_protection` | Global memory settings |
| `get_memory_protection_status` | View protection status |
| `scan_network_for_ollama` | Scan LAN for Ollama |
| `configure_auto_scan` | Set up periodic scanning |
| `get_discovery_status` | View mDNS discovery status |
| `set_discovery_config` | Configure discovery |
| `set_host_priority` | Set host selection priority |
| `get_host_settings` | View per-host settings |
| `set_host_settings` | Configure per-host optimization |
| `run_benchmark` | Run performance benchmark |
| `cleanup_null_id_hosts` | Remove hosts with null IDs |

## Troubleshooting

| Problem | Solution |
|---------|----------|
| Host stuck as "down" | Auto-recovers on next health check; or use `recover_ollama_host` |
| Models not appearing | Refresh automatically; or use `refresh_host_models` |
| Connection refused | Verify Ollama binds to `0.0.0.0` (not `127.0.0.1`) |
| Slow model loading | Set memory limits to prevent OOM; use model affinity |
| Network scan finds nothing | Check firewall, verify port 11434 is open |
| Out of memory | Set `set_host_memory_limit` to restrict large models |
