<#
.SYNOPSIS
  Install torque-coord as a Windows Scheduled Task on the workstation.

.DESCRIPTION
  Creates a Scheduled Task named "TorqueCoord" that:
    - Runs at user logon
    - Restarts on failure with backoff
    - Captures stdout/stderr to %USERPROFILE%\.torque-coord\logs\torque-coord.log
    - Invokes node <repo>\server\coord\index.js

.PARAMETER RepoPath
  Path to the torque-public checkout on the workstation. Default: C:\trt\torque-public

.PARAMETER NodePath
  Path to node.exe. Default: from PATH.
#>

param(
  [string]$RepoPath = "C:\trt\torque-public",
  [string]$NodePath = ""
)

$ErrorActionPreference = "Stop"

if (-not $NodePath) {
  $NodePath = (Get-Command node).Source
}

$entry = Join-Path $RepoPath "server\coord\index.js"
if (-not (Test-Path $entry)) {
  Write-Error "Entry point not found: $entry"
  exit 1
}

$logDir = Join-Path $env:USERPROFILE ".torque-coord\logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }
$logFile = Join-Path $logDir "torque-coord.log"

$action = New-ScheduledTaskAction `
  -Execute "cmd.exe" `
  -Argument "/c `"`"$NodePath`" `"$entry`" >> `"$logFile`" 2>&1`""

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit (New-TimeSpan -Days 365)

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask `
  -TaskName "TorqueCoord" `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Torque Remote Test Coordinator daemon (port 9395, localhost only)" `
  -Force | Out-Null

Write-Host "Installed scheduled task 'TorqueCoord'."
Write-Host "Log: $logFile"
Write-Host "Start now: schtasks /run /tn TorqueCoord"
Write-Host "Health check: curl http://127.0.0.1:9395/health"
