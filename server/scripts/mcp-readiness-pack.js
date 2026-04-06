const fs = require('fs');
const path = require('path');

const PORT = Number.parseInt(process.env.TORQUE_MCP_GATEWAY_PORT, 10);
const BASE_URL = process.env.TORQUE_MCP_GATEWAY_URL
  || `http://127.0.0.1:${Number.isFinite(PORT) && PORT > 0 ? PORT : 3459}`;
const ARTIFACT_DIR = path.resolve(__dirname, '..', 'artifacts', 'mcp');
const PACK_PATH = path.join(ARTIFACT_DIR, 'readiness-pack.json');

function readArtifact(name) {
  const p = path.join(ARTIFACT_DIR, name);
  try {
    const raw = fs.readFileSync(p, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function artifactStatus(name) {
  const data = readArtifact(name);
  if (!data) {
    return 'missing';
  }
  if (name === 'rate-limit-validation.json') {
    return data?.rateLimit?.status || data?.status || 'missing';
  }
  if (name === 'evidence-matrix-run.json') {
    const value = data?.status?.all ?? data?.status;
    return value === true ? 'pass' : value === false ? 'fail' : value || 'missing';
  }
  if (name === 'dual-agent-validation.json') {
    return data?.status || 'missing';
  }
  return data?.status || 'missing';
}

async function gatewayHealth() {
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.text();
    return {
      ok: res.ok,
      statusCode: res.status,
      statusText: res.statusText,
      body: body?.slice(0, 240),
    };
  } catch (error) {
    return {
      ok: false,
      statusCode: 0,
      statusText: error?.message || String(error),
      body: '',
    };
  }
}

async function main() {
  const controls = {
    rbac: artifactStatus('rbac-validation.json'),
    rateLimit: artifactStatus('rate-limit-validation.json'),
    policyTools: artifactStatus('policy-tools-validation.json'),
    killSwitch: artifactStatus('killswitch.json'),
    dualAgent: artifactStatus('dual-agent-validation.json'),
    matrix: artifactStatus('evidence-matrix-run.json'),
    matrixArtifactPath: path.relative(process.cwd(), path.join(ARTIFACT_DIR, 'evidence-matrix-run.json')),
  };

  const health = await gatewayHealth();
  const allPass = Object.entries(controls)
    .filter(([key]) => key !== 'matrixArtifactPath')
    .every(([, value]) => value === 'pass')
    && health.ok;

  const report = {
    generated_at: new Date().toISOString(),
    baseUrl: BASE_URL,
    health,
    controls,
    status: allPass ? 'pass' : 'fail',
  };

  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(PACK_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[mcp-readiness-pack] generated ${path.relative(process.cwd(), PACK_PATH)}\n`);
  process.stdout.write(`[mcp-readiness-pack] status=${report.status}\n`);

  if (!allPass) {
    process.exit(1);
  }
}

module.exports = { main };

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[mcp-readiness-pack] FAIL ${error?.message || error}\n`);
    process.exit(1);
  });
}
