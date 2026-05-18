'use strict';

function parseJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function workstationToOllamaHost(ws = {}) {
  return {
    id: ws.id,
    name: ws.name,
    url: `http://${ws.host}:${ws.ollama_port || 11434}`,
    enabled: ws.enabled,
    status: ws.status,
    running_tasks: ws.running_tasks,
    max_concurrent: ws.max_concurrent,
    priority: ws.priority,
    models: parseJson(ws.models_cache, []),
    models_cache: ws.models_cache || null,
    models_updated_at: ws.models_updated_at || null,
    created_at: ws.created_at,
  };
}

function workstationToPeekHost(ws = {}) {
  return {
    id: ws.id,
    name: ws.name,
    host: ws.host,
    url: `http://${ws.host}:${ws.agent_port || 9876}`,
    enabled: ws.enabled,
    status: ws.status,
    is_default: ws.is_default,
    created_at: ws.created_at,
  };
}

function workstationToRemoteAgent(ws = {}) {
  return {
    id: ws.id,
    name: ws.name,
    host: ws.host,
    port: ws.agent_port || 3460,
    enabled: ws.enabled,
    status: ws.status,
    max_concurrent: ws.max_concurrent,
    running_tasks: ws.running_tasks,
    tls: ws.tls_cert ? 1 : 0,
    created_at: ws.created_at,
  };
}

module.exports = {
  workstationToOllamaHost,
  workstationToPeekHost,
  workstationToRemoteAgent,
};
