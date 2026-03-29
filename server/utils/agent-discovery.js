'use strict';

const { execFileSync } = require('child_process');

const DISCOVERY_TIMEOUT_MS = 5000;
const OLLAMA_SERVER_TIMEOUT_MS = 2000;
const OLLAMA_TAGS_URL = 'http://127.0.0.1:11434/api/tags';

const KNOWN_AGENTS = Object.freeze([
  {
    name: 'claude',
    provider: 'claude-cli',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    name: 'codex',
    provider: 'codex',
    installHint: 'npm install -g @openai/codex',
  },
  {
    name: 'gemini',
    provider: null,
    installHint: 'npm install -g @google/gemini-cli',
  },
  {
    name: 'ollama',
    provider: 'ollama',
    installHint: 'https://ollama.ai/download',
  },
  {
    name: 'aider',
    provider: null,
    installHint: 'python -m pip install aider-chat',
  },
]);

const OLLAMA_PROBE_SCRIPT = [
  "const http = require('http');",
  `const url = ${JSON.stringify(OLLAMA_TAGS_URL)};`,
  `const timeoutMs = ${OLLAMA_SERVER_TIMEOUT_MS};`,
  "const write = (payload) => { process.stdout.write(JSON.stringify(payload)); };",
  "const req = http.get(url, (res) => {",
  "  let body = '';",
  "  res.setEncoding('utf8');",
  "  res.on('data', (chunk) => { body += chunk; });",
  "  res.on('end', () => {",
  "    let models = 0;",
  "    try {",
  "      const parsed = JSON.parse(body);",
  "      models = Array.isArray(parsed.models) ? parsed.models.length : 0;",
  "    } catch {}",
  "    write({ running: true, models });",
  "  });",
  "});",
  "req.on('error', () => { write({ running: false, models: 0 }); });",
  "req.setTimeout(timeoutMs, () => { req.destroy(new Error('timeout')); });",
].join('\n');

function getLookupCommand(platform = process.platform) {
  return platform === 'win32' ? 'where' : 'which';
}

function getExecOptions(timeout = DISCOVERY_TIMEOUT_MS) {
  return {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function normalizeOutput(value) {
  return typeof value === 'string' ? value.trim() : String(value || '').trim();
}

function getFirstOutputLine(value) {
  return normalizeOutput(value)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || null;
}

function extractVersion(value) {
  const match = normalizeOutput(value).match(/\d+\.\d+(?:\.\d+)*/);
  return match ? match[0] : null;
}

function getProviderRoutingCore() {
  try {
    return require('../db/provider-routing-core');
  } catch {
    return null;
  }
}

function isProviderConfigured(provider) {
  if (!provider) {
    return false;
  }

  const providerRoutingCore = getProviderRoutingCore();
  if (!providerRoutingCore || typeof providerRoutingCore.getProvider !== 'function') {
    return false;
  }

  try {
    const config = providerRoutingCore.getProvider(provider);
    return Boolean(config && config.enabled);
  } catch {
    return false;
  }
}

function buildSuggestion(agent) {
  if (!agent.provider) {
    return null;
  }

  return `${agent.name} is installed — enable with: configure_provider({ provider: "${agent.provider}", enabled: true })`;
}

function probeOllamaServer() {
  try {
    const raw = execFileSync(
      process.execPath,
      ['-e', OLLAMA_PROBE_SCRIPT],
      getExecOptions(OLLAMA_SERVER_TIMEOUT_MS + 1000)
    );
    const parsed = JSON.parse(normalizeOutput(raw) || '{}');
    return {
      running: parsed.running === true,
      models: Number.isInteger(parsed.models) && parsed.models >= 0 ? parsed.models : 0,
    };
  } catch {
    return { running: false, models: 0 };
  }
}

function discoverInstalledAgent(agent) {
  const lookupCommand = getLookupCommand();

  try {
    const discoveredPath = getFirstOutputLine(
      execFileSync(lookupCommand, [agent.name], getExecOptions())
    );

    if (!discoveredPath) {
      throw new Error('Agent binary was not found on PATH');
    }

    let version = null;
    try {
      version = extractVersion(
        execFileSync(agent.name, ['--version'], getExecOptions())
      );
    } catch {
      version = null;
    }

    const discovered = {
      name: agent.name,
      version,
      path: discoveredPath,
      status: 'ready',
    };

    if (agent.name === 'ollama') {
      const ollamaStatus = probeOllamaServer();
      if (ollamaStatus.running) {
        discovered.status = 'running';
        discovered.models = ollamaStatus.models;
      }
    }

    return discovered;
  } catch {
    return null;
  }
}

function discoverAgents() {
  const result = {
    installed: [],
    missing: [],
    suggestions: [],
  };

  for (const agent of KNOWN_AGENTS) {
    const installedAgent = discoverInstalledAgent(agent);
    if (!installedAgent) {
      result.missing.push(agent.name);
      continue;
    }

    result.installed.push(installedAgent);

    if (agent.provider && !isProviderConfigured(agent.provider)) {
      const suggestion = buildSuggestion(agent);
      if (suggestion) {
        result.suggestions.push(suggestion);
      }
    }
  }

  return result;
}

function escapeMarkdownCell(value) {
  return String(value ?? '-')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, '<br>');
}

function isAgentConfigured(agent, suggestions) {
  return !suggestions.some((suggestion) => (
    typeof suggestion === 'string' &&
    suggestion.startsWith(`${agent.name} is installed`)
  ));
}

function findAgentDefinition(name) {
  return KNOWN_AGENTS.find((agent) => agent.name === name) || null;
}

function formatDiscoveryReport(result) {
  const installed = Array.isArray(result?.installed) ? result.installed : [];
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];

  const lines = [
    '## Agent Discovery Report',
    '',
    '### Installed',
    '| Agent | Version | Path | Status |',
    '| --- | --- | --- | --- |',
  ];

  if (installed.length === 0) {
    lines.push('| None | - | - | - |');
  } else {
    for (const agent of installed) {
      const status = agent.status === 'running' && Number.isInteger(agent.models)
        ? `running (${agent.models} models)`
        : agent.status || '-';
      lines.push(
        `| ${escapeMarkdownCell(agent.name)} | ${escapeMarkdownCell(agent.version || '-')} | ${escapeMarkdownCell(agent.path)} | ${escapeMarkdownCell(status)} |`
      );
    }
  }

  lines.push(
    '',
    '### Not Installed',
    '| Agent | Install Command |',
    '| --- | --- |'
  );

  if (missing.length === 0) {
    lines.push('| None | - |');
  } else {
    for (const name of missing) {
      const agent = findAgentDefinition(name);
      lines.push(
        `| ${escapeMarkdownCell(name)} | ${escapeMarkdownCell(agent?.installHint || '-')} |`
      );
    }
  }

  lines.push(
    '',
    '### Suggestions'
  );

  if (suggestions.length === 0) {
    lines.push('- None');
  } else {
    for (const suggestion of suggestions) {
      lines.push(`- ${suggestion}`);
    }
  }

  return lines.join('\n');
}

function createAgentDiscovery() {
  return { discoverAgents, formatDiscoveryReport };
}

module.exports = {
  getLookupCommand,
  getExecOptions,
  normalizeOutput,
  getFirstOutputLine,
  extractVersion,
  getProviderRoutingCore,
  isProviderConfigured,
  buildSuggestion,
  probeOllamaServer,
  discoverInstalledAgent,
  discoverAgents,
  escapeMarkdownCell,
  isAgentConfigured,
  formatDiscoveryReport,
  createAgentDiscovery,
};
