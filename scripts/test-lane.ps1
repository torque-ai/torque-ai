param(
  [string] $Lane = "auto",

  [string] $Preset = "server-smoke",
  [string] $Command,
  [string] $CommandBase64,
  [string] $File,
  [string] $LaneRoot,
  [switch] $PrintEnv
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$NodeScript = Join-Path $ScriptDir "test-lane.js"

$argsList = @("--lane", [string]$Lane)

if ($Command) {
  $argsList += @("--command", $Command)
} elseif ($CommandBase64) {
  $argsList += @("--command-base64", $CommandBase64)
} else {
  $argsList += @("--preset", $Preset)
}

if ($File) {
  $argsList += @("--file", $File)
}

if ($LaneRoot) {
  $argsList += @("--root", $LaneRoot)
}

if ($PrintEnv) {
  $argsList += "--print-env"
}

& node $NodeScript @argsList
exit $LASTEXITCODE
