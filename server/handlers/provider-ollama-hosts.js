/**
 * Ollama host management handlers
 * Extracted from provider-handlers.js
 */

const os = require('os');
const configCore = require('../db/config-core');
const hostManagement = require('../db/host-management');
const providerRoutingCore = require('../db/provider/routing-core');
const taskManager = require('../task-manager');
const logger = require('../logger').child({ component: 'provider-ollama-hosts' });
const { TASK_TIMEOUTS } = require('../constants');
const { ErrorCodes, makeError, probeOllamaEndpoint } = require('./shared');
const serverConfig = require('../config');

/**
 * List available Ollama models
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleListOllamaModels(args) {
  try {
  
  const http = require('http');
  const https = require('https');

  // Check if multi-host is configured
  const hosts = hostManagement.listOllamaHosts();

  if (hosts.length > 0 && !args.host) {
    // Multi-host mode: show aggregated models
    const aggregatedModels = hostManagement.getAggregatedModels();

    if (aggregatedModels.length === 0) {
      let output = `## No Models Found (Multi-Host)\n\n`;
      output += `No models are available on any configured Ollama hosts.\n\n`;
      output += `Use \`refresh_host_models\` to fetch model lists, or \`ollama pull <model>\` on each host.`;
      return { content: [{ type: 'text', text: output }] };
    }

    let output = `## Available Ollama Models (Multi-Host)\n\n`;
    output += `| Model | Size | Available On |\n`;
    output += `|-------|------|---------------|\n`;

    for (const model of aggregatedModels) {
      const sizeGB = model.size ? (model.size / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : 'N/A';
      const hostNames = model.hosts.map(h => h.name).join(', ');
      output += `| ${model.name} | ${sizeGB} | ${hostNames} |\n`;
    }

    output += `\n**Total:** ${aggregatedModels.length} unique model(s) across ${hosts.filter(h => h.enabled).length} host(s)\n\n`;
    output += `### Load Balancing\n`;
    output += `When you request a model, Torque automatically selects the least-loaded host that has it.\n\n`;
    output += `### Per-Host Details\n`;
    output += `Use \`list_ollama_hosts\` to see detailed status of each host.`;

    return { content: [{ type: 'text', text: output }] };
  }
  

  // Single-host mode (or explicit host override)
  const ollamaHost = args.host || serverConfig.get('ollama_host') || 'http://localhost:11434';
  const url = new URL('/api/tags', ollamaHost);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const req = client.get(url.toString(), { timeout: TASK_TIMEOUTS.PROVIDER_CHECK }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          const models = result.models || [];

          if (models.length === 0) {
            resolve({
              content: [{
                type: 'text',
                text: `## No Models Found\n\nNo models are installed on the Ollama instance at \`${ollamaHost}\`.\n\nUse \`ollama pull <model>\` to download models.`
              }]
            });
            return;
          }

          let output = `## Available Ollama Models\n\n`;
          output += `**Host:** \`${ollamaHost}\`\n\n`;
          output += `| Model | Size | Modified |\n`;
          output += `|-------|------|----------|\n`;

          for (const model of models) {
            const sizeGB = (model.size / (1024 * 1024 * 1024)).toFixed(2);
            const modified = model.modified_at ? new Date(model.modified_at).toLocaleDateString() : 'N/A';
            output += `| ${model.name} | ${sizeGB} GB | ${modified} |\n`;
          }

          output += `\n**Total:** ${models.length} model(s)\n\n`;
          output += `### Usage\n`;
          output += `Use these models with the \`ollama\` provider:\n`;
          output += `- \`submit_task\` with \`provider: "ollama"\` and \`model: "<model_name>"\`\n`;
          output += `- \`smart_submit_task\` to let routing pick the best enabled provider for the job`;

          resolve({ content: [{ type: 'text', text: output }] });
        } catch (e) {
          resolve({
            content: [{
              type: 'text',
              text: `## Error Parsing Response\n\nFailed to parse Ollama response: ${e.message}\n\nRaw response:\n\`\`\`\n${data.substring(0, 500)}\n\`\`\``
            }]
          });
        }
      });
    });

    req.on('error', (e) => {
      resolve({
        content: [{
          type: 'text',
          text: `## Connection Error\n\nFailed to connect to Ollama at \`${ollamaHost}\`.\n\n**Error:** ${e.message}\n\n### Troubleshooting\n- Ensure Ollama is running: \`ollama serve\`\n- Check the host configuration: \`get_config\` with key \`ollama_host\`\n- For WSL: Ensure firewall allows port 11434`
        }]
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        content: [{
          type: 'text',
          text: `## Connection Timeout\n\nConnection to Ollama at \`${ollamaHost}\` timed out after 10 seconds.\n\n### Troubleshooting\n- Check if Ollama is running\n- Verify network connectivity\n- For remote hosts, check firewall settings`
        }]
      });
    });
  });
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Check Ollama health and report status
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleCheckOllamaHealth(args) {
  try {
  
  const { force_check = true } = args;
  

  const fallbackProvider = serverConfig.get('ollama_fallback_provider') || 'codex';

  // Check if multi-host is configured
  const hosts = hostManagement.listOllamaHosts();

  if (hosts.length > 0) {
    // Multi-host mode: check all hosts
    let output = `## Ollama Health Status (Multi-Host)\n\n`;

    // Check health of all enabled hosts
    const enabledHosts = hosts.filter(h => h.enabled);
    for (const host of enabledHosts) {
      if (force_check) {
        await checkHostHealth(host.id);
      }
    }

    // Auto-disable hosts that have been down for 24+ hours
    const staleDisabled = hostManagement.disableStaleHosts(24);
    if (staleDisabled > 0) {
      logger.info(`Auto-disabled ${staleDisabled} stale host(s)`);
    }

    // Refresh host list after health checks
    const updatedHosts = hostManagement.listOllamaHosts();
    const healthyCount = updatedHosts.filter(h => h.enabled && h.status === 'healthy').length;
    const totalEnabled = updatedHosts.filter(h => h.enabled).length;

    // Update the Ollama health cache used by routing
    // This ensures routing knows Ollama is available after health checks
    providerRoutingCore.setOllamaHealthy(healthyCount > 0);

    output += `| Setting | Value |\n`;
    output += `|---------|-------|\n`;
    output += `| Mode | **Multi-Host Load Balancing** |\n`;
    output += `| Hosts | ${healthyCount}/${totalEnabled} healthy |\n`;
    output += `| Fallback Provider | ${fallbackProvider} |\n`;
    output += `| Smart Routing | ${serverConfig.getBool('smart_routing_enabled') ? 'Enabled' : 'Disabled'} |\n\n`;

    const hostActivity = taskManager.getHostActivity();

    output += `### Host Status\n\n`;
    output += `| Host | URL | Status | Load | Models | VRAM |\n`;
    output += `|------|-----|--------|------|--------|------|\n`;

    for (const host of updatedHosts) {
      const statusIcon = host.status === 'healthy' ? '✅' :
                         host.status === 'degraded' ? '⚠️' :
                         host.status === 'down' ? '❌' : '❓';
      const enabled = host.enabled ? '' : ' (disabled)';
      const modelCount = host.models?.length || 0;

      const activity = hostActivity[host.id];
      let vramStr = '-';
      if (activity) {
        const gpu = activity.gpuMetrics;
        if (gpu && gpu.vramTotalMb > 0) {
          const usedGb = (gpu.vramUsedMb / 1024).toFixed(1);
          const totalGb = (gpu.vramTotalMb / 1024).toFixed(1);
          vramStr = `${usedGb}/${totalGb} GB`;
        } else if (activity.totalVramUsed > 0) {
          const usedGb = (activity.totalVramUsed / (1024 * 1024 * 1024)).toFixed(1);
          vramStr = `${usedGb} GB loaded`;
        }
      }

      output += `| ${host.name}${enabled} | \`${host.url}\` | ${statusIcon} ${host.status} | ${host.running_tasks} | ${modelCount} | ${vramStr} |\n`;
    }

    if (healthyCount === 0) {
      output += `\n### ⚠️ No Healthy Hosts\n`;
      output += `All Ollama hosts are unavailable. Tasks will fall back to **${fallbackProvider}**.\n`;
    } else {
      output += `\n### Routing Behavior\n`;
      output += `- Tasks are load-balanced across healthy hosts\n`;
      output += `- Least-loaded host with the requested model is selected\n`;
    }

    const structuredData = {
      healthy_count: healthyCount,
      total_count: totalEnabled,
      hosts: updatedHosts.map(h => ({
        name: h.name,
        url: h.url,
        status: h.status,
        running_tasks: h.running_tasks || 0,
        models_count: h.models?.length || 0,
      })),
    };

    return { content: [{ type: 'text', text: output }], structuredData };
  }

  // Single-host mode (backwards compatible)
  const ollamaHost = serverConfig.get('ollama_host') || 'http://localhost:11434';

  // Run health check
  const healthy = await providerRoutingCore.checkOllamaHealth(force_check);

  let output = `## Ollama Health Status\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Host | \`${ollamaHost}\` |\n`;
  output += `| Status | ${healthy ? '✅ **Healthy**' : '❌ **Unavailable**'} |\n`;
  output += `| Fallback Provider | ${fallbackProvider} |\n`;
  output += `| Smart Routing | ${serverConfig.getBool('smart_routing_enabled') ? 'Enabled' : 'Disabled'} |\n\n`;

  if (healthy) {
    output += `### Routing Behavior\n`;
    output += `- Local LLM tasks will be routed to the \`ollama\` provider\n`;
    output += `- Use \`smart_submit_task\` for automatic provider selection\n`;
  } else {
    output += `### Fallback Active\n`;
    output += `- Ollama is not reachable at \`${ollamaHost}\`\n`;
    output += `- Tasks that would use local LLM will automatically fall back to **${fallbackProvider}**\n`;
    output += `- Health is re-checked every 30 seconds\n\n`;
    output += `### Troubleshooting\n`;
    output += `- Ensure Ollama is running: \`ollama serve\`\n`;
    output += `- Check host configuration: \`get_config\` with key \`ollama_host\`\n`;
    output += `- For remote hosts, verify network connectivity and firewall rules\n`;
  }

  output += `\n### Multi-Host Mode\n`;
  output += `To enable load balancing across multiple Ollama instances:\n`;
  output += `\`\`\`\n`;
  output += `add_ollama_host id="local" name="Local GPU" url="http://localhost:11434"\n`;
  output += `add_ollama_host id="remote" name="Remote 3090" url="http://192.0.2.100:11434"\n`;
  output += `\`\`\``;

  const structuredData = {
    healthy_count: healthy ? 1 : 0,
    total_count: 1,
    hosts: [{
      name: 'default',
      url: ollamaHost,
      status: healthy ? 'healthy' : 'down',
      running_tasks: 0,
      models_count: 0,
    }],
  };

  return { content: [{ type: 'text', text: output }], structuredData };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


// ============================================================
// Multi-Host Ollama Load Balancing Handlers
// ============================================================

/**
 * Add a new Ollama host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleAddOllamaHost(args) {
  const url = typeof args.url === 'string' ? args.url.trim() : '';
  let { name } = args;
  if (!url) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'url is required and must be a non-empty string');
  }

  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return makeError(ErrorCodes.INVALID_URL, 'Invalid URL protocol: URL must start with http:// or https://');
  }

  // Validate URL format and generate ID from URL if not provided
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return makeError(ErrorCodes.INVALID_URL, `Invalid URL format: ${url}`);
  }

  // Auto-detect hostname if not provided
  if (!name) {
    const host = parsedUrl.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
      // Local machine - use actual hostname
      name = os.hostname();
    } else {
      // Remote machine - use IP/hostname from URL
      name = host;
    }
  }

  // Auto-generate ID from hostname/IP if not provided
  const id = args.id || `host-${parsedUrl.hostname.replace(/\./g, '-')}`;

  // Convert memory limit from GB to MB (default 8GB if not specified)
  const memoryLimitMb = args.memory_limit_gb ? Math.round(args.memory_limit_gb * 1024) : undefined;

  // Check if host already exists
  const existing = hostManagement.getOllamaHost(id);
  if (existing) {
    return {
      ...makeError(ErrorCodes.CONFLICT, `Host with ID '${id}' already exists. Use a different ID or remove the existing host first.`)
    };
  }

  try {
    const host = hostManagement.addOllamaHost({ id, name, url, memory_limit_mb: memoryLimitMb });

    // Persist gpu_metrics_port if provided
    if (args.gpu_metrics_port) {
      hostManagement.updateOllamaHost(id, { gpu_metrics_port: args.gpu_metrics_port });
    }

    // Persist default_model if provided
    if (args.default_model) {
      hostManagement.updateOllamaHost(id, { default_model: args.default_model });
    }
    const memoryLimitGb = host.memory_limit_mb ? (host.memory_limit_mb / 1024).toFixed(1) : 'Not set';

    let output = `## Ollama Host Added\n\n`;
    output += `| Field | Value |\n`;
    output += `|-------|-------|\n`;
    output += `| ID | \`${host.id}\` |\n`;
    output += `| Name | ${host.name} |\n`;
    output += `| URL | \`${host.url}\` |\n`;
    output += `| Memory Limit | ${memoryLimitGb} GB |\n`;
    output += `| Status | ${host.status} |\n`;
    output += `| Enabled | ${host.enabled ? 'Yes' : 'No'} |\n`;
    if (args.gpu_metrics_port) {
      output += `| GPU Metrics Port | ${args.gpu_metrics_port} |\n`;
    }
    if (args.default_model) {
      output += `| Default Model | ${args.default_model} |\n`;
    }
    output += `\n`;
    output += `Use \`refresh_host_models host_id="${id}"\` to fetch available models.`;

    return { content: [{ type: 'text', text: output }] };
  } catch (e) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `Failed to add host: ${e.message}`)
    };
  }
}


/**
 * Remove an Ollama host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleRemoveOllamaHost(args) {
  const { host_id } = args;

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  if (host.running_tasks > 0) {
    return {
      ...makeError(ErrorCodes.CONFLICT, `Cannot remove host '${host_id}' - it has ${host.running_tasks} running task(s). Wait for tasks to complete or cancel them first.`)
    };
  }

  hostManagement.removeOllamaHost(host_id);

  let output = `## Ollama Host Removed\n\n`;
  output += `Host **${host.name}** (\`${host_id}\`) has been removed from the pool.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Cleanup hosts with null or empty IDs (database corruption fix)
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleCleanupNullIdHosts(_args) {
  const deletedCount = hostManagement.cleanupNullIdHosts();

  let output = `## Null ID Host Cleanup\n\n`;
  if (deletedCount === 0) {
    output += `No hosts with null or empty IDs found. Database is clean.`;
  } else {
    output += `Removed **${deletedCount}** host(s) with null or empty IDs.\n\n`;
    output += `This fixes database corruption from hosts that were added without explicit IDs.`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * List all Ollama hosts
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleListOllamaHosts(args) {
  const { enabled_only = false } = args;

  const hosts = hostManagement.listOllamaHosts(enabled_only ? { enabled: true } : {});

  if (hosts.length === 0) {
    let output = `## No Ollama Hosts Configured\n\n`;
    output += `Use \`add_ollama_host\` to register Ollama instances for load balancing.\n\n`;
    output += `**Example:**\n`;
    output += `\`\`\`\n`;
    output += `add_ollama_host id="local" name="Local GPU" url="http://localhost:11434"\n`;
    output += `add_ollama_host id="remote" name="Remote 3090" url="http://192.0.2.100:11434"\n`;
    output += `\`\`\``;
    return {
      content: [{ type: 'text', text: output }],
      structuredData: { count: 0, hosts: [] },
    };
  }

  // Get live activity data (VRAM, loaded models, GPU metrics)
  const hostActivity = taskManager.getHostActivity();

  let output = `## Ollama Hosts (${hosts.length})\n\n`;
  output += `| ID | Name | Status | Load | Models | VRAM Used | Mem Limit | URL |\n`;
  output += `|----|------|--------|------|--------|-----------|-----------|-----|\n`;

  for (const host of hosts) {
    const statusIcon = host.status === 'healthy' ? '✅' :
                       host.status === 'degraded' ? '⚠️' :
                       host.status === 'down' ? '❌' : '❓';
    const modelCount = host.models?.length || 0;
    const enabled = host.enabled ? '' : ' (disabled)';
    const memLimit = host.memory_limit_mb
      ? `${(host.memory_limit_mb / 1024).toFixed(0)} GB`
      : 'None';

    // VRAM info from activity cache (/api/ps polling + nvidia-smi for local)
    const activity = hostActivity[host.id];
    let vramStr = '-';
    if (activity) {
      const gpu = activity.gpuMetrics;
      if (gpu && gpu.vramTotalMb > 0) {
        // Local host with nvidia-smi data: show used/total
        const usedGb = (gpu.vramUsedMb / 1024).toFixed(1);
        const totalGb = (gpu.vramTotalMb / 1024).toFixed(1);
        const pct = Math.round((gpu.vramUsedMb / gpu.vramTotalMb) * 100);
        vramStr = `${usedGb}/${totalGb} GB (${pct}%)`;
      } else if (activity.totalVramUsed > 0) {
        // Remote host: show model VRAM from /api/ps
        const usedGb = (activity.totalVramUsed / (1024 * 1024 * 1024)).toFixed(1);
        vramStr = `${usedGb} GB loaded`;
      }
    }

    output += `| ${host.id} | ${host.name}${enabled} | ${statusIcon} ${host.status} | ${host.running_tasks} tasks | ${modelCount} | ${vramStr} | ${memLimit} | \`${host.url}\` |\n`;
  }

  output += `\n### Legend\n`;
  output += `- ✅ healthy - Host is responding normally\n`;
  output += `- ⚠️ degraded - Host has failed 1-2 health checks\n`;
  output += `- ❌ down - Host has failed 3+ checks (manual recovery required)\n`;
  output += `- ❓ unknown - Not yet checked\n`;
  output += `- **Mem Limit**: Max model size (with 15% overhead) to prevent OOM\n`;

  const structuredHosts = hosts.map(host => ({
    id: host.id,
    name: host.name,
    url: host.url,
    status: host.status || 'unknown',
    enabled: Boolean(host.enabled),
    running_tasks: host.running_tasks || 0,
    max_concurrent: host.max_concurrent || 0,
    memory_limit_mb: host.memory_limit_mb || null,
    default_model: host.default_model || null,
    models: Array.isArray(host.models) ? host.models.map(m => typeof m === 'string' ? m : m.name || String(m)) : [],
  }));

  return {
    content: [{ type: 'text', text: output }],
    structuredData: {
      count: hosts.length,
      hosts: structuredHosts,
    },
  };
}


/**
 * Enable an Ollama host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleEnableOllamaHost(args) {
  const { host_id } = args;

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  hostManagement.enableOllamaHost(host_id);

  return {
    content: [{ type: 'text', text: `Host **${host.name}** (\`${host_id}\`) has been enabled.` }]
  };
}


/**
 * Disable an Ollama host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleDisableOllamaHost(args) {
  const { host_id } = args;

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  hostManagement.disableOllamaHost(host_id);

  return {
    content: [{ type: 'text', text: `Host **${host.name}** (\`${host_id}\`) has been disabled. It will not receive new tasks.` }]
  };
}


/**
 * Recover a downed Ollama host
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleRecoverOllamaHost(args) {
  try {
  
  const { host_id } = args;
  

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  // Reset the host status
  hostManagement.recoverOllamaHost(host_id);

  // Trigger immediate health check
  const healthy = await checkHostHealth(host_id);

  let output = `## Host Recovery: ${host.name}\n\n`;
  output += `| Field | Value |\n`;
  output += `|-------|-------|\n`;
  output += `| Host ID | \`${host_id}\` |\n`;
  output += `| Previous Status | ${host.status} |\n`;
  output += `| Failures Reset | ${host.consecutive_failures} → 0 |\n`;
  output += `| Health Check | ${healthy ? '✅ Passed' : '❌ Failed'} |\n`;

  const updatedHost = hostManagement.getOllamaHost(host_id);
  output += `| Current Status | ${updatedHost.status} |\n`;

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Refresh models for a host or all hosts
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleRefreshHostModels(args) {
  try {
  
  const { host_id } = args;
  

  if (host_id) {
    const host = hostManagement.getOllamaHost(host_id);
    if (!host) {
      return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
    }

    const healthy = await checkHostHealth(host_id);
    const updatedHost = hostManagement.getOllamaHost(host_id);
    const hostModels = Array.isArray(updatedHost?.models) ? updatedHost.models : [];

    let output = `## Model Refresh: ${host.name}\n\n`;
    if (healthy) {
      output += `**Status:** ✅ Success\n\n`;
      output += `**Models (${hostModels.length}):**\n`;
      for (const model of hostModels) {
        if (!model || typeof model !== 'object') {
          output += '- Unknown model payload\n';
          continue;
        }

        const modelName = model.name || 'Unknown model';
        const modelSize = typeof model.size === 'number' ? model.size : Number(model.size);
        if (!Number.isFinite(modelSize) || modelSize < 0) {
          output += `- ${modelName} (size unavailable)\n`;
          continue;
        }

        const sizeMB = (modelSize / 1024 / 1024 / 1024).toFixed(2);
        output += `- ${modelName} (${sizeMB} GB)\n`;
      }
    } else {
      output += `**Status:** ❌ Failed to connect\n`;
      output += `Host at \`${host.url}\` is not responding.`;
    }

    return { content: [{ type: 'text', text: output }] };
  }

  // Refresh all hosts
  const hosts = hostManagement.listOllamaHosts({ enabled: true });
  const results = [];

  for (const host of hosts) {
    const healthy = await checkHostHealth(host.id);
    const updatedHost = hostManagement.getOllamaHost(host.id);
    const hostModels = Array.isArray(updatedHost?.models) ? updatedHost.models : [];
    results.push({
      id: host.id,
      name: host.name,
      healthy,
      modelCount: hostModels.length
    });
  }

  let output = `## Model Refresh: All Hosts\n\n`;
  output += `| Host | Status | Models |\n`;
  output += `|------|--------|--------|\n`;
  for (const r of results) {
    output += `| ${r.name} | ${r.healthy ? '✅' : '❌'} | ${r.modelCount} |\n`;
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Set memory limit for a host (OOM protection)
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetHostMemoryLimit(args) {
  const { host_id, memory_limit_mb } = args;

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  // Allow 0 or null to disable limit
  const limit = memory_limit_mb > 0 ? Math.round(memory_limit_mb) : null;

  hostManagement.updateOllamaHost(host_id, { memory_limit_mb: limit });

  let output = `## Memory Limit Updated: ${host.name}\n\n`;
  if (limit) {
    const limitGb = (limit / 1024).toFixed(1);
    output += `**Memory Limit:** ${limit} MB (${limitGb} GB)\n\n`;
    output += `Models larger than ${limitGb} GB (with 15% overhead) will not be loaded on this host.\n\n`;

    // Show which models fit
    if (host.models && host.models.length > 0) {
      output += `### Model Compatibility\n\n`;
      output += `| Model | Size | Fits? |\n`;
      output += `|-------|------|-------|\n`;
      for (const model of host.models) {
        const sizeGb = (model.size / 1024 / 1024 / 1024).toFixed(2);
        const sizeWithOverhead = (model.size / 1024 / 1024) * 1.15;
        const fits = sizeWithOverhead <= limit;
        output += `| ${model.name} | ${sizeGb} GB | ${fits ? '✅' : '❌ Too large'} |\n`;
      }
    }
  } else {
    output += `**Memory Limit:** Disabled\n\n`;
    output += `All models can be loaded on this host (no OOM protection).\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set max concurrent tasks for a host (capacity management)
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetHostMaxConcurrent(args) {
  const { host_id, max_concurrent } = args;

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return makeError(ErrorCodes.HOST_NOT_FOUND, `Host not found: ${host_id}`);
  }

  // Allow 0 to disable limit (unlimited)
  const limit = max_concurrent > 0 ? Math.round(max_concurrent) : 0;

  hostManagement.updateOllamaHost(host_id, { max_concurrent: limit });

  let output = `## Max Concurrent Updated: ${host.name}\n\n`;
  if (limit > 0) {
    output += `**Max Concurrent Tasks:** ${limit}\n\n`;
    output += `This host will reject new tasks when ${limit} task(s) are already running.\n`;
    output += `Current load: ${host.running_tasks || 0}/${limit}\n`;
  } else {
    output += `**Max Concurrent Tasks:** Unlimited\n\n`;
    output += `This host has no concurrent task limit (default behavior).\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get host capacity status
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetHostCapacity(_args) {
  const hosts = hostManagement.listOllamaHosts({ enabled: true });

  let output = `## Ollama Host Capacity\n\n`;
  output += `| Host | Status | Running | Max | Available | Memory |\n`;
  output += `|------|--------|---------|-----|-----------|--------|\n`;

  for (const host of hosts) {
    const running = host.running_tasks || 0;
    const max = host.max_concurrent || 0;
    const maxStr = max > 0 ? String(max) : '∞';
    const available = max > 0 ? Math.max(0, max - running) : '∞';
    const statusIcon = host.status === 'healthy' ? '✅' :
                       host.status === 'degraded' ? '⚠️' :
                       host.status === 'down' ? '❌' : '❓';
    const memLimit = host.memory_limit_mb
      ? `${(host.memory_limit_mb / 1024).toFixed(0)} GB`
      : 'None';

    const atCapacity = max > 0 && running >= max;
    const capacityWarning = atCapacity ? ' ⚠️' : '';

    output += `| ${host.name} | ${statusIcon} | ${running} | ${maxStr} | ${available}${capacityWarning} | ${memLimit} |\n`;
  }

  output += `\n### Legend\n`;
  output += `- **Running**: Current active tasks\n`;
  output += `- **Max**: Maximum concurrent tasks (∞ = unlimited)\n`;
  output += `- **Available**: Remaining capacity (⚠️ = at capacity)\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Configure global memory protection settings
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleConfigureMemoryProtection(args) {
  const changes = [];

  if (args.default_memory_limit_mb !== undefined) {
    const limit = args.default_memory_limit_mb > 0 ? Math.round(args.default_memory_limit_mb) : 0;
    configCore.setConfig('default_host_memory_limit_mb', String(limit));
    changes.push(`Default memory limit: ${limit > 0 ? `${limit} MB (${(limit/1024).toFixed(1)} GB)` : 'Disabled'}`);
  }

  if (args.strict_mode !== undefined) {
    configCore.setConfig('strict_memory_mode', args.strict_mode ? '1' : '0');
    changes.push(`Strict mode: ${args.strict_mode ? 'Enabled' : 'Disabled'}`);
  }

  if (args.reject_unknown_sizes !== undefined) {
    configCore.setConfig('reject_unknown_model_sizes', args.reject_unknown_sizes ? '1' : '0');
    changes.push(`Reject unknown model sizes: ${args.reject_unknown_sizes ? 'Enabled' : 'Disabled'}`);
  }

  if (changes.length === 0) {
    return {
      content: [{ type: 'text', text: '## Memory Protection\n\nNo changes specified. Provide at least one setting to configure.' }]
    };
  }

  let output = `## Memory Protection Updated\n\n`;
  output += changes.map(c => `- ${c}`).join('\n');
  output += `\n\n### Current Settings\n\n`;

  const defaultLimit = serverConfig.getInt('default_host_memory_limit_mb', 0);
  const strictMode = serverConfig.isOptIn('strict_memory_mode');
  const rejectUnknown = serverConfig.isOptIn('reject_unknown_model_sizes');

  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Default Memory Limit | ${defaultLimit > 0 ? `${defaultLimit} MB (${(defaultLimit/1024).toFixed(1)} GB)` : 'Not set'} |\n`;
  output += `| Strict Mode | ${strictMode ? 'Enabled - rejects unknown sizes' : 'Disabled'} |\n`;
  output += `| Reject Unknown Sizes | ${rejectUnknown ? 'Enabled' : 'Disabled'} |\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Get memory protection status and host configurations
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetMemoryProtectionStatus(_args) {
  // Get global settings
  const defaultLimit = serverConfig.getInt('default_host_memory_limit_mb', 0);
  const strictMode = serverConfig.isOptIn('strict_memory_mode');
  const rejectUnknown = serverConfig.isOptIn('reject_unknown_model_sizes');

  let output = `## Memory Protection Status\n\n`;

  // Protection level indicator
  let protectionLevel = 'Low';
  if (strictMode) {
    protectionLevel = 'Maximum';
  } else if (rejectUnknown) {
    protectionLevel = 'High';
  } else if (defaultLimit > 0) {
    protectionLevel = 'Medium';
  }

  output += `**Protection Level:** ${protectionLevel}\n\n`;

  output += `### Global Settings\n\n`;
  output += `| Setting | Value | Description |\n`;
  output += `|---------|-------|-------------|\n`;
  output += `| Default Memory Limit | ${defaultLimit > 0 ? `${(defaultLimit/1024).toFixed(1)} GB` : 'Not set'} | Applied to hosts without explicit limits |\n`;
  output += `| Strict Mode | ${strictMode ? '✅ Enabled' : '❌ Disabled'} | Rejects ALL models with unknown sizes |\n`;
  output += `| Reject Unknown Sizes | ${rejectUnknown ? '✅ Enabled' : '❌ Disabled'} | Rejects models without size info |\n\n`;

  // Get host memory configs
  const hosts = hostManagement.listOllamaHosts({});
  output += `### Host Memory Limits\n\n`;
  output += `| Host | Memory Limit | Effective Limit | Status |\n`;
  output += `|------|--------------|-----------------|--------|\n`;

  for (const host of hosts) {
    const hostLimit = host.memory_limit_mb ? `${(host.memory_limit_mb/1024).toFixed(1)} GB` : 'Not set';
    const effectiveLimit = host.memory_limit_mb || defaultLimit;
    const effective = effectiveLimit > 0 ? `${(effectiveLimit/1024).toFixed(1)} GB` : 'No limit ⚠️';
    const status = host.enabled ? (host.status === 'healthy' ? '✅ Healthy' : '❌ ' + host.status) : '⏸️ Disabled';
    output += `| ${host.name} | ${hostLimit} | ${effective} | ${status} |\n`;
  }

  output += `\n### Recommendations\n\n`;
  if (protectionLevel === 'Low') {
    output += `⚠️ **Low protection** - Models may cause OOM errors on underpowered hosts.\n\n`;
    output += `Consider:\n`;
    output += `- Set \`default_memory_limit_mb\` to a safe value (e.g., 8192 for 8GB)\n`;
    output += `- Enable \`reject_unknown_sizes\` to block models without size info\n`;
    output += `- Set individual host limits with \`set_host_memory_limit\`\n`;
  } else if (protectionLevel === 'Maximum') {
    output += `🛡️ **Maximum protection** - Only models with known sizes that fit in memory will be used.\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


// ============================================================
// LAN Discovery Handlers
// ============================================================

/**
 * Get discovery status
 * @param {Object} _args - Unused handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetDiscoveryStatus(_args) {
  let discovery;
  try {
    discovery = require('../providers/ollama-mdns-discovery');
  } catch (err) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `## Discovery Status\n\n**Error:** Discovery module not available: ${err.message}`)
    };
  }

  const status = discovery.getDiscoveryStatus();

  let output = `## Discovery Status\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Enabled | ${status.enabled ? '✅ Yes' : '❌ No'} |\n`;
  output += `| Initialized | ${status.initialized ? '✅ Yes' : '❌ No'} |\n`;
  output += `| Advertising | ${status.advertising ? '✅ Active' : '⏹️ Stopped'} |\n`;
  output += `| Browsing | ${status.browsing ? '✅ Active' : '⏹️ Stopped'} |\n`;
  output += `| LAN IP | ${status.lanIP || '❓ Not detected'} |\n`;
  output += `| WSL2 | ${status.isWSL2 ? 'Yes' : 'No'} |\n`;

  // List discovered hosts
  const hosts = hostManagement.listOllamaHosts();
  const discovered = hosts.filter(h => h.id.startsWith('discovered-'));

  if (discovered.length > 0) {
    output += `\n### Discovered Hosts (${discovered.length})\n\n`;
    output += `| Name | URL | Status |\n`;
    output += `|------|-----|--------|\n`;
    for (const h of discovered) {
      const statusIcon = h.status === 'healthy' ? '✅' : h.status === 'down' ? '❌' : '⚠️';
      output += `| ${h.name} | \`${h.url}\` | ${statusIcon} ${h.status} |\n`;
    }
  } else {
    output += `\n*No hosts discovered yet. Other machines running Torque+Ollama will appear here automatically.*\n`;
  }

  output += `\n### Configuration\n\n`;
  output += `Use \`set_discovery_config\` to change settings:\n`;
  output += `- \`discovery_enabled\` - Master on/off\n`;
  output += `- \`discovery_advertise\` - Advertise local Ollama\n`;
  output += `- \`discovery_browse\` - Browse for other hosts\n`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Configure discovery settings
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetDiscoveryConfig(args) {
  const { discovery_enabled, discovery_advertise, discovery_browse } = args;
  const changes = [];

  if (discovery_enabled !== undefined) {
    configCore.setConfig('discovery_enabled', discovery_enabled ? '1' : '0');
    changes.push(`discovery_enabled = ${discovery_enabled}`);
  }

  if (discovery_advertise !== undefined) {
    configCore.setConfig('discovery_advertise', discovery_advertise ? '1' : '0');
    changes.push(`discovery_advertise = ${discovery_advertise}`);
  }

  if (discovery_browse !== undefined) {
    configCore.setConfig('discovery_browse', discovery_browse ? '1' : '0');
    changes.push(`discovery_browse = ${discovery_browse}`);
  }

  if (changes.length === 0) {
    return {
      content: [{ type: 'text', text: `## Discovery Config\n\nNo changes specified. Available options:\n- \`discovery_enabled\`\n- \`discovery_advertise\`\n- \`discovery_browse\`` }]
    };
  }

  let output = `## Discovery Config Updated\n\n`;
  output += `**Changes:**\n`;
  for (const c of changes) {
    output += `- ${c}\n`;
  }

  output += `\n**Note:** Restart Torque for changes to take effect, or manually call discovery functions.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Scan network for Ollama instances
 * @param {Object} args - Handler arguments.
 * @returns {Promise<Object>} Response payload.
 */
async function handleScanNetworkForOllama(args) {
  try {
  let discovery;
  try {
    discovery = require('../providers/ollama-mdns-discovery');
  } catch (err) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `## Network Scan\n\n**Error:** Discovery module not available: ${err.message}`)
    };
  }

  // Check if scan is already in progress
  if (discovery.isScanInProgress()) {
    return {
      content: [{ type: 'text', text: `## Network Scan\n\n**Status:** Scan already in progress. Please wait for it to complete.` }]
    };
  }

  const { port = 11434, auto_add = true, subnet } = args;

  let output = `## Network Scan for Ollama\n\n`;
  output += `Scanning local network for Ollama instances on port ${port}...\n\n`;

  try {
    const subnets = subnet ? [subnet] : discovery.getLocalSubnets();
    output += `**Subnets:** ${subnets.join(', ')}\n\n`;

    const result = await discovery.scanNetworkForOllama({
      port,
      autoAdd: auto_add,
      subnets: subnet ? [subnet] : null
    });

    if (!result.success) {
      output += `**Error:** ${result.reason}\n`;
      return makeError(ErrorCodes.OPERATION_FAILED, output);
    }

    output += `**Scan completed in ${result.duration}ms**\n\n`;
    output += `| Metric | Value |\n`;
    output += `|--------|-------|\n`;
    output += `| Total found | ${result.totalFound} |\n`;
    output += `| New hosts | ${result.newHosts.length} |\n`;
    output += `| Skipped (local/existing) | ${result.skipped.length} |\n\n`;

    if (result.newHosts.length > 0) {
      output += `### New Hosts Discovered\n\n`;
      output += `| Hostname | IP | Models | Added |\n`;
      output += `|----------|-----|--------|-------|\n`;
      for (const host of result.newHosts) {
        const modelCount = host.models?.length || 0;
        const addedStatus = host.added ? '✅' : `❌ ${host.error || ''}`;
        output += `| ${host.hostname} | ${host.ip} | ${modelCount} | ${addedStatus} |\n`;
      }
      output += `\n`;
    } else {
      output += `*No new Ollama hosts found on the network.*\n\n`;
    }

    if (result.skipped.length > 0) {
      output += `### Skipped Hosts\n\n`;
      // Omit raw IPs from skipped-host output to avoid leaking internal network topology
      // to log-scrapers or session recorders. The count is sufficient for diagnostics.
      output += `${result.skipped.length} host(s) skipped (already known or local machine).\n`;
    }

    return { content: [{ type: 'text', text: output }] };

  } catch (err) {
    output += `**Error:** ${err.message}\n`;
    return makeError(ErrorCodes.OPERATION_FAILED, output);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}


/**
 * Configure auto-scan for network discovery
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleConfigureAutoScan(args) {
  let discovery;
  try {
    discovery = require('../providers/ollama-mdns-discovery');
  } catch (err) {
    return {
      ...makeError(ErrorCodes.OPERATION_FAILED, `## Auto-Scan\n\n**Error:** Discovery module not available: ${err.message}`)
    };
  }

  const { enabled, interval_minutes } = args;

  let output = `## Auto-Scan Configuration\n\n`;

  // If just querying status
  if (enabled === undefined && interval_minutes === undefined) {
    const status = discovery.getAutoScanStatus();
    output += `| Setting | Value |\n`;
    output += `|---------|-------|\n`;
    output += `| Status | ${status.running ? '🟢 Running' : '⚪ Stopped'} |\n`;
    output += `| Enabled | ${status.enabled ? 'Yes' : 'No'} |\n`;
    output += `| Interval | ${status.intervalMinutes} minutes |\n`;
    output += `| Current Subnets | ${status.currentSubnets.join(', ') || 'None detected'} |\n\n`;
    output += `Use \`configure_auto_scan enabled=true\` to start, or \`enabled=false\` to stop.`;
    return { content: [{ type: 'text', text: output }] };
  }

  // Configure auto-scan
  if (enabled === true) {
    const interval = interval_minutes || 5;
    if (discovery.isAutoScanRunning()) {
      discovery.stopAutoScan();
    }
    discovery.startAutoScan(interval);
    output += `✅ Auto-scan **enabled** (every ${interval} minutes)\n\n`;
    output += `TORQUE will now:\n`;
    output += `- Scan your network every ${interval} minutes\n`;
    output += `- Auto-detect network changes (hotspot ↔ home WiFi)\n`;
    output += `- Automatically add any Ollama hosts found\n`;
  } else if (enabled === false) {
    discovery.stopAutoScan();
    output += `⚪ Auto-scan **disabled**\n\n`;
    output += `Network scanning is now manual only. Use \`scan_network_for_ollama\` to scan.`;
  }

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Get optimization settings for a specific host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleGetHostSettings(args) {
  const { host_id } = args;

  if (!host_id) {
    return {
      content: [{
        type: 'text',
        text: `## Error\n\nhost_id is required. Use \`list_ollama_hosts\` to see available hosts.`
      }]
    };
  }

  const settings = hostManagement.getHostSettings(host_id);

  if (!settings) {
    return {
      content: [{
        type: 'text',
        text: `## Error\n\nHost "${host_id}" not found. Use \`list_ollama_hosts\` to see available hosts.`
      }]
    };
  }

  // Fetch host record for host-level columns (default_model, etc.)
  const host = hostManagement.getOllamaHost(host_id);

  let output = `## Host Settings: ${settings.hostName}\n\n`;
  output += `| Setting | Value | Description |\n`;
  output += `|---------|-------|-------------|\n`;
  output += `| default_model | ${host?.default_model || 'Not set'} | Model used when no model specified |\n`;
  output += `| num_gpu | ${settings.num_gpu} | GPU layers (-1=auto, 0=CPU, N=layers) |\n`;
  output += `| num_thread | ${settings.num_thread} | CPU threads (0=auto) |\n`;
  output += `| keep_alive | ${settings.keep_alive} | Model memory retention |\n`;
  output += `| num_ctx | ${settings.num_ctx} | Context window size |\n`;
  output += `| temperature | ${settings.temperature} | Generation temperature |\n`;
  output += `| top_p | ${settings.top_p} | Nucleus sampling |\n`;
  output += `| top_k | ${settings.top_k} | Top-K sampling |\n`;
  output += `| mirostat | ${settings.mirostat} | Adaptive sampling (0=off) |\n`;

  output += `\n**Note:** Host-specific settings override global defaults.\n`;
  output += `Use \`set_host_settings\` to configure this host.`;

  return { content: [{ type: 'text', text: output }] };
}


/**
 * Set optimization settings for a specific host
 * @param {Object} args - Handler arguments.
 * @returns {Object} Response payload.
 */
function handleSetHostSettings(args) {
  const { host_id, num_gpu, num_ctx, num_thread, keep_alive, temperature, top_k, top_p, max_concurrent, gpu_metrics_port, default_model } = args;

  if (!host_id) {
    return {
      content: [{
        type: 'text',
        text: `## Error\n\nhost_id is required. Use \`list_ollama_hosts\` to see available hosts.`
      }]
    };
  }

  const host = hostManagement.getOllamaHost(host_id);
  if (!host) {
    return {
      content: [{
        type: 'text',
        text: `## Error\n\nHost "${host_id}" not found. Use \`list_ollama_hosts\` to see available hosts.`
      }]
    };
  }

  // Build settings object from provided values
  const settings = {};
  const updates = [];

  if (num_gpu !== undefined) {
    if (num_gpu < -1 || num_gpu > 100) {
      return {
        content: [{
          type: 'text',
          text: `## Error\n\nnum_gpu must be -1 (auto), 0 (CPU), or 1-100 (layers)`
        }]
      };
    }
    settings.num_gpu = num_gpu;
    updates.push(`num_gpu → ${num_gpu === -1 ? 'auto' : num_gpu === 0 ? 'CPU only' : num_gpu + ' layers'}`);
  }

  if (num_ctx !== undefined) {
    if (num_ctx < 512 || num_ctx > 131072) {
      return {
        content: [{
          type: 'text',
          text: `## Error\n\nnum_ctx must be between 512 and 131072`
        }]
      };
    }
    settings.num_ctx = num_ctx;
    updates.push(`num_ctx → ${num_ctx}`);
  }

  if (num_thread !== undefined) {
    settings.num_thread = num_thread;
    updates.push(`num_thread → ${num_thread === 0 ? 'auto' : num_thread}`);
  }

  if (keep_alive !== undefined) {
    settings.keep_alive = keep_alive;
    updates.push(`keep_alive → ${keep_alive}`);
  }

  if (temperature !== undefined) {
    settings.temperature = temperature;
    updates.push(`temperature → ${temperature}`);
  }

  if (top_k !== undefined) {
    settings.top_k = top_k;
    updates.push(`top_k → ${top_k}`);
  }

  if (top_p !== undefined) {
    settings.top_p = top_p;
    updates.push(`top_p → ${top_p}`);
  }

  // max_concurrent is a host-level column, not a JSON setting
  if (max_concurrent !== undefined) {
    hostManagement.updateOllamaHost(host_id, { max_concurrent: max_concurrent });
    updates.push(`max_concurrent → ${max_concurrent === 0 ? 'unlimited' : max_concurrent}`);
  }

  // gpu_metrics_port is a host-level column (port of gpu-metrics-server.js companion)
  if (gpu_metrics_port !== undefined) {
    hostManagement.updateOllamaHost(host_id, { gpu_metrics_port: gpu_metrics_port || null });
    updates.push(`gpu_metrics_port → ${gpu_metrics_port || 'disabled'}`);
  }

  // default_model is a host-level column (model used when no model specified)
  if (default_model !== undefined) {
    hostManagement.updateOllamaHost(host_id, { default_model: default_model || null });
    updates.push(`default_model → ${default_model || 'cleared'}`);
  }

  if (updates.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `## No Changes\n\nNo settings provided to update.`
      }]
    };
  }

  // Apply settings (skip if only max_concurrent was changed)
  if (Object.keys(settings).length > 0) {
    hostManagement.setHostSettings(host_id, settings);
  }

  let output = `## Host Settings Updated: ${host.name}\n\n`;
  output += `**Changes:**\n`;
  updates.forEach(u => output += `- ${u}\n`);
  output += `\nSettings take effect on next Ollama request to this host.`;

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Check the health of a specific Ollama host
 */
async function checkHostHealth(hostId) {
  const host = hostManagement.getOllamaHost(hostId);
  if (!host) return false;

  const result = await probeOllamaEndpoint(host.url);
  hostManagement.recordHostHealthCheck(hostId, result.ok, result.ok ? result.models : null);
  return result.ok;
}

// ── Unified manage_host dispatcher (Phase 3.2) ──

const MANAGE_HOST_DISPATCH = {
  list:             (args) => handleListOllamaHosts(args),
  add:              (args) => handleAddOllamaHost(args),
  remove:           (args) => handleRemoveOllamaHost(args),
  enable:           (args) => handleEnableOllamaHost(args),
  disable:          (args) => handleDisableOllamaHost(args),
  recover:          (args) => handleRecoverOllamaHost(args),
  refresh_models:   (args) => handleRefreshHostModels(args),
  set_memory_limit: (args) => handleSetHostMemoryLimit(args),
  set_max_concurrent: (args) => handleSetHostMaxConcurrent(args),
  get_capacity:     (args) => handleGetHostCapacity(args),
  health:           (args) => handleCheckOllamaHealth(args),
  cleanup_null_ids: (args) => handleCleanupNullIdHosts(args),
};

async function handleManageHost(args) {
  try {
    const { action } = args;
    if (!action) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'action is required');
    }
    const dispatcher = MANAGE_HOST_DISPATCH[action];
    if (!dispatcher) {
      return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${action}. Valid: ${Object.keys(MANAGE_HOST_DISPATCH).join(', ')}`);
    }
    return await dispatcher(args);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, `manage_host failed: ${err.message}`);
  }
}

function createProviderOllamaHostsHandlers() {
  return {
    handleListOllamaModels,
    handleCheckOllamaHealth,
    handleAddOllamaHost,
    handleRemoveOllamaHost,
    handleCleanupNullIdHosts,
    handleListOllamaHosts,
    handleEnableOllamaHost,
    handleDisableOllamaHost,
    handleRecoverOllamaHost,
    handleRefreshHostModels,
    handleSetHostMemoryLimit,
    handleSetHostMaxConcurrent,
    handleGetHostCapacity,
    handleConfigureMemoryProtection,
    handleGetMemoryProtectionStatus,
    handleGetDiscoveryStatus,
    handleSetDiscoveryConfig,
    handleScanNetworkForOllama,
    handleConfigureAutoScan,
    handleGetHostSettings,
    handleSetHostSettings,
    handleManageHost,
  };
}

module.exports = {
  handleListOllamaModels,
  handleCheckOllamaHealth,
  handleAddOllamaHost,
  handleRemoveOllamaHost,
  handleCleanupNullIdHosts,
  handleListOllamaHosts,
  handleEnableOllamaHost,
  handleDisableOllamaHost,
  handleRecoverOllamaHost,
  handleRefreshHostModels,
  handleSetHostMemoryLimit,
  handleSetHostMaxConcurrent,
  handleGetHostCapacity,
  handleConfigureMemoryProtection,
  handleGetMemoryProtectionStatus,
  handleGetDiscoveryStatus,
  handleSetDiscoveryConfig,
  handleScanNetworkForOllama,
  handleConfigureAutoScan,
  handleGetHostSettings,
  handleSetHostSettings,
  handleManageHost,
  createProviderOllamaHostsHandlers,
};
