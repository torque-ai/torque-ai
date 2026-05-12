# Infrastructure Host Local Credentials

Put project-specific remote workstation credentials in:

```text
infrastructure/hosts/torque-remote.local.json
```

That file is ignored by git and must stay local to this machine. It overrides the global `~/.torque-remote.local.json` for this repository, which is useful when the remote host is back online under different credentials.

Start from `torque-remote.local.json.example`, then lock down the local file permissions. On Windows:

```powershell
Copy-Item infrastructure\hosts\torque-remote.local.json.example infrastructure\hosts\torque-remote.local.json
icacls infrastructure\hosts\torque-remote.local.json /inheritance:r /grant:r "$env:USERNAME:F"
```
