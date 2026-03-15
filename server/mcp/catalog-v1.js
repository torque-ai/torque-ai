'use strict';

const TOOL_CATALOG_V1 = Object.freeze([
  { name: 'torque.task.submit', domain: 'task', action: 'submit', mutation: true },
  { name: 'torque.task.get', domain: 'task', action: 'get', mutation: false },
  { name: 'torque.task.list', domain: 'task', action: 'list', mutation: false },
  { name: 'torque.task.cancel', domain: 'task', action: 'cancel', mutation: true },
  { name: 'torque.task.retry', domain: 'task', action: 'retry', mutation: true },
  { name: 'torque.task.review', domain: 'task', action: 'review', mutation: true },
  { name: 'torque.task.approve', domain: 'task', action: 'approve', mutation: true },
  { name: 'torque.task.reject', domain: 'task', action: 'reject', mutation: true },

  { name: 'torque.workflow.create', domain: 'workflow', action: 'create', mutation: true },
  { name: 'torque.workflow.get', domain: 'workflow', action: 'get', mutation: false },
  { name: 'torque.workflow.list', domain: 'workflow', action: 'list', mutation: false },
  { name: 'torque.workflow.pause', domain: 'workflow', action: 'pause', mutation: true },
  { name: 'torque.workflow.resume', domain: 'workflow', action: 'resume', mutation: true },
  { name: 'torque.workflow.cancel', domain: 'workflow', action: 'cancel', mutation: true },
  { name: 'torque.workflow.retryNode', domain: 'workflow', action: 'retryNode', mutation: true },

  { name: 'torque.provider.list', domain: 'provider', action: 'list', mutation: false },
  { name: 'torque.provider.get', domain: 'provider', action: 'get', mutation: false },
  { name: 'torque.provider.enable', domain: 'provider', action: 'enable', mutation: true },
  { name: 'torque.provider.disable', domain: 'provider', action: 'disable', mutation: true },
  { name: 'torque.provider.setWeight', domain: 'provider', action: 'setWeight', mutation: true },
  { name: 'torque.provider.setDefault', domain: 'provider', action: 'setDefault', mutation: true },

  { name: 'torque.route.preview', domain: 'route', action: 'preview', mutation: false },
  { name: 'torque.route.explain', domain: 'route', action: 'explain', mutation: false },

  { name: 'torque.policy.get', domain: 'policy', action: 'get', mutation: false },
  { name: 'torque.policy.set', domain: 'policy', action: 'set', mutation: true },

  { name: 'torque.audit.query', domain: 'audit', action: 'query', mutation: false },
  { name: 'torque.telemetry.summary', domain: 'telemetry', action: 'summary', mutation: false },

  { name: 'torque.session.open', domain: 'session', action: 'open', mutation: true },
  { name: 'torque.session.close', domain: 'session', action: 'close', mutation: true },
  { name: 'torque.stream.subscribe', domain: 'stream', action: 'subscribe', mutation: true },
  { name: 'torque.stream.unsubscribe', domain: 'stream', action: 'unsubscribe', mutation: true },
  { name: 'torque.stream.poll', domain: 'stream', action: 'poll', mutation: false },
]);

function listTools() {
  return TOOL_CATALOG_V1;
}

function hasTool(toolName) {
  return TOOL_CATALOG_V1.some((tool) => tool.name === toolName);
}

module.exports = {
  TOOL_CATALOG_V1,
  listTools,
  hasTool,
};
