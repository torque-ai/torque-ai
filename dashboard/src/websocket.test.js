import { renderHook, act } from '@testing-library/react';
import { useWebSocket } from './websocket';

export class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.sentMessages = [];
    this.closeCalls = 0;
    MockWebSocket.instances.push(this);
  }

  send(data) { this.sentMessages.push(data); }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closeCalls += 1;
  }

  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  simulateMessage(data) {
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.onmessage?.({ data: payload });
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  simulateError(error = new Error('websocket failed')) {
    this.onerror?.(error);
  }
}

describe('useWebSocket', () => {
  let originalWebSocket;
  let originalLocation;
  let originalConsoleLog;
  let originalConsoleError;
  let originalConsoleWarn;

  beforeEach(() => {
    originalWebSocket = global.WebSocket;
    originalLocation = window.location;
    originalConsoleLog = console.log;
    originalConsoleError = console.error;
    originalConsoleWarn = console.warn;

    console.log = vi.fn();
    console.error = vi.fn();
    console.warn = vi.fn();
    global.WebSocket = MockWebSocket;
    MockWebSocket.instances = [];
    setWindowLocation('http://127.0.0.1:3456');
  });

  afterEach(() => {
    global.WebSocket = originalWebSocket;
    Object.defineProperty(window, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    });
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  function setWindowLocation(href) {
    const url = new URL(href);
    Object.defineProperty(window, 'location', {
      value: url,
      writable: true,
      configurable: true,
    });
  }

  function latestSocket() {
    return MockWebSocket.instances[MockWebSocket.instances.length - 1];
  }

  function parseMessages(socket, eventName) {
    return socket.sentMessages.filter((raw) => {
      try {
        const parsed = JSON.parse(raw);
        return parsed.event === eventName;
      } catch (_error) {
        return false;
      }
    });
  }

  it('creates WebSocket connection on mount', () => {
    const handler = vi.fn();
    renderHook(() => useWebSocket(handler));
    expect(MockWebSocket.instances.length).toBeGreaterThanOrEqual(1);
  });

  it('starts in disconnected state', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    expect(result.current.connectionState).toBe('disconnected');
    expect(result.current.isConnected).toBe(false);
    expect(result.current.isReconnecting).toBe(false);
  });

  it('builds websocket URL from current location', () => {
    setWindowLocation('https://dashboard.test:7777/path');
    const expected = 'wss://dashboard.test:7777';

    renderHook(() => useWebSocket(vi.fn()));
    expect(latestSocket().url).toBe(expected);
  });

  it('sets isConnected to true on open', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.connectionState).toBe('connected');
  });

  it('forwards messages to handler', () => {
    const handler = vi.fn();
    renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    act(() => { ws.simulateMessage({ event: 'task:event', data: {} }); });
    expect(handler).toHaveBeenCalledWith({ event: 'task:event', data: {} });
  });

  it('parses and applies connected event metadata', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    act(() => {
      ws.simulateMessage({
        event: 'connected',
        data: { clients: 2, instanceId: 'inst-abc', shortId: 'abc' },
      });
    });
    expect(result.current.clientCount).toBe(2);
    expect(result.current.instanceId).toBe('inst-abc');
    expect(result.current.shortId).toBe('abc');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      event: 'connected',
      data: { clients: 2, instanceId: 'inst-abc', shortId: 'abc' },
    });
  });

  it('ignores malformed JSON payloads without invoking handler', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    expect(() => {
      act(() => {
        for (let i = 0; i < 10; i++) {
          ws.simulateMessage('not-json');
        }
      });
    }).not.toThrow();
    expect(result.current.isConnected).toBe(true);
    expect(handler).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledTimes(1);
  });

  it('sets isReconnecting on close', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result } = renderHook(() => useWebSocket(handler));
      const ws = latestSocket();
      act(() => { ws.simulateOpen(); });
      act(() => { ws.simulateClose(); });
      expect(result.current.isReconnecting).toBe(true);
      expect(result.current.connectionState).toBe('reconnecting');
      expect(ws.closeCalls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribes to task output', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    act(() => { result.current.subscribe('task-123'); });
    const sent = ws.sentMessages;
    const subscribeMsgs = parseMessages(ws, 'subscribe');
    expect(subscribeMsgs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(subscribeMsgs[0])).toEqual({ event: 'subscribe', taskId: 'task-123' });
  });

  it('unsubscribes from task output', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws = latestSocket();
    act(() => { ws.simulateOpen(); });
    act(() => { result.current.unsubscribe('task-123'); });
    const sent = ws.sentMessages;
    const unsubMsgs = parseMessages(ws, 'unsubscribe');
    expect(unsubMsgs.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(unsubMsgs[0])).toEqual({ event: 'unsubscribe', taskId: 'task-123' });
  });

  it('queues subscribe messages while disconnected and sends on next open', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    act(() => { result.current.subscribe('task-pending'); });
    const ws = latestSocket();
    expect(parseMessages(ws, 'subscribe').length).toBe(0);
    act(() => { ws.simulateOpen(); });
    const sent = parseMessages(ws, 'subscribe');
    expect(sent.length).toBe(1);
    expect(JSON.parse(sent[0])).toEqual({ event: 'subscribe', taskId: 'task-pending' });
  });

  it('removes subscriptions when unsubscribing and does not replay after reconnect', () => {
    const handler = vi.fn();
    const { result } = renderHook(() => useWebSocket(handler));
    const ws1 = latestSocket();
    act(() => { result.current.subscribe('task-gone'); });
    act(() => { result.current.unsubscribe('task-gone'); });
    act(() => { ws1.simulateClose(); });
    vi.useFakeTimers();
    try {
      act(() => { vi.advanceTimersByTime(3000); });
      const ws2 = latestSocket();
      act(() => { ws2.simulateOpen(); });
      expect(parseMessages(ws2, 'subscribe').length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('replays subscriptions after reconnect', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result } = renderHook(() => useWebSocket(handler));
      const ws1 = latestSocket();
      act(() => { ws1.simulateOpen(); });
      act(() => { result.current.subscribe('task-abc'); });
      act(() => { ws1.simulateClose(); });
      act(() => { vi.advanceTimersByTime(3000); });
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = latestSocket();
      act(() => { ws2.simulateOpen(); });
      const subscribeMsgs = parseMessages(ws2, 'subscribe');
      expect(subscribeMsgs.length).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(subscribeMsgs[0]).taskId).toBe('task-abc');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies exponential reconnect backoff when reconnect attempts fail', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result } = renderHook(() => useWebSocket(handler));
      expect(result.current.connectionState).toBe('disconnected');
      const ws1 = latestSocket();
      act(() => { ws1.simulateClose(); });
      expect(result.current.connectionState).toBe('reconnecting');
      act(() => { vi.advanceTimersByTime(2999); });
      expect(MockWebSocket.instances).toHaveLength(1);
      act(() => { vi.advanceTimersByTime(1); });
      const ws2 = latestSocket();
      expect(ws2).not.toBe(ws1);
      act(() => { ws2.simulateClose(); });
      act(() => { vi.advanceTimersByTime(5999); });
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => { vi.advanceTimersByTime(1); });
      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets reconnect backoff after a successful open', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result } = renderHook(() => useWebSocket(handler));
      const ws1 = latestSocket();
      act(() => { ws1.simulateClose(); });
      act(() => { vi.advanceTimersByTime(3000); });
      const ws2 = latestSocket();
      act(() => { ws2.simulateOpen(); });
      expect(result.current.connectionState).toBe('connected');
      act(() => { ws2.simulateClose(); });
      expect(result.current.connectionState).toBe('reconnecting');
      act(() => { vi.advanceTimersByTime(2999); });
      expect(MockWebSocket.instances).toHaveLength(2);
      act(() => { vi.advanceTimersByTime(1); });
      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops reconnect attempts after unmount and cleans up timeout', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result, unmount } = renderHook(() => useWebSocket(handler));
      const ws = latestSocket();
      act(() => { ws.simulateOpen(); });
      act(() => { ws.simulateClose(); });
      expect(result.current.isReconnecting).toBe(true);
      act(() => { unmount(); });
      act(() => { vi.advanceTimersByTime(5000); });
      expect(MockWebSocket.instances).toHaveLength(1);
      expect(ws.closeCalls).toBe(1);
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps reconnecting state when onclose is triggered after mount', () => {
    vi.useFakeTimers();
    try {
      const handler = vi.fn();
      const { result, rerender } = renderHook(() => useWebSocket(handler));
      const ws1 = latestSocket();
      act(() => { ws1.simulateClose(); });
      expect(result.current.connectionState).toBe('reconnecting');
      act(() => { vi.advanceTimersByTime(3000); });
      const ws2 = latestSocket();
      expect(ws2).not.toBe(ws1);
      rerender();
      act(() => { ws2.simulateOpen(); });
      expect(result.current.isReconnecting).toBe(false);
      expect(result.current.isConnected).toBe(true);
      expect(result.current.connectionState).toBe('connected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('resets reconnect guard when the effect reruns with a new handler', () => {
    vi.useFakeTimers();
    try {
      const handler1 = vi.fn();
      const handler2 = vi.fn();
      const { result, rerender } = renderHook(
        ({ handler }) => useWebSocket(handler),
        { initialProps: { handler: handler1 } },
      );
      const ws1 = latestSocket();
      act(() => { ws1.simulateOpen(); });
      act(() => { rerender({ handler: handler2 }); });
      expect(MockWebSocket.instances).toHaveLength(2);
      const ws2 = latestSocket();
      expect(ws2).not.toBe(ws1);
      act(() => { ws2.simulateOpen(); });
      act(() => { ws2.simulateClose(); });
      expect(result.current.connectionState).toBe('reconnecting');
      act(() => { vi.advanceTimersByTime(3000); });
      expect(MockWebSocket.instances).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
