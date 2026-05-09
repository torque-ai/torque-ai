import '@testing-library/jest-dom';
import { vi } from 'vitest';

const originalConsoleError = console.error.bind(console);
const originalConsoleLog = console.log.bind(console);
const originalConsoleWarn = console.warn.bind(console);

function stringifyConsoleArgs(args) {
  return args.map((arg) => {
    if (arg instanceof Error) {
      return `${arg.name}: ${arg.message}`;
    }
    if (typeof arg === 'string') {
      return arg;
    }
    return '';
  }).join(' ');
}

function isExpectedReactTestNoise(args) {
  const text = stringifyConsoleArgs(args);
  return (
    text.includes('inside a test was not wrapped in act(...)') ||
    text.includes('React will try to recreate this component tree from scratch using the error boundary') ||
    text.includes('The above error occurred in the') ||
    text.includes('Error: Uncaught') ||
    text.includes('Error: Test render error') ||
    text.includes('Dashboard error: Error: Test render error') ||
    (text.includes('Dashboard error: Error:') && text.includes('ThrowGeneric')) ||
    text.includes('React has detected a change in the order of Hooks called by') ||
    (text.includes('Rendered more hooks than during the previous render') && text.includes('HookRuleViolationChild')) ||
    text.includes('Action reject failed: Error: Approval backend unavailable') ||
    text.includes('Failed to load providers: Error: Network error') ||
    text.includes('Failed to load host models: Error: Network error') ||
    text.includes('Failed to load schedules: Error: Network error')
  );
}

function isExpectedConsoleLog(args) {
  const text = stringifyConsoleArgs(args);
  return (
    text === 'WebSocket connected' ||
    text === 'WebSocket disconnected, reconnecting...'
  );
}

console.error = (...args) => {
  if (isExpectedReactTestNoise(args)) {
    return;
  }
  originalConsoleError(...args);
};

console.log = (...args) => {
  if (isExpectedConsoleLog(args)) {
    return;
  }
  originalConsoleLog(...args);
};

console.warn = (...args) => {
  if (isExpectedReactTestNoise(args)) {
    return;
  }
  originalConsoleWarn(...args);
};

// Mock ResizeObserver for SVG chart components
globalThis.ResizeObserver = class ResizeObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  unobserve() {}
  disconnect() {}
};

const createCanvasContext = () => ({
  fillStyle: '',
  strokeStyle: '',
  font: '',
  textAlign: '',
  textBaseline: '',
  fillRect: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  closePath: vi.fn(),
  arc: vi.fn(),
  fill: vi.fn(),
  stroke: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  fillText: vi.fn(),
  strokeText: vi.fn(),
  save: vi.fn(),
  restore: vi.fn(),
  translate: vi.fn(),
  scale: vi.fn(),
  measureText: vi.fn(() => ({ width: 0 })),
});

if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: vi.fn(() => createCanvasContext()),
  });

  Object.defineProperty(HTMLCanvasElement.prototype, 'toDataURL', {
    configurable: true,
    writable: true,
    value: vi.fn(() => 'data:image/png;base64,torque-test'),
  });
}
