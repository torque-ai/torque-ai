$ErrorActionPreference = 'Stop'

# PowerShell entrypoint for the Bash torque-push wrapper. The Bash wrapper owns
# the push semantics; this shim only makes the command reliable from Windows
# shells.
$bashWrapper = Join-Path $PSScriptRoot 'torque-push'
if (-not (Test-Path -LiteralPath $bashWrapper -PathType Leaf)) {
  Write-Error "torque-push Bash wrapper not found next to this shim: $bashWrapper"
  exit 127
}

$candidates = @()
if ($env:GIT_BASH) {
  $candidates += $env:GIT_BASH
}
if ($env:ProgramFiles) {
  $candidates += (Join-Path $env:ProgramFiles 'Git\bin\bash.exe')
}
if (${env:ProgramFiles(x86)}) {
  $candidates += (Join-Path ${env:ProgramFiles(x86)} 'Git\bin\bash.exe')
}
$candidates += 'C:\Program Files\Git\bin\bash.exe'
$candidates += 'C:\Program Files\Git\usr\bin\bash.exe'

$bash = $null
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    $bash = $candidate
    break
  }
}

if (-not $bash) {
  $bashCommand = Get-Command bash.exe -ErrorAction SilentlyContinue
  if (-not $bashCommand) {
    $bashCommand = Get-Command bash -ErrorAction SilentlyContinue
  }
  if ($bashCommand) {
    $bash = $bashCommand.Source
  }
}

if (-not $bash) {
  Write-Error 'Git Bash was not found. Install Git for Windows or set GIT_BASH to bash.exe.'
  exit 127
}

$bashPathPrefix = ''
if ($env:TORQUE_PUSH_BASH_PATH_PREFIX) {
  $bashPathPrefix = $env:TORQUE_PUSH_BASH_PATH_PREFIX
}

$bashCommand = 'if [ "$1" != "--" ]; then PATH="$1:$PATH"; export PATH; shift; fi; shift; exec "$@"'
& $bash -lc $bashCommand 'torque-push-shim' $bashPathPrefix '--' $bashWrapper @Args
exit $LASTEXITCODE
