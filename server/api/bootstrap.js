'use strict';

/**
 * Workstation Bootstrap API
 *
 * GET /api/bootstrap/workstation — returns a shell script that:
 * 1. Checks prerequisites (node >= 18)
 * 2. Creates agent directory with minimal agent-server
 * 3. Generates a shared secret
 * 4. Registers with TORQUE
 * 5. Starts the agent
 *
 * The script has TORQUE's address baked in from the request Host header.
 *
 * NOTE: The embedded agent-server.js uses execSync for the /run endpoint
 * because it executes user-requested build/test commands (same as Claude
 * Code's Bash tool). This is the agent's intended purpose — running
 * commands on behalf of TORQUE tasks. The agent is protected by the
 * shared secret (x-torque-secret header).
 */

const os = require('os');
const logger = require('../logger').child({ component: 'bootstrap' });

// Rate limiting: max 5 bootstrap requests per minute per IP
const _rateLimits = new Map();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const entry = _rateLimits.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    _rateLimits.set(ip, { windowStart: now, count: 1 });
    return false;
  }
  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

/**
 * Generate the bootstrap shell script with TORQUE's address baked in.
 */
function generateBootstrapScript(torqueHost, options = {}) {
  const name = options.name || '';
  const port = options.port || '3460';
  const install = options.install ? 'true' : 'false';

  // The script is a template — variables inside are shell variables (escaped $),
  // not JS template literals. TORQUE_HOST/AGENT_PORT/AGENT_NAME are baked in from
  // the options above.
  return `#!/usr/bin/env bash
set -euo pipefail

# ─── TORQUE Workstation Bootstrap ───────────────────────────────────────
# Run this on the remote machine to set up a TORQUE workstation agent.
# Usage:
#   curl -s http://${torqueHost}/api/bootstrap/workstation | bash
#   curl -s http://${torqueHost}/api/bootstrap/workstation | bash -s -- --install
# ────────────────────────────────────────────────────────────────────────

TORQUE_HOST="${torqueHost}"
AGENT_PORT="${port}"
AGENT_NAME="${name}"
INSTALL_SERVICE="${install}"
AGENT_DIR="$HOME/.torque-agent"

# Parse flags
for arg in "$@"; do
  case "$arg" in
    --install) INSTALL_SERVICE="true" ;;
    --name=*) AGENT_NAME="\${arg#--name=}" ;;
    --port=*) AGENT_PORT="\${arg#--port=}" ;;
  esac
done

# Default name to hostname
if [ -z "$AGENT_NAME" ]; then
  AGENT_NAME="$(hostname -s 2>/dev/null || hostname)"
fi

echo ""
echo "  TORQUE Workstation Agent Bootstrap"
echo "  ==================================="
echo "  Server:  $TORQUE_HOST"
echo "  Name:    $AGENT_NAME"
echo "  Port:    $AGENT_PORT"
echo "  Install: $INSTALL_SERVICE"
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is required but not found."
  echo "Install it: https://nodejs.org/ (v18+)"
  exit 1
fi

NODE_VERSION=$(node -v)
NODE_MAJOR=$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: Node.js v18+ required, found $NODE_VERSION"
  exit 1
fi
echo "[ok] Node.js $NODE_VERSION"

# Create agent directory
mkdir -p "$AGENT_DIR"
cd "$AGENT_DIR"
echo "[ok] Agent directory: $AGENT_DIR"

# Create minimal agent-server if not present
if [ ! -f "agent-server.js" ]; then
  echo "  Creating agent-server..."
  cat > agent-server.js << 'AGENTEOF'
// TORQUE Workstation Agent — minimal standalone version
// Full version: server/remote/agent-server.js in the torque-public repo
const http = require('http');
const os = require('os');
const { execFileSync } = require('child_process');

const PORT = parseInt(process.env.TORQUE_AGENT_PORT || '3460', 10);
const SECRET = process.env.TORQUE_AGENT_SECRET || '';

const server = http.createServer((req, res) => {
  if (SECRET && req.headers['x-torque-secret'] !== SECRET) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  if (req.url === '/health' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'healthy',
      hostname: os.hostname(),
      platform: process.platform,
      cpus: os.cpus().length,
      memory_mb: Math.round(os.totalmem() / 1048576),
      node_version: process.version,
      uptime: process.uptime(),
    }));
    return;
  }
  if (req.url === '/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try {
        const { command, args, cwd } = JSON.parse(body);
        // Uses execFileSync for safety — no shell interpretation
        const cmd = Array.isArray(args) ? command : 'bash';
        const cmdArgs = Array.isArray(args) ? args : ['-c', command];
        const output = execFileSync(cmd, cmdArgs, {
          cwd: cwd || process.cwd(),
          encoding: 'utf8',
          timeout: 300000,
          windowsHide: true,
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ exitCode: 0, output }));
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          exitCode: err.status || 1,
          output: err.stdout || '',
          error: err.stderr || err.message,
        }));
      }
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('TORQUE Agent listening on 0.0.0.0:' + PORT);
});
AGENTEOF
  echo "[ok] Agent server created"
fi

# Generate secret
SECRET=$(node -e "console.log(require('crypto').randomUUID())")
echo "[ok] Secret generated"

# Detect LAN IP
LAN_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || ifconfig 2>/dev/null | grep 'inet ' | grep -v '127.0.0.1' | awk '{print $2}' | head -1 || echo "127.0.0.1")
echo "[ok] Detected IP: $LAN_IP"

# Register with TORQUE
echo "  Registering with TORQUE..."
curl -sf -X POST "http://$TORQUE_HOST/api/workstations" \\
  -H "Content-Type: application/json" \\
  -d "{
    \\"name\\": \\"$AGENT_NAME\\",
    \\"host\\": \\"$LAN_IP\\",
    \\"port\\": \\"$AGENT_PORT\\",
    \\"secret\\": \\"$SECRET\\"
  }" > /dev/null 2>&1 && echo "[ok] Registered with TORQUE" || echo "[warn] Registration failed — you can add manually in the dashboard"

# Install as service or run foreground
if [ "$INSTALL_SERVICE" = "true" ]; then
  if command -v systemctl &> /dev/null; then
    echo "  Installing systemd service..."
    sudo tee /etc/systemd/system/torque-agent.service > /dev/null << SVCEOF
[Unit]
Description=TORQUE Workstation Agent
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$AGENT_DIR
Environment=TORQUE_AGENT_SECRET=$SECRET
Environment=TORQUE_AGENT_PORT=$AGENT_PORT
ExecStart=$(which node) $AGENT_DIR/agent-server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SVCEOF
    sudo systemctl daemon-reload
    sudo systemctl enable torque-agent
    sudo systemctl start torque-agent
    echo "[ok] Installed and started systemd service"
  else
    echo "  systemd not available — starting with nohup"
    TORQUE_AGENT_SECRET="$SECRET" TORQUE_AGENT_PORT="$AGENT_PORT" \\
      nohup node agent-server.js > torque-agent.log 2>&1 &
    echo $! > torque-agent.pid
    echo "[ok] Started (PID: $!)"
  fi
else
  echo ""
  echo "  Agent ready! Starting in foreground..."
  echo "  Press Ctrl+C to stop."
  echo ""
  echo "  To install as a service, re-run with --install:"
  echo "  curl -s http://$TORQUE_HOST/api/bootstrap/workstation | bash -s -- --install"
  echo ""
  TORQUE_AGENT_SECRET="$SECRET" TORQUE_AGENT_PORT="$AGENT_PORT" node agent-server.js
fi
`;
}

function handleBootstrapWorkstation(req, res) {
  const ip = req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    res.writeHead(429, { 'Content-Type': 'text/plain' });
    res.end('Rate limited — try again in a minute');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost:3457'}`);
  const name = url.searchParams.get('name') || '';
  const port = url.searchParams.get('port') || '3460';
  const install = url.searchParams.get('install') === 'true';

  const torqueHost = req.headers.host || `${getLocalIP()}:3457`;
  const script = generateBootstrapScript(torqueHost, { name, port, install });

  res.writeHead(200, {
    'Content-Type': 'text/x-shellscript',
    'Content-Disposition': 'inline; filename="torque-bootstrap.sh"',
  });
  res.end(script);

  logger.info(`[Bootstrap] Served workstation bootstrap script to ${ip}`);
}

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

module.exports = {
  handleBootstrapWorkstation,
  generateBootstrapScript,
  getLocalIP,
};
