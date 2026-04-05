'use strict';

const VALID_NAV_TYPES = new Set(['nav_element', 'url', 'keyboard', 'menu', 'discovered']);
const VALID_ACTIONS = new Set(['click', 'type', 'hotkey', 'scroll', 'wait', 'sleep', 'capture', 'focus']);
const DEFAULT_SETTLE_MS = 1000;

function buildCaptureSteps(target) {
  const nav = target && target.navigation;
  if (!nav || !nav.type) {
    return { error: 'Missing navigation type' };
  }

  if (!VALID_NAV_TYPES.has(nav.type)) {
    return {
      error: `Invalid navigation type: ${nav.type}. Valid types: ${Array.from(VALID_NAV_TYPES).join(', ')}`,
    };
  }

  let steps;

  switch (nav.type) {
    case 'nav_element':
      if (!nav.target) {
        return { error: 'nav_element navigation requires target' };
      }
      steps = [{ action: 'click', element: nav.target }];
      break;

    case 'url':
      if (!nav.target) {
        return { error: 'url navigation requires target' };
      }
      steps = [
        { action: 'hotkey', keys: 'ctrl+l' },
        { action: 'type', text: nav.target },
        { action: 'hotkey', keys: 'Enter' },
      ];
      break;

    case 'keyboard':
      if (!nav.target) {
        return { error: 'keyboard navigation requires target' };
      }
      steps = [{ action: 'hotkey', keys: nav.target }];
      break;

    case 'menu':
      if (!Array.isArray(nav.target) || nav.target.length === 0) {
        return { error: 'menu navigation requires a non-empty menu target array' };
      }
      steps = nav.target.map((item) => ({ action: 'click', element: item }));
      break;

    case 'discovered':
      if (!nav.element) {
        return { error: 'discovered navigation requires element' };
      }
      steps = [{ action: 'click', element: nav.element }];
      break;

    default:
      return {
        error: `Invalid navigation type: ${nav.type}. Valid types: ${Array.from(VALID_NAV_TYPES).join(', ')}`,
      };
  }

  steps.push(
    { action: 'sleep', ms: target.settle_ms || DEFAULT_SETTLE_MS },
    { action: 'capture' }
  );

  return { steps };
}

function validateSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    return 'Empty steps array';
  }

  for (const step of steps) {
    if (!step || !VALID_ACTIONS.has(step.action)) {
      return `Invalid action: ${step && step.action}`;
    }

    if (step.action === 'click') {
      const hasElement = Boolean(step.element);
      const hasCoordinates = typeof step.x !== 'undefined' && typeof step.y !== 'undefined';
      if (!hasElement && !hasCoordinates) {
        return 'Click requires element or coordinates (x, y)';
      }
    }

    if (step.action === 'type' && !step.text) {
      return 'Type requires text';
    }

    if (step.action === 'hotkey' && !step.keys) {
      return 'Hotkey requires keys';
    }
  }

  return null;
}

module.exports = {
  VALID_NAV_TYPES,
  VALID_ACTIONS,
  DEFAULT_SETTLE_MS,
  buildCaptureSteps,
  validateSteps,
};
