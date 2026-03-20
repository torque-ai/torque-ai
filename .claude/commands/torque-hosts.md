---
name: torque-hosts
description: Manage Ollama hosts — add, remove, enable, disable, refresh models, check health
argument-hint: "[list | add <url> | remove <name> | enable <name> | disable <name> | refresh | health]"
allowed-tools:
  - mcp__torque__list_ollama_hosts
  - mcp__torque__add_ollama_host
  - mcp__torque__remove_ollama_host
  - mcp__torque__enable_ollama_host
  - mcp__torque__disable_ollama_host
  - mcp__torque__refresh_host_models
  - mcp__torque__check_ollama_health
  - mcp__torque__list_ollama_models
  - mcp__torque__get_host_settings
  - mcp__torque__set_host_settings
  - AskUserQuestion
---

# TORQUE Hosts

Manage Ollama inference hosts on the local network.

## Instructions

### If no argument or "list" — show all hosts:

1. Call in parallel:
   - `list_ollama_hosts` — get all registered hosts with status
   - `check_ollama_health` — get health check results

2. Present as:

```
## Ollama Hosts

| Host | URL | Status | GPU | Models | Running | Priority |
|------|-----|--------|-----|--------|---------|----------|
| local-host | http://localhost:11434 | healthy | RTX 4060 (8GB) | 3 | 1/3 | 10 |
| remote-gpu | http://192.168.1.100:11434 | healthy | RTX 3090 (24GB) | 5 | 0/2 | 8 |

To add: /torque-hosts add http://192.168.1.x:11434
To manage: /torque-hosts enable|disable|remove <name>
```

### If argument starts with "add":

1. Parse URL from argument (e.g., "add http://192.168.1.100:11434")
2. If no name provided, derive from IP or ask via AskUserQuestion
3. Call `add_ollama_host` with `{ name: "<name>", url: "<url>" }`
4. Call `check_ollama_health` to verify connectivity
5. Report: host added, models discovered, health status

### If argument starts with "remove":

1. Parse host name from argument
2. Confirm with user via AskUserQuestion (destructive operation)
3. Call `remove_ollama_host` with the host ID
4. Confirm removal

### If argument is "enable" or "disable":

1. Parse host name from argument
2. Call `enable_ollama_host` or `disable_ollama_host` with the host ID
3. Confirm the new status

### If argument is "refresh":

1. Call `list_ollama_hosts` to get all hosts
2. For each healthy host, call `refresh_host_models`
3. Report: models discovered per host, any new models found

### If argument is "health":

1. Call `check_ollama_health` for detailed health report
2. For any unhealthy hosts, suggest troubleshooting:
   - Connection refused → Ollama not running or not bound to 0.0.0.0
   - Timeout → Network issue or firewall blocking port 11434
   - Model mismatch → Run /torque-hosts refresh

### If argument matches a host name:

1. Call `get_host_settings` for that host
2. Call `list_ollama_models` filtered to that host
3. Present: URL, status, GPU info, all available models, current settings, running tasks
