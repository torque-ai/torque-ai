'use strict';

const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const { createWorkerRegistry } = require('./registry');
const { createRouter } = require('./router');

function normalizeTimeoutMs(timeoutMs) {
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
}

function createLogger(logger) {
  return {
    info: typeof logger?.info === 'function' ? logger.info.bind(logger) : () => {},
    warn: typeof logger?.warn === 'function' ? logger.warn.bind(logger) : () => {},
  };
}

function createHost({ db, port, logger = console }) {
  const log = createLogger(logger);
  const registry = createWorkerRegistry({ db });
  const sockets = new Map();
  const pending = new Map();

  function clearPendingEntry(correlationId) {
    const entry = pending.get(correlationId);
    if (!entry) return null;

    pending.delete(correlationId);
    clearTimeout(entry.timeoutHandle);
    return entry;
  }

  function rejectPendingForWorker(workerId, error) {
    for (const [correlationId, entry] of pending.entries()) {
      if (entry.workerId !== workerId) continue;
      clearPendingEntry(correlationId);
      entry.reject(error);
    }
  }

  function sendTo(workerId, msg = {}) {
    const ws = sockets.get(workerId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Worker ${workerId} not connected`);
    }

    const correlationId = msg.correlation_id || randomUUID();
    if (pending.has(correlationId)) {
      throw new Error(`Correlation ${correlationId} is already pending`);
    }

    const timeoutMs = normalizeTimeoutMs(msg.timeout_ms);
    const envelope = { ...msg, correlation_id: correlationId };

    return new Promise((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        const entry = clearPendingEntry(correlationId);
        if (!entry) return;
        entry.reject(new Error(`Timeout waiting for response from ${workerId}`));
      }, timeoutMs);
      if (typeof timeoutHandle.unref === 'function') timeoutHandle.unref();

      pending.set(correlationId, {
        resolve,
        reject,
        timeoutHandle,
        workerId,
      });

      ws.send(JSON.stringify(envelope), (error) => {
        if (!error) return;

        const entry = clearPendingEntry(correlationId);
        if (!entry) return;
        entry.reject(error);
      });
    });
  }

  const router = createRouter({ registry, send: sendTo });
  const wss = new WebSocket.Server({ port });

  wss.on('connection', (ws) => {
    let workerId = null;

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      try {
        if (msg.type === 'register') {
          const nextWorkerId = msg.worker_id || `w_${randomUUID().slice(0, 8)}`;
          const priorSocket = sockets.get(nextWorkerId);
          if (priorSocket && priorSocket !== ws) {
            try {
              priorSocket.close();
            } catch {}
          }

          workerId = nextWorkerId;
          registry.register({
            workerId,
            kind: msg.kind,
            displayName: msg.display_name,
            capabilities: msg.capabilities || [],
            endpoint: 'ws',
          });
          sockets.set(workerId, ws);
          ws.send(JSON.stringify({ type: 'registered', worker_id: workerId }));
          log.info('worker registered', { workerId, kind: msg.kind });
          return;
        }

        if (msg.type === 'heartbeat' && workerId) {
          registry.heartbeat(workerId);
          return;
        }

        if (msg.type === 'response' && msg.correlation_id) {
          const entry = clearPendingEntry(msg.correlation_id);
          if (!entry) return;

          if (msg.error) {
            entry.reject(new Error(msg.error));
            return;
          }

          entry.resolve(msg.payload);
        }
      } catch (error) {
        log.warn('runtime host rejected worker message', {
          workerId,
          type: msg?.type,
          err: error,
        });
      }
    });

    ws.on('close', () => {
      if (!workerId) return;

      sockets.delete(workerId);
      rejectPendingForWorker(workerId, new Error(`Worker ${workerId} disconnected`));

      const worker = registry.get(workerId);
      if (worker && worker.status !== 'disconnected') {
        registry.markUnhealthy(workerId);
      }

      log.info('worker disconnected', { workerId });
    });

    ws.on('error', (error) => {
      log.warn('runtime host socket error', {
        workerId,
        err: error,
      });
    });
  });

  const staleReapInterval = setInterval(() => {
    const staleWorkerIds = registry.reapStaleWorkers({ thresholdSeconds: 60 });
    for (const staleWorkerId of staleWorkerIds) {
      const staleSocket = sockets.get(staleWorkerId);
      if (!staleSocket) continue;

      sockets.delete(staleWorkerId);
      rejectPendingForWorker(staleWorkerId, new Error(`Worker ${staleWorkerId} timed out`));
      try {
        staleSocket.terminate();
      } catch {}
    }
  }, 30000);
  if (typeof staleReapInterval.unref === 'function') staleReapInterval.unref();

  function close() {
    clearInterval(staleReapInterval);

    for (const correlationId of pending.keys()) {
      const entry = clearPendingEntry(correlationId);
      if (!entry) continue;
      entry.reject(new Error('Host closed'));
    }

    for (const socket of sockets.values()) {
      try {
        socket.close();
      } catch {}
    }
    sockets.clear();

    return new Promise((resolve, reject) => {
      wss.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  return {
    router,
    registry,
    dispatch: router.dispatch.bind(router),
    close,
  };
}

module.exports = { createHost };
