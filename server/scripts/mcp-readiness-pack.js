const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_ARTIFACT_DIR = path.resolve(ROOT_DIR, 'artifacts', 'mcp');
const CONTROL_ARTIFACTS = {
  rbac: 'rbac-validation.json',
  rateLimit: 'rate-limit-validation.json',
  policyTools: 'policy-tools-validation.json',
  killSwitch: 'killswitch.json',
  dualAgent: 'dual-agent-validation.json',
  matrix: 'evidence-matrix-run.json',
};
const CONTROL_ALIASES = new Map(Object.keys(CONTROL_ARTIFACTS).map((key) => [key.toLowerCase(), key]));
CONTROL_ALIASES.set('ratelimit', 'rateLimit');
CONTROL_ALIASES.set('policytools', 'policyTools');
CONTROL_ALIASES.set('killswitch', 'killSwitch');
CONTROL_ALIASES.set('dualagent', 'dualAgent');

function resolveServerPath(rawPath, fallbackPath = null) {
  if (!rawPath) {
    return fallbackPath;
  }
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }

  const adjustedPath = rawPath.replace(/^\.?[\\/]*server[\\/]+/i, '');
  return path.resolve(ROOT_DIR, adjustedPath);
}

function artifactDirFromEnv(env = process.env) {
  return resolveServerPath(env.TORQUE_MCP_ARTIFACT_DIR || null, DEFAULT_ARTIFACT_DIR);
}

function baseUrlFromEnv(env = process.env) {
  const port = Number.parseInt(env.TORQUE_MCP_GATEWAY_PORT, 10);
  return env.TORQUE_MCP_GATEWAY_URL
    || `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 3459}`;
}

function resolveRequiredControls(rawValue = process.env.TORQUE_MCP_READINESS_REQUIRED) {
  if (!rawValue || String(rawValue).trim().length === 0 || String(rawValue).trim().toLowerCase() === 'all') {
    return Object.keys(CONTROL_ARTIFACTS);
  }

  const resolved = [];
  for (const token of String(rawValue).split(/[,\s]+/)) {
    const trimmed = token.trim();
    if (!trimmed || trimmed.toLowerCase() === 'health') {
      continue;
    }
    const key = CONTROL_ALIASES.get(trimmed.toLowerCase());
    if (!key) {
      throw new Error(`Unknown MCP readiness control "${trimmed}".`);
    }
    if (!resolved.includes(key)) {
      resolved.push(key);
    }
  }
  return resolved;
}

function readArtifact(name, artifactDir = artifactDirFromEnv()) {
  const p = path.join(artifactDir, name);
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

function artifactStatus(name, artifactDir = artifactDirFromEnv()) {
  const data = readArtifact(name, artifactDir);
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

function controlStatuses(artifactDir = artifactDirFromEnv()) {
  return {
    rbac: artifactStatus(CONTROL_ARTIFACTS.rbac, artifactDir),
    rateLimit: artifactStatus(CONTROL_ARTIFACTS.rateLimit, artifactDir),
    policyTools: artifactStatus(CONTROL_ARTIFACTS.policyTools, artifactDir),
    killSwitch: artifactStatus(CONTROL_ARTIFACTS.killSwitch, artifactDir),
    dualAgent: artifactStatus(CONTROL_ARTIFACTS.dualAgent, artifactDir),
    matrix: artifactStatus(CONTROL_ARTIFACTS.matrix, artifactDir),
    matrixArtifactPath: path.relative(process.cwd(), path.join(artifactDir, CONTROL_ARTIFACTS.matrix)),
  };
}

async function gatewayHealth(baseUrl = baseUrlFromEnv()) {
  try {
    const res = await fetch(`${baseUrl}/health`);
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

async function buildReport(options = {}) {
  const artifactDir = options.artifactDir || artifactDirFromEnv();
  const baseUrl = options.baseUrl || baseUrlFromEnv();
  const requiredControls = options.requiredControls || resolveRequiredControls();
  const controls = controlStatuses(artifactDir);

  const health = await gatewayHealth(baseUrl);
  const allPass = requiredControls.every((key) => controls[key] === 'pass') && health.ok;

  return {
    generated_at: new Date().toISOString(),
    baseUrl,
    artifactDir: path.relative(process.cwd(), artifactDir),
    health,
    controls,
    requiredControls,
    status: allPass ? 'pass' : 'fail',
  };
}

async function main() {
  const artifactDir = artifactDirFromEnv();
  const packPath = path.join(artifactDir, 'readiness-pack.json');
  const report = await buildReport({ artifactDir });

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(packPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`[mcp-readiness-pack] generated ${path.relative(process.cwd(), packPath)}\n`);
  process.stdout.write(`[mcp-readiness-pack] status=${report.status}\n`);

  if (report.status !== 'pass') {
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  __testables: {
    artifactDirFromEnv,
    baseUrlFromEnv,
    buildReport,
    controlStatuses,
    resolveRequiredControls,
    resolveServerPath,
  },
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[mcp-readiness-pack] FAIL ${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
