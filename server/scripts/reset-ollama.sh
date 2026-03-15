#!/bin/bash
# Reset Ollama when it becomes unresponsive
# Can be called automatically by task-manager.js or manually

echo "[$(date)] Restarting Ollama service..."

# Restart the service
sudo systemctl restart ollama

# Wait for it to come back
sleep 3

# Verify it's responding
for i in {1..10}; do
    if curl -s --connect-timeout 2 http://localhost:11434/api/tags > /dev/null 2>&1; then
        echo "[$(date)] Ollama is back online"
        exit 0
    fi
    echo "Waiting for Ollama to start... ($i/10)"
    sleep 2
done

echo "[$(date)] ERROR: Ollama failed to restart"
exit 1
