/**
 * WebSocket hook for real-time updates
 */

import { useEffect, useRef, useCallback, useState } from 'react';

const MAX_WEBSOCKET_MESSAGE_BYTES = 10 * 1024 * 1024; // 10MB
let websocketParseErrorCount = 0;

/**
 * Get WebSocket URL based on current location
 */
function getWebSocketUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  // In dev mode, preserve the current hostname while keeping the auto-shifted port.
  const host = import.meta.env.DEV
    ? `${window.location.hostname}:${window.location.port || '3456'}`
    : window.location.host;
  return `${protocol}//${host}`;
}

/**
 * Custom hook for WebSocket connection with auto-reconnect
 */
export function useWebSocket(onMessage) {
  const wsRef = useRef(null);
  const reconnectTimeoutRef = useRef(null);
  const retryCountRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const subscriptionsRef = useRef(new Set());
  const [connectionState, setConnectionState] = useState('disconnected'); // 'connected' | 'disconnected' | 'reconnecting'
  const [clientCount, setClientCount] = useState(0);
  const [instanceId, setInstanceId] = useState(null);
  const [shortId, setShortId] = useState(null);

  const logParseError = useCallback((error) => {
    websocketParseErrorCount += 1;
    if (websocketParseErrorCount % 10 !== 0) {
      return;
    }
    console.warn(`WebSocket message parse error (${websocketParseErrorCount}):`, error);
  }, []);

  const parseMessage = useCallback((data) => {
    if (typeof data !== 'string') {
      throw new SyntaxError('WebSocket message data is not a string');
    }

    if (data.length > MAX_WEBSOCKET_MESSAGE_BYTES) {
      throw new SyntaxError(`WebSocket message exceeds ${MAX_WEBSOCKET_MESSAGE_BYTES} byte limit`);
    }

    return JSON.parse(data);
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }

    const ws = new WebSocket(getWebSocketUrl());

    ws.onopen = () => {
      setConnectionState('connected');
      retryCountRef.current = 0;
      console.log('WebSocket connected');
      // Replay active subscriptions after reconnect
      for (const taskId of subscriptionsRef.current) {
        ws.send(JSON.stringify({ event: 'subscribe', taskId }));
      }
    };

    ws.onmessage = (event) => {
      let message;
      try {
        message = parseMessage(event.data);
      } catch (err) {
        if (err instanceof SyntaxError) {
          logParseError(err);
          return;
        }

        throw err;
      }

      try {
        // Handle connection info with instance identity
        if (message.event === 'connected') {
          setClientCount(message.data.clients);
          if (message.data.instanceId) setInstanceId(message.data.instanceId);
          if (message.data.shortId) setShortId(message.data.shortId);
        }

        // Forward to handler
        if (onMessage) {
          onMessage(message);
        }
      } catch (error) {
        throw error;
      }
    };

    ws.onclose = () => {
      if (!shouldReconnectRef.current) return;
      setConnectionState('reconnecting');
      console.log('WebSocket disconnected, reconnecting...');

      // Exponential backoff: 3s, 6s, 12s, max 30s
      const delay = Math.min(3000 * Math.pow(2, retryCountRef.current), 30000);
      retryCountRef.current++;
      reconnectTimeoutRef.current = setTimeout(() => {
        if (shouldReconnectRef.current) {
          connect();
        }
        reconnectTimeoutRef.current = null;
      }, delay);
    };

    ws.onerror = (err) => {
      console.error('WebSocket error:', err);
    };

    wsRef.current = ws;
  }, [onMessage, parseMessage, logParseError]);

  // Subscribe to a specific task's output
  const subscribe = useCallback((taskId) => {
    subscriptionsRef.current.add(taskId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: 'subscribe', taskId }));
    }
  }, []);

  // Unsubscribe from a task's output
  const unsubscribe = useCallback((taskId) => {
    subscriptionsRef.current.delete(taskId);
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ event: 'unsubscribe', taskId }));
    }
  }, []);

  useEffect(() => {
    shouldReconnectRef.current = true;
    connect();

    return () => {
      shouldReconnectRef.current = false;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
      }
    };
  }, [connect]);

  const isConnected = connectionState === 'connected';
  const isReconnecting = connectionState === 'reconnecting';
  return { isConnected, isReconnecting, connectionState, clientCount, instanceId, shortId, subscribe, unsubscribe };
}

export default useWebSocket;
