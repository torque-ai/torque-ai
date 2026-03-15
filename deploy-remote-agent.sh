#!/usr/bin/env bash
# deploy-remote-agent.sh — Deploy the TORQUE remote test agent to a remote host
#
# Steps:
#   1. Create the remote agent directory
#   2. Copy server/remote/agent-server.js via scp
#   3. Create/update the TorqueAgent scheduled task
#   4. Persist TORQUE_AGENT_SECRET and TORQUE_AGENT_PORT with setx
#   5. Start the scheduled task
#   6. Register the agent with the local TORQUE server
#   7. Verify the agent /health endpoint
#
# Usage:
#   TORQUE_AGENT_SECRET=... bash deploy-remote-agent.sh

set -euo pipefail

REMOTE_HOST="${TORQUE_AGENT_HOST:-user@192.168.1.100}"
REMOTE_DIR="${TORQUE_AGENT_DIR:-C:/Users/user/torque-agent}"
AGENT_PORT="${TORQUE_AGENT_PORT:-3460}"
AGENT_SECRET="${TORQUE_AGENT_SECRET:?TORQUE_AGENT_SECRET must be set}"
TORQUE_API_PORT="${TORQUE_API_PORT:-3457}"

TASK_NAME="TorqueAgent"
AGENT_ID="remote-agent"
AGENT_NAME="Remote-Agent"
MAX_CONCURRENT=3

log() { echo "[deploy-remote-agent] $*"; }
die() { echo "[deploy-remote-agent] ERROR: $*" >&2; exit 1; }

require_file() {
  local file="$1"
  [ -f "$file" ] || die "Required file not found: $file"
}

ps_quote() {
  printf '%s' "$1" | sed "s/'/''/g"
}

run_remote_powershell() {
  local script="$1"
  ssh "$REMOTE_HOST" "powershell -NoProfile -NonInteractive -Command \"$script\""
}

json_stringify() {
  VALUE="$1" node -e "process.stdout.write(JSON.stringify(process.env.VALUE));"
}

if [[ "$REMOTE_HOST" == *"@"* ]]; then
  REMOTE_USER="${REMOTE_HOST%@*}"
else
  REMOTE_USER="user"
fi

AGENT_HTTP_HOST="${REMOTE_HOST##*@}"
REMOTE_AGENT_FILE="${REMOTE_DIR}/agent-server.js"
REMOTE_PROJECT_PATH="C:/Users/${REMOTE_USER}/torque-agent-projects/Torque"
LOCAL_WORKDIR="$(pwd -W 2>/dev/null || pwd)"

REMOTE_DIR_PS="$(ps_quote "$REMOTE_DIR")"
TASK_NAME_PS="$(ps_quote "$TASK_NAME")"
TASK_COMMAND_PS="$(ps_quote "node ${REMOTE_AGENT_FILE}")"
AGENT_SECRET_PS="$(ps_quote "$AGENT_SECRET")"

require_file "server/remote/agent-server.js"

log "Creating remote directory ${REMOTE_DIR} ..."
run_remote_powershell "\$ErrorActionPreference = 'Stop'; New-Item -ItemType Directory -Force -Path '$REMOTE_DIR_PS' | Out-Null"

log "Copying agent server to ${REMOTE_HOST}:${REMOTE_AGENT_FILE} ..."
scp "server/remote/agent-server.js" "${REMOTE_HOST}:${REMOTE_AGENT_FILE}"

log "Creating scheduled task ${TASK_NAME} ..."
run_remote_powershell "\$ErrorActionPreference = 'Stop'; & schtasks.exe /create /tn '$TASK_NAME_PS' /tr '$TASK_COMMAND_PS' /sc onlogon /rl highest /f | Out-Null"

log "Persisting TORQUE_AGENT_SECRET and TORQUE_AGENT_PORT with setx ..."
run_remote_powershell "\$ErrorActionPreference = 'Stop'; & setx TORQUE_AGENT_SECRET '$AGENT_SECRET_PS' | Out-Null; & setx TORQUE_AGENT_PORT '$AGENT_PORT' | Out-Null"

log "Starting scheduled task ${TASK_NAME} ..."
run_remote_powershell "\$ErrorActionPreference = 'Stop'; & schtasks.exe /run /tn '$TASK_NAME_PS' | Out-Null"

log "Waiting 3 seconds for the agent to start ..."
sleep 3

log "Registering agent ${AGENT_ID} with TORQUE on http://127.0.0.1:${TORQUE_API_PORT} ..."
REGISTER_PAYLOAD="$(
  AGENT_ID="$AGENT_ID" \
  AGENT_NAME="$AGENT_NAME" \
  AGENT_HTTP_HOST="$AGENT_HTTP_HOST" \
  AGENT_PORT="$AGENT_PORT" \
  AGENT_SECRET="$AGENT_SECRET" \
  MAX_CONCURRENT="$MAX_CONCURRENT" \
  node <<'NODE'
const payload = {
  id: process.env.AGENT_ID,
  name: process.env.AGENT_NAME,
  host: process.env.AGENT_HTTP_HOST,
  port: Number(process.env.AGENT_PORT),
  secret: process.env.AGENT_SECRET,
  max_concurrent: Number(process.env.MAX_CONCURRENT),
};
process.stdout.write(JSON.stringify(payload));
NODE
)"

REGISTER_RESPONSE="$(
  printf '%s' "$REGISTER_PAYLOAD" | curl -fsS \
    -X POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "http://127.0.0.1:${TORQUE_API_PORT}/api/agents"
)"

printf '%s' "$REGISTER_RESPONSE" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const agent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!agent || !agent.id) {
    console.error("[deploy-remote-agent] Registration response did not include an agent id");
    process.exit(1);
  }
  console.log(`[deploy-remote-agent] Registered agent ${agent.id} at ${agent.host}:${agent.port}`);
});
'

log "Verifying agent health on http://${AGENT_HTTP_HOST}:${AGENT_PORT}/health ..."
HEALTH_RESPONSE="$(curl -fsS --max-time 5 \
  -H "X-Torque-Secret: ${AGENT_SECRET}" \
  "http://${AGENT_HTTP_HOST}:${AGENT_PORT}/health")"

printf '%s' "$HEALTH_RESPONSE" | node -e '
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const health = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!health || health.status !== "ok") {
    console.error(`[deploy-remote-agent] Unexpected health status: ${health && health.status}`);
    process.exit(1);
  }
  const running = `${health.running_tasks}/${health.max_concurrent}`;
  const freeMb = health.system && health.system.memory_available_mb !== undefined
    ? `${health.system.memory_available_mb}MB`
    : "n/a";
  console.log(`[deploy-remote-agent] Agent healthy | running ${running} | free memory ${freeMb}`);
});
'

AGENT_ID_JSON="$(json_stringify "$AGENT_ID")"
REMOTE_PROJECT_PATH_JSON="$(json_stringify "$REMOTE_PROJECT_PATH")"
LOCAL_WORKDIR_JSON="$(json_stringify "$LOCAL_WORKDIR")"

echo
log "Enable remote tests with:"
echo "set_project_defaults({ working_directory: ${LOCAL_WORKDIR_JSON}, prefer_remote_tests: true, remote_agent_id: ${AGENT_ID_JSON}, remote_project_path: ${REMOTE_PROJECT_PATH_JSON} })"
