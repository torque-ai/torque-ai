param(
  [Parameter(Mandatory = $true)]
  [string]$ServerScript,

  [Parameter(Mandatory = $true)]
  [string]$RepoRoot,

  [Parameter(Mandatory = $true)]
  [int]$ParentPid,

  [int]$MinMajor = 24
)

$ErrorActionPreference = 'Stop'

$logDir = Join-Path $env:USERPROFILE '.torque'
$logFile = Join-Path $logDir 'restart-node24.log'

function Write-RestartLog {
  param([string]$Message)
  New-Item -ItemType Directory -Force -Path $logDir | Out-Null
  Add-Content -LiteralPath $logFile -Value "$(Get-Date -Format o) $Message"
}

function Test-NodeCandidate {
  param([string]$Candidate)

  if (-not $Candidate -or -not (Test-Path -LiteralPath $Candidate)) {
    return $null
  }

  try {
    $versionText = & $Candidate --version 2>$null
    if ($LASTEXITCODE -ne 0 -or -not $versionText) {
      return $null
    }
    if ($versionText -match '^v(?<major>\d+)\.') {
      $major = [int]$Matches.major
      if ($major -ge $MinMajor) {
        return [pscustomobject]@{
          Path = (Resolve-Path -LiteralPath $Candidate).Path
          Version = $versionText.Trim()
        }
      }
    }
  } catch {
    return $null
  }

  return $null
}

function Add-Candidate {
  param(
    [System.Collections.Generic.List[string]]$Candidates,
    [string]$Candidate
  )

  if (-not $Candidate) {
    return
  }

  $normalized = $Candidate.Trim('"')
  if ($normalized -and -not $Candidates.Contains($normalized)) {
    $Candidates.Add($normalized)
  }
}

function Resolve-NodeExecutable {
  $candidates = [System.Collections.Generic.List[string]]::new()

  Add-Candidate $candidates $env:TORQUE_NODE_EXECUTABLE
  Add-Candidate $candidates $env:TORQUE_NODE_PATH

  $localRoot = Join-Path $env:USERPROFILE '.local'
  if (Test-Path -LiteralPath $localRoot) {
    Get-ChildItem -LiteralPath $localRoot -Directory -Filter 'node-v*-win-x64' -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object {
        Add-Candidate $candidates (Join-Path $_.FullName 'node.exe')
      }
  }

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
  $env:PATH = @($userPath, $processPath, $machinePath) -join ';'

  $pathNode = Get-Command node.exe -ErrorAction SilentlyContinue
  if ($pathNode) {
    Add-Candidate $candidates $pathNode.Source
  }

  foreach ($candidate in $candidates) {
    $resolved = Test-NodeCandidate $candidate
    if ($resolved) {
      return $resolved
    }
  }

  throw "No Node.js executable >= $MinMajor found. Checked TORQUE_NODE_EXECUTABLE, TORQUE_NODE_PATH, user .local installs, and PATH."
}

function Resolve-NpmCommand {
  param([string]$NodePath)

  $nodeDir = Split-Path -Parent $NodePath
  $npmCmd = Join-Path $nodeDir 'npm.cmd'
  if (Test-Path -LiteralPath $npmCmd) {
    return $npmCmd
  }

  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) {
    return $npm.Source
  }

  throw "Could not find npm.cmd for Node at $NodePath"
}

try {
  Write-RestartLog "helper starting for parent PID $ParentPid"

  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $parent) {
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) {
    throw "Parent PID $ParentPid did not exit before timeout"
  }

  $node = Resolve-NodeExecutable
  $nodeDir = Split-Path -Parent $node.Path
  $env:PATH = "$nodeDir;$env:PATH"
  Write-RestartLog "resolved node $($node.Path) $($node.Version)"

  $serverDir = Join-Path $RepoRoot 'server'
  $npm = Resolve-NpmCommand $node.Path

  if (Test-Path -LiteralPath (Join-Path $serverDir 'package.json')) {
    Write-RestartLog "rebuilding better-sqlite3 for Node $($node.Version)"
    & $npm --prefix $serverDir rebuild better-sqlite3 *> $null
    if ($LASTEXITCODE -ne 0) {
      Write-RestartLog "better-sqlite3 rebuild failed, running npm install"
      & $npm --prefix $serverDir install --prefer-offline --no-audit --no-fund *> $null
      if ($LASTEXITCODE -ne 0) {
        throw "npm install failed after rebuild failure"
      }
      & $npm --prefix $serverDir rebuild better-sqlite3 *> $null
      if ($LASTEXITCODE -ne 0) {
        throw "better-sqlite3 rebuild failed after npm install"
      }
    }
  }

  $serverArg = '"' + $ServerScript.Replace('"', '\"') + '"'
  $child = Start-Process -FilePath $node.Path -ArgumentList $serverArg -WorkingDirectory $serverDir -WindowStyle Hidden -PassThru
  Write-RestartLog "started TORQUE successor PID $($child.Id)"
} catch {
  Write-RestartLog "ERROR: $($_.Exception.Message)"
  exit 1
}
