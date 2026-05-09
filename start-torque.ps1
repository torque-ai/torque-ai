# TORQUE Server Startup Script
# Starts the Torque MCP server in the background if not already running.
# The server provides stdio, streamable HTTP, and SSE transports.

$ServerScript = "$PSScriptRoot\server\index.js"
$DashboardUrl = "http://127.0.0.1:3456/"
$ApiVersionUrl = "http://127.0.0.1:3457/api/version"
$McpHost = "127.0.0.1"
$McpPort = 3458
$McpHttpUrl = "http://${McpHost}:${McpPort}/mcp"
$McpSseUrl = "http://${McpHost}:${McpPort}/sse"
$DefaultStartupTimeoutSeconds = 120

function Get-StartupTimeoutSeconds {
    $raw = $env:TORQUE_STARTUP_TIMEOUT_SECONDS
    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $DefaultStartupTimeoutSeconds
    }

    $parsed = 0
    if ([int]::TryParse($raw, [ref]$parsed) -and $parsed -gt 0) {
        return $parsed
    }

    Write-Host "Warning: ignoring invalid TORQUE_STARTUP_TIMEOUT_SECONDS='$raw'." -ForegroundColor Yellow
    return $DefaultStartupTimeoutSeconds
}

function Test-TcpPort {
    param(
        [string]$HostName,
        [int]$Port,
        [int]$TimeoutMilliseconds = 1000
    )

    $tcp = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $tcp.BeginConnect($HostName, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }
        $tcp.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $tcp.Close()
    }
}

function Test-HttpEndpoint {
    param([string]$Uri)

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 3
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
    } catch {
        return $false
    }
}

function Get-ServerReadiness {
    $apiReady = Test-HttpEndpoint -Uri $ApiVersionUrl
    $dashboardReady = Test-HttpEndpoint -Uri $DashboardUrl
    $mcpReady = Test-TcpPort -HostName $McpHost -Port $McpPort

    [pscustomobject]@{
        Api = $apiReady
        Dashboard = $dashboardReady
        Mcp = $mcpReady
        Ready = ($apiReady -and $dashboardReady -and $mcpReady)
    }
}

function Write-ServerUrls {
    param([int]$ProcessId)

    if ($ProcessId -gt 0) {
        Write-Host "TORQUE server started (PID: $ProcessId)" -ForegroundColor Green
    } else {
        Write-Host "TORQUE server is ready." -ForegroundColor Green
    }
    Write-Host "  Dashboard:  $DashboardUrl" -ForegroundColor Gray
    Write-Host "  REST API:   http://127.0.0.1:3457/" -ForegroundColor Gray
    Write-Host "  MCP HTTP:   $McpHttpUrl" -ForegroundColor Gray
    Write-Host "  MCP SSE:    $McpSseUrl" -ForegroundColor Gray
}

$timeout = Get-StartupTimeoutSeconds
$process = $null
$existing = Get-ServerReadiness

if ($existing.Ready) {
    Write-Host "TORQUE server is already running." -ForegroundColor Green
    Write-Host "  Dashboard:  $DashboardUrl" -ForegroundColor Gray
    Write-Host "  REST API:   http://127.0.0.1:3457/" -ForegroundColor Gray
    Write-Host "  MCP HTTP:   $McpHttpUrl" -ForegroundColor Gray
    Write-Host "  MCP SSE:    $McpSseUrl" -ForegroundColor Gray
    exit 0
}

if ($existing.Api -or $existing.Dashboard -or $existing.Mcp) {
    Write-Host "TORQUE appears to be starting; waiting for all surfaces..." -ForegroundColor Cyan
} else {
    Write-Host "Starting TORQUE server..." -ForegroundColor Cyan
    $process = Start-Process -FilePath "node" -ArgumentList $ServerScript -WorkingDirectory "$PSScriptRoot\server" -WindowStyle Hidden -PassThru
}

$elapsed = 0
$nextProgressAt = 10
while ($elapsed -lt $timeout) {
    if ($process -and $process.HasExited) {
        Write-Host "TORQUE server process exited before readiness (exit code: $($process.ExitCode))." -ForegroundColor Red
        exit 1
    }

    $readiness = Get-ServerReadiness
    if ($readiness.Ready) {
        $pid = if ($process) { $process.Id } else { 0 }
        Write-ServerUrls -ProcessId $pid
        exit 0
    }

    if ($elapsed -ge $nextProgressAt) {
        Write-Host ("Waiting for TORQUE readiness ({0}s/{1}s): API={2} Dashboard={3} MCP={4}" -f $elapsed, $timeout, $readiness.Api, $readiness.Dashboard, $readiness.Mcp) -ForegroundColor DarkGray
        $nextProgressAt += 10
    }

    Start-Sleep -Seconds 1
    $elapsed += 1
}

$finalReadiness = Get-ServerReadiness
$pidText = if ($process) { "PID: $($process.Id)" } else { "no new process started" }
Write-Host "Warning: TORQUE did not become fully ready after ${timeout}s." -ForegroundColor Yellow
Write-Host ("Readiness: API={0} Dashboard={1} MCP={2}" -f $finalReadiness.Api, $finalReadiness.Dashboard, $finalReadiness.Mcp) -ForegroundColor Yellow
Write-Host "$pidText - check $env:USERPROFILE\.torque\torque.log for errors." -ForegroundColor Yellow
exit 1
