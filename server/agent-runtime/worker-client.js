'use strict';

const WebSocket = require('ws');

function normalizeHandlers(handlers) {
  return handlers && typeof handlers === 'object' ? handlers : {};
}

function createWorkerClient({ url, kind, displayName, capabilities, handlers }) {
  const messageHandlers = normalizeHandlers(handlers);
  let ws;
  let workerId = null;
  let reconnectTimer = null;
  let closed = false;

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 1000);
    if (typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function sendResponse(payload) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }

  function connect() {
    if (closed) return;

    ws = new WebSocket(url);
    ws.on('open', () => {
      sendResponse({
        type: 'register',
        worker_id: workerId,
        kind,
        display_name: displayName,
        capabilities,
      });
    });

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'registered') {
        workerId = msg.worker_id;
        return;
      }

      if (!msg.correlation_id) return;

      const handler = messageHandlers[msg.type];
      if (typeof handler !== 'function') {
        sendResponse({
          type: 'response',
          correlation_id: msg.correlation_id,
          error: `No handler registered for ${msg.type}`,
        });
        return;
      }

      try {
        const result = await handler(msg.payload, msg);
        sendResponse({
          type: 'response',
          correlation_id: msg.correlation_id,
          payload: result,
        });
      } catch (error) {
        sendResponse({
          type: 'response',
          correlation_id: msg.correlation_id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    ws.on('close', () => {
      workerId = null;
      scheduleReconnect();
    });

    ws.on('error', () => {});
  }

  function heartbeat() {
    sendResponse({ type: 'heartbeat' });
  }

  connect();

  const heartbeatInterval = setInterval(heartbeat, 15000);
  if (typeof heartbeatInterval.unref === 'function') heartbeatInterval.unref();

  function close() {
    closed = true;
    clearReconnectTimer();
    clearInterval(heartbeatInterval);

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close();
    }
  }

  return {
    get workerId() {
      return workerId;
    },
    close,
  };
}

module.exports = { createWorkerClient };
