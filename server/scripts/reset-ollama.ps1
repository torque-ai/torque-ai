# Reset Ollama when it becomes unresponsive
# Can be called automatically by task-manager.js or manually
# Windows/PowerShell equivalent of reset-ollama.sh

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "[$timestamp] Restarting Ollama..."

# Stop any running Ollama processes
Get-Process -Name "ollama*" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Start-Sleep -Seconds 2

# Start Ollama again
Start-Process -FilePath "ollama" -ArgumentList "serve" -WindowStyle Hidden -ErrorAction SilentlyContinue

Start-Sleep -Seconds 3

# Verify it's responding
for ($i = 1; $i -le 10; $i++) {
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:11434/api/tags" -TimeoutSec 2 -UseBasicParsing -ErrorAction Stop
        if ($response.StatusCode -eq 200) {
            $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Write-Host "[$timestamp] Ollama is back online"
            exit 0
        }
    } catch {
        # Not ready yet
    }
    Write-Host "Waiting for Ollama to start... ($i/10)"
    Start-Sleep -Seconds 2
}

$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
Write-Host "[$timestamp] ERROR: Ollama failed to restart"
exit 1
