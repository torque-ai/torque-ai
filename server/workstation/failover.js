// Workstation Failover — re-route tasks when a workstation goes down

'use strict';

const model = require('./model');

function setDb(dbInstance) {
  model.setDb(dbInstance);
}

function isHealthyCapacityWorkstation(ws) {
  if (!ws) return false;
  if (ws.status !== 'healthy') return false;
  if (ws.id === undefined || ws.id === null) return false;
  return (ws.running_tasks || 0) < (ws.max_concurrent || 0);
}

function inferPrimaryCapability(ws) {
  const capabilities = ws && ws._capabilities ? ws._capabilities : {};
  const key = Object.keys(capabilities).find((capability) => {
    const value = capabilities[capability];
    if (value === true) return true;
    if (value && typeof value === 'object' && value.detected) return true;
    if (Array.isArray(value)) return true;
    return false;
  });

  return key || 'command_exec';
}

function findFailoverWorkstation(capability, excludeId) {
  const candidates = model.listWorkstations({ capability, enabled: true }).filter((ws) => {
    if (ws.id === excludeId) return false;
    return isHealthyCapacityWorkstation(ws);
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => (a.running_tasks || 0) - (b.running_tasks || 0));
  return candidates[0];
}

function handleWorkstationDown(workstationId, getTasksByWorkstation, updateTask) {
  const downedWorkstation = model.getWorkstation(workstationId);
  if (!downedWorkstation) return { rerouted: 0, failed: 0 };

  const tasks = Array.isArray(getTasksByWorkstation(workstationId))
    ? getTasksByWorkstation(workstationId)
    : [];

  let rerouted = 0;
  let failed = 0;
  const wsName = downedWorkstation.name || workstationId;
  const primaryCapability = inferPrimaryCapability(downedWorkstation);

  for (const task of tasks) {
    if (!task || !task.id) continue;

    if (task.status === 'queued') {
      const replacement = findFailoverWorkstation(primaryCapability, workstationId);
      if (replacement) {
        updateTask(task.id, { workstation_id: replacement.id });
        rerouted += 1;
        continue;
      }
      updateTask(task.id, { status: 'failed', error: `workstation_down: ${wsName}` });
      failed += 1;
      continue;
    }

    if (task.status === 'running') {
      updateTask(task.id, { status: 'failed', error: `workstation_down: ${wsName}` });
      failed += 1;
    }
  }

  return { rerouted, failed };
}

module.exports = {
  setDb,
  findFailoverWorkstation,
  handleWorkstationDown,
};
