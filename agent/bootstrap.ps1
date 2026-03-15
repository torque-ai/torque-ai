#Requires -RunAsAdministrator
<#
.SYNOPSIS
    One-time bootstrap script for the TORQUE remote test agent.
    Run this on the remote Windows host to install
    prerequisites, configure the agent, create a scheduled task, and start it.

.DESCRIPTION
    Steps performed:
      1. Check/install Node.js LTS via winget
      2. Check/install Git via winget
      3. Create project directory
      4. Clone torque repo (if URL provided)
      5. Generate shared secret (if not provided)
      6. Write agent/config.json
      7. Create TorqueAgent scheduled task (auto-start on logon)
      8. Start the agent immediately
      9. Print summary with registration command

.EXAMPLE
    .\bootstrap.ps1 -TorqueRepo "https://github.com/you/torque.git"
    .\bootstrap.ps1 -Secret "pre-shared-hex-string" -Port 3460
#>

param(
    [string]$ProjectRoot = (Join-Path $env:USERPROFILE "Projects"),
    [string]$TorqueRepo = "",
    [string]$Secret = "",
    [int]$Port = 3460,
    [string]$BindHost = "0.0.0.0"
)

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

function Write-Step {
    param([int]$Number, [string]$Description)
    Write-Host ""
    Write-Host "=== Step ${Number}: ${Description} ===" -ForegroundColor Cyan
}

function Test-CommandExists {
    param([string]$Command)
    $null = Get-Command $Command -ErrorAction SilentlyContinue
    return $?
}

# ---------------------------------------------------------------------------
# Step 1: Node.js LTS
# ---------------------------------------------------------------------------
Write-Step 1 "Check / install Node.js LTS"

if (Test-CommandExists "node") {
    $nodeVersion = & node --version
    Write-Host "  Node.js already installed: $nodeVersion" -ForegroundColor Green
} else {
    Write-Host "  Node.js not found. Installing via winget..." -ForegroundColor Yellow
    try {
        winget install OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        # Refresh PATH so the current session sees the new binary
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                     [System.Environment]::GetEnvironmentVariable("Path", "User")
        $nodeVersion = & node --version
        Write-Host "  Node.js installed: $nodeVersion" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: winget install failed. Please install Node.js LTS manually:" -ForegroundColor Red
        Write-Host "    https://nodejs.org/" -ForegroundColor Yellow
        Write-Host "  Error: $_" -ForegroundColor Red
    }
}

# ---------------------------------------------------------------------------
# Step 2: Git
# ---------------------------------------------------------------------------
Write-Step 2 "Check / install Git"

if (Test-CommandExists "git") {
    $gitVersion = & git --version
    Write-Host "  Git already installed: $gitVersion" -ForegroundColor Green
} else {
    Write-Host "  Git not found. Installing via winget..." -ForegroundColor Yellow
    try {
        winget install Git.Git --accept-source-agreements --accept-package-agreements
        $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                     [System.Environment]::GetEnvironmentVariable("Path", "User")
        $gitVersion = & git --version
        Write-Host "  Git installed: $gitVersion" -ForegroundColor Green
    } catch {
        Write-Host "  WARNING: winget install failed. Please install Git manually:" -ForegroundColor Red
        Write-Host "    https://git-scm.com/" -ForegroundColor Yellow
        Write-Host "  Error: $_" -ForegroundColor Red
    }
}

# ---------------------------------------------------------------------------
# Step 3: Project directory
# ---------------------------------------------------------------------------
Write-Step 3 "Create project directory"

if (Test-Path $ProjectRoot) {
    Write-Host "  Directory already exists: $ProjectRoot" -ForegroundColor Green
} else {
    New-Item -ItemType Directory -Path $ProjectRoot -Force | Out-Null
    Write-Host "  Created: $ProjectRoot" -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# Step 4: Clone torque repo
# ---------------------------------------------------------------------------
Write-Step 4 "Clone torque repository"

$torqueDir = Join-Path $ProjectRoot "torque"

if ([string]::IsNullOrWhiteSpace($TorqueRepo)) {
    Write-Host "  No -TorqueRepo URL provided, skipping clone." -ForegroundColor Yellow
    if (-not (Test-Path $torqueDir)) {
        Write-Host "  WARNING: $torqueDir does not exist. Copy the torque folder manually" -ForegroundColor Red
        Write-Host "  or re-run with -TorqueRepo <url>." -ForegroundColor Red
    } else {
        Write-Host "  Existing torque directory found: $torqueDir" -ForegroundColor Green
    }
} elseif (Test-Path $torqueDir) {
    Write-Host "  Torque directory already exists: $torqueDir (skipping clone)" -ForegroundColor Green
    Write-Host "  Running npm install to ensure dependencies are up to date..." -ForegroundColor Yellow
    Push-Location $torqueDir
    try {
        & npm install
        Write-Host "  npm install complete." -ForegroundColor Green
    } finally {
        Pop-Location
    }
} else {
    Write-Host "  Cloning $TorqueRepo into $torqueDir ..." -ForegroundColor Yellow
    & git clone $TorqueRepo $torqueDir
    Push-Location $torqueDir
    try {
        Write-Host "  Running npm install..." -ForegroundColor Yellow
        & npm install
        Write-Host "  Clone and install complete." -ForegroundColor Green
    } finally {
        Pop-Location
    }
}

# ---------------------------------------------------------------------------
# Step 5: Generate shared secret
# ---------------------------------------------------------------------------
Write-Step 5 "Generate shared secret"

if ([string]::IsNullOrWhiteSpace($Secret)) {
    Write-Host "  No -Secret provided, generating a random 32-byte hex secret..." -ForegroundColor Yellow
    $Secret = & node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    $Secret = $Secret.Trim()
}

Write-Host ""
Write-Host "  **************************************************************" -ForegroundColor Red
Write-Host "  *  SHARED SECRET (save this — you will need it on the server) *" -ForegroundColor Red
Write-Host "  *                                                              *" -ForegroundColor Red
Write-Host "  *  $Secret  " -ForegroundColor Red -NoNewline
Write-Host "*" -ForegroundColor Red
Write-Host "  *                                                              *" -ForegroundColor Red
Write-Host "  **************************************************************" -ForegroundColor Red
Write-Host ""

# ---------------------------------------------------------------------------
# Step 6: Write agent/config.json
# ---------------------------------------------------------------------------
Write-Step 6 "Write agent/config.json"

$agentDir = Join-Path $torqueDir "agent"
$configPath = Join-Path $agentDir "config.json"

# Ensure agent directory exists (in case repo wasn't cloned yet)
if (-not (Test-Path $agentDir)) {
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    Write-Host "  Created agent directory: $agentDir" -ForegroundColor Yellow
}

# Normalize ProjectRoot to forward slashes for the JSON config
$projectRootForward = $ProjectRoot -replace '\\', '/'

$config = @{
    port             = $Port
    host             = $BindHost
    secret           = $Secret
    project_root     = $projectRootForward
    allowed_commands = @("node", "npm", "npx", "git", "vitest", "tsc", "eslint", "prettier")
    max_concurrent   = 3
}

$configJson = $config | ConvertTo-Json -Depth 4
Set-Content -Path $configPath -Value $configJson -Encoding UTF8
Write-Host "  Written: $configPath" -ForegroundColor Green

# ---------------------------------------------------------------------------
# Step 7: Create scheduled task (auto-start on logon)
# ---------------------------------------------------------------------------
Write-Step 7 "Create TorqueAgent scheduled task"

$agentPath = Join-Path $agentDir "index.js"
$taskName = "TorqueAgent"

if (-not (Test-Path $agentPath)) {
    Write-Host "  WARNING: agent entry point not found at $agentPath" -ForegroundColor Red
    Write-Host "  The scheduled task will be created but may fail until the file exists." -ForegroundColor Yellow
}

try {
    $action = New-ScheduledTaskAction -Execute "node" -Argument "`"$agentPath`"" -WorkingDirectory $agentDir
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -RunLevel Highest -Force | Out-Null
    Write-Host "  Scheduled task '$taskName' registered (runs at logon as $env:USERNAME)." -ForegroundColor Green
} catch {
    Write-Host "  WARNING: Failed to create scheduled task. You may need to create it manually." -ForegroundColor Red
    Write-Host "  Error: $_" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Step 8: Start the agent now
# ---------------------------------------------------------------------------
Write-Step 8 "Start the agent"

try {
    Start-Process -FilePath "node" -ArgumentList "`"$agentPath`"" -WorkingDirectory $agentDir -NoNewWindow
    Start-Sleep -Seconds 2

    # Quick health check
    try {
        $response = Invoke-WebRequest -Uri "http://${BindHost}:${Port}/health" -TimeoutSec 5 -UseBasicParsing -ErrorAction Stop
        Write-Host "  Agent is running and responding (HTTP $($response.StatusCode))." -ForegroundColor Green
    } catch {
        Write-Host "  Agent process started but health check failed (may still be initializing)." -ForegroundColor Yellow
        Write-Host "  Verify manually: curl http://${BindHost}:${Port}/health" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  WARNING: Failed to start agent process." -ForegroundColor Red
    Write-Host "  Start it manually: node `"$agentPath`"" -ForegroundColor Yellow
    Write-Host "  Error: $_" -ForegroundColor Red
}

# ---------------------------------------------------------------------------
# Step 9: Summary
# ---------------------------------------------------------------------------
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "  Bootstrap Complete" -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Agent running at: " -NoNewline -ForegroundColor Cyan
Write-Host "http://${BindHost}:${Port}"
Write-Host "  Secret:           " -NoNewline -ForegroundColor Cyan
Write-Host "$Secret"
Write-Host "  Config:           " -NoNewline -ForegroundColor Cyan
Write-Host "$configPath"
Write-Host "  Scheduled task:   " -NoNewline -ForegroundColor Cyan
Write-Host "$taskName (runs at logon)"
Write-Host ""
Write-Host "  Next step on your TORQUE server:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    register_remote_agent { name: `"remote-gpu-host`", host: `"${BindHost}`", port: ${Port}, secret: `"${Secret}`" }" -ForegroundColor White
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
