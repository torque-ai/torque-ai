'use strict';

function requireRegistry(registry) {
  if (!registry || typeof registry.get !== 'function' || typeof registry.findByCapability !== 'function') {
    throw new TypeError('createRouter requires a registry with get() and findByCapability()');
  }
}

function requireSend(send) {
  if (typeof send !== 'function') {
    throw new TypeError('createRouter requires a send(workerId, msg) function');
  }
}

function normalizeTarget(target) {
  const normalized = String(target || '').trim();
  if (!normalized) {
    throw new Error('Message has no "to" field');
  }
  return normalized;
}

function getWorkerId(worker) {
  const workerId = worker?.worker_id || worker?.workerId;
  if (!workerId) {
    throw new Error('Worker record is missing worker_id');
  }
  return workerId;
}

function createRouter({ registry, send }) {
  requireRegistry(registry);
  requireSend(send);

  let rrCursor = 0;

  function pickRoundRobin(list) {
    if (!Array.isArray(list) || list.length === 0) {
      throw new Error('pickRoundRobin requires at least one worker');
    }

    const sorted = [...list].sort((a, b) => getWorkerId(a).localeCompare(getWorkerId(b)));
    const pick = sorted[rrCursor % sorted.length];
    rrCursor += 1;
    return pick;
  }

  async function dispatch(msg = {}) {
    const target = normalizeTarget(msg.to);

    let workerId;
    if (target.startsWith('cap:')) {
      const capability = target.slice('cap:'.length).trim();
      if (!capability) {
        throw new Error('Capability target must include a capability name');
      }

      const candidates = registry.findByCapability(capability);
      if (candidates.length === 0) {
        throw new Error(`No worker with capability '${capability}'`);
      }
      workerId = getWorkerId(pickRoundRobin(candidates));
    } else {
      const worker = registry.get(target);
      if (!worker || worker.status !== 'connected') {
        throw new Error(`Worker '${target}' not connected`);
      }
      workerId = getWorkerId(worker);
    }

    return send(workerId, msg);
  }

  return { dispatch };
}

module.exports = { createRouter };
