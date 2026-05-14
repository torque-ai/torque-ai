# install-torque-watchdog.ps1 — register torque-watchdog.sh as a Windows
# Scheduled Task that fires every minute. Idempotent: re-running replaces
# the existing task. Run from a PowerShell prompt (no admin needed for
# user-scope tasks).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install-torque-watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-torque-watchdog.ps1 -Uninstall

param(
    [string]$TaskName = 'TorqueWatchdog',
    [int]$IntervalMinutes = 1,
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed scheduled task: $TaskName"
    } else {
        Write-Host "No scheduled task named $TaskName found (nothing to remove)."
    }
    exit 0
}

# Locate the watchdog script + hidden-window VBS launcher relative to this installer.
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$watchdogPath = Join-Path $scriptDir 'torque-watchdog.sh'
$vbsLauncher  = Join-Path $scriptDir 'torque-watchdog-launcher.vbs'
if (-not (Test-Path $watchdogPath)) {
    throw "watchdog script not found at $watchdogPath"
}
if (-not (Test-Path $vbsLauncher)) {
    throw "VBS launcher not found at $vbsLauncher"
}

# Resolve bash.exe — prefer Git for Windows.
$bashCandidates = @(
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files\Git\usr\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
)
$bashExe = $null
foreach ($candidate in $bashCandidates) {
    if (Test-Path $candidate) { $bashExe = $candidate; break }
}
if (-not $bashExe) {
    $bashCmd = Get-Command bash -ErrorAction SilentlyContinue
    if ($bashCmd) { $bashExe = $bashCmd.Source }
}
if (-not $bashExe) {
    throw 'bash.exe not found. Install Git for Windows or ensure bash is on PATH.'
}

# wscript.exe is the canonical Windows host for VBS launchers. Register
# the task under wscript so it runs hidden during interactive logon
# sessions — bash.exe is a console app and pops a flashing window every
# tick if scheduled directly. The VBS launcher does Shell.Run with hide=0.
$wscriptExe = Join-Path $env:SystemRoot 'System32\wscript.exe'
if (-not (Test-Path $wscriptExe)) {
    throw "wscript.exe not found at $wscriptExe"
}

$action = New-ScheduledTaskAction `
    -Execute $wscriptExe `
    -Argument "`"$vbsLauncher`" `"$bashExe`" `"$watchdogPath`""

# Run every $IntervalMinutes, indefinitely.
$trigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# Run as the current user; only when logged on (no stored password needed).
$principal = New-ScheduledTaskPrincipal `
    -UserId "$env:USERDOMAIN\$env:USERNAME" `
    -LogonType Interactive `
    -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) `
    -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Replaced existing $TaskName task."
}

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description "Detect and recover from silent TORQUE death (heartbeat-based)." | Out-Null

Write-Host "Installed scheduled task: $TaskName (every $IntervalMinutes min)"
Write-Host "  bash:      $bashExe"
Write-Host "  watchdog:  $watchdogPath"
Write-Host "  log:       `$HOME\.torque\watchdog.log"
Write-Host ""
Write-Host "To remove:  powershell -ExecutionPolicy Bypass -File `"$($MyInvocation.MyCommand.Path)`" -Uninstall"
