const db = require('../../database');
const { ErrorCodes, makeError } = require('../shared');
const { normalizePeekHealthStatus } = require('../../contracts/peek');
const { peekHttpGetUrl } = require('./shared');

async function handleRegisterPeekHost(args) {
  try {
    if (!args.name || typeof args.name !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required');
    }

    if (!args.url || typeof args.url !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'url is required');
    }

    if (args.ssh !== undefined && typeof args.ssh !== 'string') {
      return makeError(ErrorCodes.INVALID_PARAM, 'ssh must be a string');
    }

    if (args.default !== undefined && typeof args.default !== 'boolean') {
      return makeError(ErrorCodes.INVALID_PARAM, 'default must be a boolean');
    }

    if (args.platform !== undefined && !['windows', 'macos', 'linux'].includes(args.platform)) {
      return makeError(ErrorCodes.INVALID_PARAM, 'platform must be one of: windows, macos, linux');
    }

    try {
      new URL(args.url);
    } catch (err) {
      return makeError(ErrorCodes.INVALID_PARAM, `url must be a valid absolute URL: ${err.message}`);
    }

    db.registerPeekHost(args.name, args.url, args.ssh, args.default, args.platform);

    const output = [
      '## Peek Host Registered',
      '',
      `**Name:** ${args.name}`,
      `**URL:** ${args.url}`,
      `**Default:** ${args.default ? 'Yes' : 'No'}`,
      `**Platform:** ${args.platform || '-'}`,
      `**SSH:** ${args.ssh || '-'}`,
    ].join('\n');

    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleUnregisterPeekHost(args) {
  try {
    if (!args.name || typeof args.name !== 'string') {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'name is required');
    }

    const removed = db.unregisterPeekHost(args.name);
    if (!removed) {
      return makeError(ErrorCodes.INVALID_PARAM, `Peek host not found: ${args.name}`);
    }

    return {
      content: [{
        type: 'text',
        text: `## Peek Host Removed\n\n**Name:** ${args.name}`,
      }],
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handleListPeekHosts(_args) {
  try {
    const hosts = db.listPeekHosts();

    if (!hosts.length) {
      return {
        content: [{
          type: 'text',
          text: '## Peek Hosts\n\n_No peek hosts registered._',
        }],
      };
    }

    const statuses = await Promise.all(hosts.map(async (host) => {
      const health = await peekHttpGetUrl(host.url + '/health', 3000);

      if (health.error) {
        return { host, status: health.error };
      }

      if (health.status && (health.status < 200 || health.status >= 300)) {
        return { host, status: `HTTP ${health.status}` };
      }

      return {
        host,
        status: health.data && typeof health.data.status === 'string'
          ? normalizePeekHealthStatus(health.data)
          : 'healthy',
      };
    }));

    let output = '## Peek Hosts\n\n';
    output += '| Name | URL | Default | Platform | Status |\n';
    output += '|------|-----|---------|----------|--------|\n';

    for (const { host, status } of statuses) {
      output += `| ${host.name} | ${host.url} | ${host.is_default ? 'Yes' : 'No'} | ${host.platform || '-'} | ${status} |\n`;
    }

    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekHealthAll(_args) {
  try {
    const hosts = db.listPeekHosts ? db.listPeekHosts() : [];
    if (hosts.length === 0) {
      return { content: [{ type: 'text', text: 'No peek hosts registered.' }] };
    }

    const results = await Promise.all(hosts.map(async (host) => {
      const url = String(host.url).replace(/\/+$/, '') + '/health';
      const start = Date.now();
      const result = await peekHttpGetUrl(url, 5000);
      const latency = Date.now() - start;
      return {
        name: host.name,
        url: host.url,
        enabled: host.enabled !== 0,
        reachable: !result.error,
        latency_ms: result.error ? null : latency,
        version: result.data ? result.data.version : null,
        hostname: result.data ? result.data.hostname : null,
        error: result.error || null,
      };
    }));

    const lines = [
      '## Peek Host Health',
      '',
      '| Host | URL | Status | Latency | Version |',
      '|------|-----|--------|---------|---------|',
    ];
    for (const result of results) {
      const status = !result.enabled ? 'Disabled' : result.reachable ? 'Healthy' : 'Down';
      const icon = !result.enabled ? '⏸' : result.reachable ? '✅' : '❌';
      lines.push(`| ${result.name} | ${result.url} | ${icon} ${status} | ${result.latency_ms != null ? result.latency_ms + 'ms' : '-'} | ${result.version || '-'} |`);
    }
    const healthy = results.filter((result) => result.enabled && result.reachable).length;
    const total = results.filter((result) => result.enabled).length;
    lines.push('');
    lines.push(`**${healthy}/${total}** enabled hosts reachable`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

module.exports = {
  handleRegisterPeekHost,
  handleUnregisterPeekHost,
  handleListPeekHosts,
  handlePeekHealthAll,
};
