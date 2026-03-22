'use strict';

const { execFileSync } = require('child_process');

const DISCOVERY_TIMEOUT_MS = 5000;
const LOOKUP_COMMAND = process.platform === 'win32' ? 'where' : 'which';

const KNOWN_AGENTS = Object.freeze([
  {
    name: 'Claude Code',
    binary: 'claude',
    provider: 'claude-cli',
    installHint: 'npm install -g @anthropic-ai/claude-code',
  },
  {
    name: 'Codex CLI',
    binary: 'codex',
    provider: 'codex',
    installHint: 'npm install -g @openai/codex',
  },
  {
    name: 'Gemini CLI',
    binary: 'gemini',
    provider: 'gemini',
    installHint: 'npm install -g @google/gemini-cli',
  },
  {
    name: 'Ollama',
    binary: 'ollama',
    provider: 'ollama',
    installHint: 'https://ollama.ai/download',
  },
  {
    name: 'Aider',
    binary: 'aider',
    provider: 'aider-ollama',
    installHint: 'pip install aider-chat',
  },
]);

function getExecOptions() {
  return {
    encoding: 'utf8',
    timeout: DISCOVERY_TIMEOUT_MS,
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
    .map(line => line.trim())
    .find(Boolean) || null;
}

function extractVersion(value) {
  const match = normalizeOutput(value).match(/\d+\.\d+(?:\.\d+)*/);
  return match ? match[0] : null;
}

function getDatabase() {
  try {
    return require('../database');
  } catch {
    return null;
  }
}

function isProviderConfigured(provider) {
  const database = getDatabase();
  if (!database || typeof database.getProvider !== 'function') {
    return false;
  }

  try {
    const config = database.getProvider(provider);
    return Boolean(config && config.enabled);
  } catch {
    return false;
  }
}

function buildSuggestion(agent, version) {
  const versionLabel = version ? ` (v${version})` : '';
  return `${agent.binary} is installed${versionLabel} but not configured — run configure_provider({ provider: "${agent.provider}", enabled: true })`;
}

function discoverInstalledAgent(agent) {
  try {
    const discoveredPath = getFirstOutputLine(
      execFileSync(LOOKUP_COMMAND, [agent.binary], getExecOptions())
    );

    if (!discoveredPath) {
      throw new Error('Agent binary was not found on PATH');
    }

    let version = null;
    try {
      version = extractVersion(
        execFileSync(agent.binary, ['--version'], getExecOptions())
      );
    } catch {
      version = null;
    }

    return {
      name: agent.name,
      binary: agent.binary,
      version,
      path: discoveredPath,
      provider: agent.provider,
    };
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
      result.missing.push({
        name: agent.name,
        binary: agent.binary,
        installHint: agent.installHint,
        provider: agent.provider,
      });
      continue;
    }

    result.installed.push(installedAgent);

    if (!isProviderConfigured(agent.provider)) {
      result.suggestions.push(buildSuggestion(agent, installedAgent.version));
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
    typeof suggestion === 'string' && (
      suggestion.includes(`provider: "${agent.provider}"`) ||
      suggestion.startsWith(`${agent.binary} is installed`)
    )
  ));
}

function formatDiscoveryReport(result) {
  const installed = Array.isArray(result?.installed) ? result.installed : [];
  const missing = Array.isArray(result?.missing) ? result.missing : [];
  const suggestions = Array.isArray(result?.suggestions) ? result.suggestions : [];

  const lines = [
    '## Agent Discovery Report',
    '',
    '### Installed',
    '| Agent | Version | Path | Provider | Status |',
    '| --- | --- | --- | --- | --- |',
  ];

  if (installed.length === 0) {
    lines.push('| None | - | - | - | - |');
  } else {
    for (const agent of installed) {
      lines.push(
        `| ${escapeMarkdownCell(agent.name)} | ${escapeMarkdownCell(agent.version || '-')} | ${escapeMarkdownCell(agent.path)} | ${escapeMarkdownCell(agent.provider)} | ${isAgentConfigured(agent, suggestions) ? 'Configured' : 'Not configured'} |`
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
    for (const agent of missing) {
      lines.push(
        `| ${escapeMarkdownCell(agent.name)} | ${escapeMarkdownCell(agent.installHint)} |`
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
  discoverAgents,
  formatDiscoveryReport,
  createAgentDiscovery,
};
