# Workstation Bootstrap Design

**Date:** 2026-03-20
**Status:** Approved
**Scope:** Bootstrap endpoint + script + dashboard integration

## Problem

Adding a remote workstation requires manually: generating a secret, SSHing to the remote machine, setting the env var, copying the agent-server code, starting it, then entering the secret in the dashboard form. Too many steps, too easy to get wrong.

## Solution

A one-liner bootstrap command that the user runs on the remote machine. The script downloads the agent, generates a shared secret, starts the service, and registers itself back with TORQUE automatically.

```bash
curl -s http://TORQUE_HOST:3457/api/bootstrap/workstation | bash
```

## Flow

1. User clicks "Add Workstation" in dashboard
2. Dashboard shows the bootstrap command (pre-filled with TORQUE's IP)
3. User copies command, SSHs to remote machine, pastes and runs
4. Bootstrap script on the remote machine:
   a. Downloads `agent-server.js` and dependencies from TORQUE
   b. Generates a UUID secret
   c. Starts the agent-server with the secret
   d. Calls `POST /api/workstations/register` on TORQUE with: name (hostname), host (its own IP), port (3460), secret
5. TORQUE registers the workstation and probes health
6. Dashboard auto-refreshes — new workstation card appears

## Bootstrap Script

Served at `GET /api/bootstrap/workstation`. Returns a shell script that:

1. Detects platform (Linux/macOS/Windows via uname or $OS)
2. Checks prerequisites: node >= 18, git
3. Creates `~/.torque-agent/` directory
4. Downloads agent-server files from TORQUE (or clones the repo)
5. Generates secret: `node -e "console.log(require('crypto').randomUUID())"`
6. Starts agent: `TORQUE_AGENT_SECRET=$SECRET node agent-server.js --port 3460`
7. Registers with TORQUE: `curl -X POST http://TORQUE_HOST:3457/api/workstations -d '...'`
8. Prints status and next steps

### --install flag

When run with `| bash -s -- --install`:
- **Linux**: creates a systemd unit (`torque-agent.service`)
- **Windows**: creates a scheduled task (`TorqueAgent`)
- **macOS**: creates a launchd plist

Without `--install`: runs in foreground with nohup instructions printed.

## API Endpoints

### GET /api/bootstrap/workstation

Returns the bootstrap shell script. The script has TORQUE's address baked in (from the request's Host header or configured external URL).

Query params:
- `name` — optional workstation name (defaults to hostname)
- `port` — optional agent port (defaults to 3460)

### POST /api/workstations/register

Called by the bootstrap script to self-register. Body:
```json
{
  "name": "builder-01",
  "host": "192.168.1.100",
  "port": 3460,
  "secret": "generated-uuid",
  "platform": "linux",
  "node_version": "v22.20.0"
}
```

This is the same as the existing workstation create endpoint but without requiring the user to know the secret — the script generated it and is providing it in one atomic operation.

## Dashboard Changes

### Add Workstation form — new "Bootstrap" tab

The existing manual form stays (renamed to "Manual" tab). A new "Bootstrap" tab becomes the default, showing:

```
┌─ Add Workstation ──────────────────────────┐
│ [Bootstrap] [Manual]                        │
│                                             │
│ Run this on the remote machine:             │
│ ┌─────────────────────────────────────────┐ │
│ │ curl -s http://10.0.0.5:3457/api/      │ │
│ │ bootstrap/workstation | bash            │ │
│ └─────────────────────────────────────────┘ │
│                          [Copy] [Options ▾] │
│                                             │
│ Options:                                    │
│   Name: _________ (optional, defaults to    │
│                    remote hostname)          │
│   Install as service: [ ] checkbox          │
│                                             │
│ Waiting for registration...  ◌              │
│ (auto-refreshes when agent connects)        │
└─────────────────────────────────────────────┘
```

The "Waiting for registration..." spinner polls `/api/workstations` every 5 seconds until a new workstation appears, then auto-dismisses the form and shows the new card.

## Files

**New:**
- `server/api/bootstrap.js` — GET handler that generates the shell script
- `server/scripts/agent-bootstrap.sh` — the actual bootstrap script template

**Modified:**
- `server/api/routes.js` — register bootstrap endpoint
- `server/api-server.core.js` — wire bootstrap handler
- `dashboard/src/views/Hosts.jsx` — add Bootstrap tab to Add Workstation form

## Security

- The bootstrap endpoint is rate-limited (max 5 requests per minute per IP)
- The generated secret is a cryptographically random UUID
- The script validates HTTPS/HTTP before sending the secret back
- The registration endpoint validates the secret by immediately probing the agent

## Not In Scope

- SSH key distribution (the user already has SSH access to run the command)
- Auto-discovery of machines (user initiates by running the command)
- TLS for agent communication (future — currently HTTP on LAN)
- Windows PowerShell bootstrap variant (future — bash works via WSL/Git Bash)
