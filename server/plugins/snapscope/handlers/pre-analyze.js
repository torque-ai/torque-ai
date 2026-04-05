'use strict';

const INTERACTIVE_TYPES = new Set([
  'Button',
  'Edit',
  'ComboBox',
  'RadioButton',
  'MenuItem',
  'CheckBox',
  'Hyperlink',
  'Slider',
  'TabItem',
]);

const CONTAINER_TYPES = new Set([
  'List',
  'DataGrid',
  'TreeView',
  'Tree',
  'Table',
  'Custom',
]);

const MIN_INTERACTIVE_SIZE = 24;

function toNodeArray(tree) {
  if (Array.isArray(tree)) {
    return tree.filter((node) => node && typeof node === 'object');
  }
  if (tree && typeof tree === 'object') {
    return [tree];
  }
  return [];
}

function normalizeBounds(bounds) {
  if (!bounds || typeof bounds !== 'object') {
    return null;
  }

  const x = Number(bounds.x);
  const y = Number(bounds.y);
  const w = Number(bounds.w);
  const h = Number(bounds.h);

  if (![x, y, w, h].every(Number.isFinite)) {
    return null;
  }

  return { x, y, w, h };
}

function hasAccessibleName(node) {
  return typeof node?.name === 'string' && node.name.trim().length > 0;
}

function buildParentSummary(node) {
  if (!node || typeof node !== 'object') {
    return null;
  }

  return {
    name: typeof node.name === 'string' ? node.name : '',
    automation_id: typeof node.automation_id === 'string' && node.automation_id ? node.automation_id : null,
    element_type: typeof node.type === 'string' ? node.type : null,
  };
}

function buildFlagKey(node, path, bounds) {
  const automationId = typeof node?.automation_id === 'string' ? node.automation_id.trim() : '';
  if (automationId) {
    return `automation_id:${automationId}`;
  }

  const name = typeof node?.name === 'string' ? node.name.trim() : '';
  const type = typeof node?.type === 'string' ? node.type : 'unknown';
  const boundsKey = bounds
    ? `${bounds.x},${bounds.y},${bounds.w},${bounds.h}`
    : 'no-bounds';

  return `path:${path}|type:${type}|name:${name || '(unnamed)'}|bounds:${boundsKey}`;
}

function addFinding(findings, flaggedElements, finding, node, path, bounds) {
  findings.push(finding);
  flaggedElements.add(buildFlagKey(node, path, bounds));
}

function analyzeElementTree(tree, sectionId) {
  const roots = toNodeArray(tree);
  const findings = [];
  const flaggedElements = new Set();
  const automationIdCounts = new Map();
  let totalElements = 0;
  let interactiveCount = 0;

  function walk(node, parent, path) {
    if (!node || typeof node !== 'object') {
      return;
    }

    totalElements += 1;

    const elementType = typeof node.type === 'string' ? node.type : '';
    const bounds = normalizeBounds(node.bounds);
    const children = Array.isArray(node.children)
      ? node.children.filter((child) => child && typeof child === 'object')
      : [];
    const automationId = typeof node.automation_id === 'string' ? node.automation_id.trim() : '';
    const isInteractive = INTERACTIVE_TYPES.has(elementType);
    const isContainer = CONTAINER_TYPES.has(elementType);

    if (automationId) {
      automationIdCounts.set(automationId, (automationIdCounts.get(automationId) || 0) + 1);
    }

    if (isInteractive) {
      interactiveCount += 1;

      if (!hasAccessibleName(node)) {
        addFinding(findings, flaggedElements, {
          check: 'missing_name',
          severity: 'HIGH',
          section_id: sectionId,
          automation_id: automationId || null,
          element_type: elementType || null,
          bounds,
          parent: buildParentSummary(parent),
        }, node, path, bounds);
      }

      if (bounds && (bounds.w < MIN_INTERACTIVE_SIZE || bounds.h < MIN_INTERACTIVE_SIZE)) {
        addFinding(findings, flaggedElements, {
          check: 'small_interactive',
          severity: 'LOW',
          section_id: sectionId,
          automation_id: automationId || null,
          element_name: typeof node.name === 'string' ? node.name : '',
          element_type: elementType || null,
          bounds,
          minimum_size: MIN_INTERACTIVE_SIZE,
        }, node, path, bounds);
      }
    }

    if (isContainer && children.length === 0) {
      addFinding(findings, flaggedElements, {
        check: 'empty_container',
        severity: 'MEDIUM',
        section_id: sectionId,
        automation_id: automationId || null,
        element_name: typeof node.name === 'string' ? node.name : '',
        element_type: elementType || null,
        bounds,
      }, node, path, bounds);
    }

    const parentBounds = normalizeBounds(parent?.bounds);
    if (bounds && parentBounds) {
      const overflowX = Math.max(0, (bounds.x + bounds.w) - (parentBounds.x + parentBounds.w));
      const overflowY = Math.max(0, (bounds.y + bounds.h) - (parentBounds.y + parentBounds.h));

      if (overflowX > 0 || overflowY > 0) {
        addFinding(findings, flaggedElements, {
          check: 'bounds_overflow',
          severity: 'MEDIUM',
          section_id: sectionId,
          element_name: typeof node.name === 'string' ? node.name : '',
          bounds,
          parent_bounds: parentBounds,
          overflow_x: overflowX,
          overflow_y: overflowY,
        }, node, path, bounds);
      }
    }

    children.forEach((child, index) => {
      walk(child, node, `${path}.${index}`);
    });
  }

  roots.forEach((node, index) => {
    walk(node, null, String(index));
  });

  for (const [automationId, count] of automationIdCounts.entries()) {
    if (count > 1) {
      findings.push({
        check: 'duplicate_automation_id',
        severity: 'MEDIUM',
        section_id: sectionId,
        automation_id: automationId,
        count,
      });
      flaggedElements.add(`automation_id:${automationId}`);
    }
  }

  return {
    findings,
    flagged_elements: [...flaggedElements],
    stats: {
      total_elements: totalElements,
      interactive: interactiveCount,
      checks_run: 5,
      findings: findings.length,
    },
  };
}

module.exports = {
  INTERACTIVE_TYPES,
  CONTAINER_TYPES,
  MIN_INTERACTIVE_SIZE,
  analyzeElementTree,
};
