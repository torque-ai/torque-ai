# torque-coord — Operations

The Remote Test Coordinator daemon. Runs on the test workstation and serializes concurrent `torque-remote` invocations to prevent CPU/memory contention crashes. The entry point is `bin/torque-coord` (bash, cross-platform); the service wrapper differs per OS.

## Install — Windows (Scheduled Task)

Run as the user that owns the test workstation environment:

    powershell -ExecutionPolicy Bypass -File scripts\install-torque-coord.ps1

This creates a Scheduled Task `TorqueCoord` that auto-starts at logon and restarts on failure. Logs at `%USERPROFILE%\.torque-coord\logs\torque-coord.log`.

**Start / stop / restart:**

    schtasks /run /tn TorqueCoord       # start
    schtasks /end /tn TorqueCoord       # stop
    schtasks /change /tn TorqueCoord /disable
    schtasks /change /tn TorqueCoord /enable

## Install — Linux (systemd)

For Linux remote workstations the daemon runs as a user-managed systemd service. The unit file isn't currently committed to the repo; install it manually:

1. Place the repo (or a copy of `bin/torque-coord` + the `server/coord/` directory) at `/opt/torque-coord/`.
2. Create `/etc/systemd/system/torque-coord.service`:

        [Unit]
        Description=TORQUE Remote Test Coordinator
        After=network.target

        [Service]
        Type=simple
        ExecStart=/opt/torque-coord/bin/torque-coord
        Restart=on-failure
        RestartSec=5
        User=<workstation-user>
        Environment=NODE_ENV=production
        StandardOutput=append:/var/log/torque-coord/torque-coord.log
        StandardError=append:/var/log/torque-coord/torque-coord.log

        [Install]
        WantedBy=multi-user.target

3. Enable and start:

        sudo systemctl daemon-reload
        sudo systemctl enable --now torque-coord
        sudo systemctl status torque-coord

**Start / stop / restart:**

    sudo systemctl start torque-coord
    sudo systemctl stop torque-coord
    sudo systemctl restart torque-coord
    sudo journalctl -u torque-coord -f       # tail logs

The dev box reaches the Linux coord via the same SSH transport used for `torque-remote` — no extra port forwarding needed if the workstation is already configured in `~/.torque-remote.local.json`.

## Health check

    curl http://127.0.0.1:9395/health
    # {"ok":true,"protocol_version":1,"uptime_ms":...,"active_count":N}

## Active locks

    curl http://127.0.0.1:9395/active

## Troubleshoot

- **`[torque-coord] unreachable` in `torque-remote` output:** daemon not running.
  - Windows: `schtasks /query /tn TorqueCoord` and check the log file.
  - Linux: `sudo systemctl status torque-coord` and `journalctl -u torque-coord -n 100`.
- **Port 9395 in use:** change `port` in `~/.torque-coord/state/config.json` and restart. Update `TORQUE_COORD_PORT` for `bin/torque-coord-client` callers if you change the default.
- **Stale lock won't release:** check the daemon log for reaper activity. Heavy hammer: restart the service (Windows: `schtasks /end ... && schtasks /run ...`; Linux: `sudo systemctl restart torque-coord`) — on restart the daemon clears `active.json` (treats all entries as crashed).

## Coordination is best-effort

If the daemon is down, `torque-remote` falls through to today's uncoordinated behavior. The 2-second connect timeout means a misconfigured or stopped daemon does NOT block test execution; it only logs a warning.
