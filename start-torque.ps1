# TORQUE Server Startup Script
# Starts the Torque MCP server in the background if not already running.
# The server provides both stdio and SSE transports.
# SSE endpoint: http://127.0.0.1:3458/sse

$ServerScript = "$PSScriptRoot\server\index.js"

# Check if already running by testing the SSE port
try {
    $tcp = New-Object System.Net.Sockets.TcpClient
    $tcp.Connect("127.0.0.1", 3458)
    $tcp.Close()
    Write-Host "TORQUE server is already running on port 3458." -ForegroundColor Green
    exit 0
} catch {
    # Port not listening - need to start
}

Write-Host "Starting TORQUE server..." -ForegroundColor Cyan
$process = Start-Process -FilePath "node" -ArgumentList $ServerScript -WorkingDirectory "$PSScriptRoot\server" -WindowStyle Hidden -PassThru

# Wait for SSE port to become available
$timeout = 10
$elapsed = 0
while ($elapsed -lt $timeout) {
    Start-Sleep -Milliseconds 500
    $elapsed += 0.5
    try {
        $tcp = New-Object System.Net.Sockets.TcpClient
        $tcp.Connect("127.0.0.1", 3458)
        $tcp.Close()
        Write-Host "TORQUE server started (PID: $($process.Id))" -ForegroundColor Green
        Write-Host "  Dashboard:  http://127.0.0.1:3456/" -ForegroundColor Gray
        Write-Host "  REST API:   http://127.0.0.1:3457/" -ForegroundColor Gray
        Write-Host "  MCP SSE:    http://127.0.0.1:3458/sse" -ForegroundColor Gray
        exit 0
    } catch {
        # Not ready yet
    }
}

Write-Host "Warning: Server started but SSE port not responding after ${timeout}s." -ForegroundColor Yellow
Write-Host "PID: $($process.Id) - check torque-debug.log for errors." -ForegroundColor Yellow
