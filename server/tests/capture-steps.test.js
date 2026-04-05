import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildCaptureSteps,
  validateSteps,
  VALID_NAV_TYPES,
  VALID_ACTIONS,
} = require('../plugins/snapscope/capture-steps');

describe('buildCaptureSteps', () => {
  it('builds nav_element steps with click, sleep, and capture', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'nav_element', target: 'Dashboard' },
    });

    expect(result).toEqual({
      steps: [
        { action: 'click', element: 'Dashboard' },
        { action: 'sleep', ms: 1000 },
        { action: 'capture' },
      ],
    });
  });

  it('builds url steps with address bar hotkey, type, submit, sleep, and capture', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'url', target: 'https://example.com/app' },
    });

    expect(result).toEqual({
      steps: [
        { action: 'hotkey', keys: 'ctrl+l' },
        { action: 'type', text: 'https://example.com/app' },
        { action: 'hotkey', keys: 'Enter' },
        { action: 'sleep', ms: 1000 },
        { action: 'capture' },
      ],
    });
  });

  it('builds keyboard steps with hotkey, sleep, and capture', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'keyboard', target: 'Ctrl+Shift+P' },
    });

    expect(result).toEqual({
      steps: [
        { action: 'hotkey', keys: 'Ctrl+Shift+P' },
        { action: 'sleep', ms: 1000 },
        { action: 'capture' },
      ],
    });
  });

  it('builds menu steps with multiple clicks, sleep, and capture', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'menu', target: ['File', 'Open Recent', 'Project A'] },
    });

    expect(result).toEqual({
      steps: [
        { action: 'click', element: 'File' },
        { action: 'click', element: 'Open Recent' },
        { action: 'click', element: 'Project A' },
        { action: 'sleep', ms: 1000 },
        { action: 'capture' },
      ],
    });
  });

  it('builds discovered steps with click, sleep, and capture', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'discovered', element: 'Results Grid' },
    });

    expect(result).toEqual({
      steps: [
        { action: 'click', element: 'Results Grid' },
        { action: 'sleep', ms: 1000 },
        { action: 'capture' },
      ],
    });
  });

  it('uses custom settle_ms when provided', () => {
    const result = buildCaptureSteps({
      settle_ms: 2500,
      navigation: { type: 'keyboard', target: 'Alt+1' },
    });

    expect(result).toEqual({
      steps: [
        { action: 'hotkey', keys: 'Alt+1' },
        { action: 'sleep', ms: 2500 },
        { action: 'capture' },
      ],
    });
  });

  it('returns an error for an unknown navigation type', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'teleport', target: 'Nowhere' },
    });

    expect(result.error).toContain('teleport');
    expect(result.error).toContain(Array.from(VALID_NAV_TYPES)[0]);
  });

  it('returns an error when navigation is missing', () => {
    const result = buildCaptureSteps({});

    expect(result.error).toBeTruthy();
  });

  it('returns an error when nav_element target is missing', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'nav_element' },
    });

    expect(result.error).toContain('target');
  });

  it('returns an error when menu target is empty', () => {
    const result = buildCaptureSteps({
      navigation: { type: 'menu', target: [] },
    });

    expect(result.error).toContain('menu');
  });
});

describe('validateSteps', () => {
  it('returns null for valid steps', () => {
    const result = validateSteps([
      { action: 'click', element: 'Dashboard' },
      { action: 'sleep', ms: 1000 },
      { action: 'capture' },
    ]);

    expect(result).toBeNull();
  });

  it('returns an error for an empty array', () => {
    expect(validateSteps([])).toContain('Empty');
  });

  it('returns an error for a non-array input', () => {
    expect(validateSteps(null)).toContain('Empty');
  });

  it('returns an error for an unknown action', () => {
    expect(validateSteps([{ action: 'explode' }])).toContain('Invalid action');
  });

  it('returns an error when click has no element or coordinates', () => {
    expect(validateSteps([{ action: 'click' }])).toContain('element or coordinates');
  });

  it('returns an error when type has no text', () => {
    expect(validateSteps([{ action: 'type' }])).toContain('text');
  });

  it('returns an error when hotkey has no keys', () => {
    expect(validateSteps([{ action: 'hotkey' }])).toContain('keys');
  });

  it('accepts click steps with coordinates', () => {
    expect(validateSteps([{ action: 'click', x: 10, y: 20 }])).toBeNull();
  });

  it('accepts every valid action', () => {
    for (const action of VALID_ACTIONS) {
      const step = { action };
      if (action === 'click') Object.assign(step, { element: 'Target' });
      if (action === 'type') Object.assign(step, { text: 'Hello' });
      if (action === 'hotkey') Object.assign(step, { keys: 'Ctrl+S' });
      expect(validateSteps([step])).toBeNull();
    }
  });
});
