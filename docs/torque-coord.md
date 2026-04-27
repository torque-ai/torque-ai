# torque-coord — Operations

The Remote Test Coordinator daemon. Runs on the test workstation and
serializes concurrent `torque-remote` invocations to prevent CPU/memory
contention crashes.

## Install (workstation)

Run as the user that owns the test workstation environment:

    powershell -ExecutionPolicy Bypass -File scripts\install-torque-coord.ps1

This creates a Scheduled Task `TorqueCoord` that auto-starts at logon and
restarts on failure. Logs at `%USERPROFILE%\.torque-coord\logs\torque-coord.log`.

## Start / stop / restart

    schtasks /run /tn TorqueCoord       # start
    schtasks /end /tn TorqueCoord       # stop
    schtasks /change /tn TorqueCoord /disable
    schtasks /change /tn TorqueCoord /enable

## Health check

    curl http://127.0.0.1:9395/health
    # {"ok":true,"protocol_version":1,"uptime_ms":...,"active_count":N}

## Active locks

    curl http://127.0.0.1:9395/active

## Troubleshoot

- **`[torque-coord] unreachable` in `torque-remote` output:** daemon not
  running. Check `schtasks /query /tn TorqueCoord` and the log file.
- **Port 9395 in use:** change `port` in `~/.torque-coord/state/config.json`
  and restart. Update `TORQUE_COORD_PORT` for `bin/torque-coord-client`
  callers if you change the default.
- **Stale lock won't release:** check the daemon log for reaper activity.
  Heavy hammer: `schtasks /end /tn TorqueCoord && schtasks /run /tn TorqueCoord` —
  on restart the daemon clears the active.json (treats all entries as crashed).

## Coordination is best-effort

If the daemon is down, `torque-remote` falls through to today's
uncoordinated behavior. The 2-second connect timeout means a misconfigured
or stopped daemon does NOT block test execution; it only logs a warning.
