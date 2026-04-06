'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { ErrorCodes, makeError } = require('../../../handlers/shared');
const {
  buildPeekBundleArtifactReferences,
  buildPeekDiagnosePayload,
  formatPeekArtifactReferenceSection,
  getPeekBundleContractSummary,
  validatePeekInvestigationBundleEnvelope,
} = require('../../../contracts/peek');
const {
  buildPeekPersistOutputDir,
  peekHttpGetWithRetry,
  postCompareWithRetry,
  peekHttpPostWithRetry,
  resolvePeekHost,
  resolvePeekTaskContext,
  sanitizePeekTargetKey,
} = require('./shared');
const {
  applyEvidenceStateToBundle,
  classifyEvidenceSufficiency,
  ensurePeekBundlePersistence,
  persistPeekResultReferences,
} = require('./artifacts');
const { getCompareImage } = require('./capture');
const logger = require('../../../logger').child({ component: 'peek-handlers' });

function resolvePeekWindowTarget(args, toolName) {
  if (args.process) {
    return { mode: 'process', name: args.process };
  }
  if (args.title) {
    return { mode: 'title', name: args.title };
  }
  throw new Error(`${toolName} requires process or title`);
}

function renderDiagnoseElementTree(lines, nodes, indent) {
  for (const node of (nodes || [])) {
    if (!node || typeof node !== 'object') continue;

    const bounds = node.bounds || {};
    const name = node.name || '(unnamed)';
    const type = node.type || '?';
    const automationId = node.automation_id ? ` [${node.automation_id}]` : '';
    const value = node.value ? ` = "${node.value}"` : '';
    const stateFlags = [];

    if (node.state && Array.isArray(node.state)) {
      stateFlags.push(...node.state);
    } else {
      if (!node.enabled && node.enabled !== undefined) stateFlags.push('disabled');
      if (node.toggle_state && node.toggle_state !== 'off') stateFlags.push(node.toggle_state);
      if (node.is_selected) stateFlags.push('selected');
      if (node.expand_state && node.expand_state !== 'leaf') stateFlags.push(node.expand_state);
    }

    if (node.scroll_position) {
      const scrollPosition = node.scroll_position;
      if (scrollPosition.vertical_percent != null) {
        stateFlags.push(`scroll:${scrollPosition.vertical_percent}%`);
      }
    }

    if (node.range_value) {
      const rangeValue = node.range_value;
      stateFlags.push(`range:${rangeValue.current}/${rangeValue.maximum}`);
    }

    const stateString = stateFlags.length > 0 ? ` {${stateFlags.join(', ')}}` : '';
    lines.push(
      `${indent}- **${name}** \`${type}\`${automationId} (${bounds.x || 0},${bounds.y || 0} ${bounds.w || 0}x${bounds.h || 0})${value}${stateString}`,
    );

    if (Array.isArray(node.children) && node.children.length > 0) {
      renderDiagnoseElementTree(lines, node.children, indent + '  ');
    }
  }
}

function renderPeekElementsTree(lines, elements, indent) {
  for (const element of elements) {
    const enabledString = element.enabled ? '' : ' [DISABLED]';
    const valueString = element.value != null ? ` value="${element.value}"` : '';
    const idString = element.automation_id ? ` id="${element.automation_id}"` : '';
    const bounds = element.bounds;
    const flags = [];

    if (element.toggle_state && element.toggle_state !== 'off') flags.push(element.toggle_state);
    if (element.is_selected) flags.push('selected');
    if (element.expand_state && element.expand_state !== 'leaf') flags.push(element.expand_state);
    if (element.scroll_position) {
      const scrollPosition = element.scroll_position;
      if (scrollPosition.vertical_percent != null) {
        flags.push(`scroll:${scrollPosition.vertical_percent}%`);
      }
    }
    if (element.range_value) flags.push(`range:${element.range_value.current}/${element.range_value.maximum}`);

    const stateString = flags.length > 0 ? ` {${flags.join(', ')}}` : '';
    lines.push(
      `${indent}${element.name || '(unnamed)'} [${element.type}]${idString}${valueString}${enabledString}${stateString} (${bounds.x},${bounds.y} ${bounds.w}x${bounds.h})`,
    );

    if (element.children && element.children.length > 0) {
      renderPeekElementsTree(lines, element.children, indent + '  ');
    }
  }
}

async function handlePeekElements(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const payload = {};

    if (args.process) {
      payload.mode = 'process';
      payload.name = args.process;
    } else if (args.title) {
      payload.mode = 'title';
      payload.name = args.title;
    } else {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'process or title is required');
    }

    if (args.find) {
      payload.find = args.find;
      if (args.parent_name) payload.parent_name = args.parent_name;
      if (args.parent_automation_id) payload.parent_automation_id = args.parent_automation_id;
      if (args.region) payload.region = args.region;
      if (args.index != null) payload.index = args.index;
      if (args.near) payload.near = args.near;
    } else {
      payload.depth = args.depth || 3;
      if (args.types) payload.types = args.types;
    }

    const result = await peekHttpPostWithRetry(hostUrl + '/elements', payload, timeoutMs);

    if (result.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Element inspection failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, result.data.error);
    }

    if (args.find) {
      const element = result.data;
      const lines = [
        `## peek_elements: find "${args.find}"`,
        `**Host:** ${hostName}`,
        `**Name:** ${element.name}`,
        `**Type:** ${element.type}`,
        `**Automation ID:** ${element.automation_id || '-'}`,
        `**Bounds:** (${element.bounds.x}, ${element.bounds.y}, ${element.bounds.w}x${element.bounds.h})`,
        `**Center:** (${element.center.x}, ${element.center.y})`,
        `**Enabled:** ${element.enabled}`,
      ];
      if (element.path && Array.isArray(element.path)) lines.push(`**Path:** ${element.path.join(' > ')}`);
      if (element.state && Array.isArray(element.state)) lines.push(`**State:** ${element.state.join(', ')}`);
      if (element.value != null) lines.push(`**Value:** ${element.value}`);
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const data = result.data;
    const lines = [
      '## peek_elements',
      `**Host:** ${hostName}`,
      `**Window:** ${data.window?.name || 'unknown'}`,
      `**Total Elements:** ${data.count || 0}`,
      '',
    ];

    renderPeekElementsTree(lines, data.elements || [], '');

    if (data.focused_element) {
      const focusedElement = data.focused_element;
      const bounds = focusedElement.bounds || {};
      lines.push('', `Focused: ${focusedElement.name || '(unnamed)'} [${focusedElement.type || '?'}] (${bounds.x || 0},${bounds.y || 0} ${bounds.w || 0}x${bounds.h || 0})`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekWait(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 30) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.conditions || !Array.isArray(args.conditions) || args.conditions.length === 0) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'conditions is required and must be a non-empty array');
    }

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_wait');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    payload.conditions = args.conditions;
    if (args.wait_timeout != null) payload.timeout_seconds = args.wait_timeout;
    if (args.poll_interval != null) payload.poll_interval_seconds = args.poll_interval;
    if (args.match_mode) payload.match_mode = args.match_mode;

    const result = await peekHttpPostWithRetry(hostUrl + '/wait', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_wait failed: ${result.error}`);
    }
    if (result.data && result.data.error && !result.data.success) {
      if (result.data.error !== 'timeout') {
        return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
      }
    }

    const waitData = result.data || {};
    const lines = [
      '## Wait Result',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
      `**Success:** ${waitData.success ? 'Yes' : 'No (timeout)'}`,
      `**Elapsed:** ${(waitData.elapsed_seconds || 0).toFixed(2)}s`,
      `**Polls:** ${waitData.polls || 0}`,
    ];

    const conditionsMet = waitData.conditions_met || [];
    if (conditionsMet.length > 0) {
      lines.push('', '### Conditions');
      for (const conditionResult of conditionsMet) {
        const condition = conditionResult.condition || {};
        const icon = conditionResult.met ? '✓' : '✗';
        lines.push(`- ${icon} **${condition.type || '?'}** ${condition.name || condition.text || condition.element_type || ''} — ${conditionResult.detail || ''}`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekOcr(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_ocr');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    if (args.region) {
      payload.region = args.region;
    }

    const result = await peekHttpPostWithRetry(hostUrl + '/ocr', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_ocr failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const ocrData = result.data || {};
    const lines = [
      '## OCR Results',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
    ];

    if (args.region) {
      lines.push(`**Region:** x=${args.region.x} y=${args.region.y} w=${args.region.w} h=${args.region.h}`);
    }

    lines.push(`**Confidence:** ${ocrData.confidence || 0}%`);

    if (ocrData.text) {
      lines.push('', '### Extracted Text', '```', ocrData.text, '```');
    }

    const ocrLines = ocrData.lines || [];
    if (ocrLines.length > 0) {
      lines.push('', `### Lines (${ocrLines.length})`);
      for (const line of ocrLines) {
        const bounds = line.bounds || {};
        lines.push(`- "${line.text}" (confidence: ${line.confidence}, bounds: ${bounds.x},${bounds.y} ${bounds.w}x${bounds.h})`);
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekAssert(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.assertions || !Array.isArray(args.assertions) || args.assertions.length === 0) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'assertions is required and must be a non-empty array');
    }

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_assert');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    payload.assertions = args.assertions;

    const result = await peekHttpPostWithRetry(hostUrl + '/assert', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_assert failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const assertData = result.data || {};
    const lines = [
      '## Assertion Results',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
      `**Overall:** ${assertData.passed ? 'PASS' : 'FAIL'} (${assertData.passed_count || 0}/${assertData.total || 0} passed)`,
    ];

    const results = assertData.results || [];
    if (results.length > 0) {
      lines.push('');
      for (const resultItem of results) {
        const icon = resultItem.passed ? '✅' : '❌';
        const assertion = resultItem.assertion || {};
        let description = assertion.type || '?';
        if (assertion.name) description += ` name="${assertion.name}"`;
        if (assertion.automation_id) description += ` id="${assertion.automation_id}"`;
        if (assertion.element_type) description += ` type=${assertion.element_type}`;
        if (assertion.expected_text) description += ` text="${assertion.expected_text}"`;
        if (assertion.expected_state) description += ` state=${assertion.expected_state}`;
        if (assertion.exact != null) description += ` exact=${assertion.exact}`;
        if (assertion.min != null) description += ` min=${assertion.min}`;
        if (assertion.max != null) description += ` max=${assertion.max}`;
        lines.push(`${icon} **${description}** — ${resultItem.message || ''}`);
        if (!resultItem.passed && resultItem.actual) {
          lines.push(`   Actual: ${JSON.stringify(resultItem.actual)}`);
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekHitTest(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (args.x == null || args.y == null) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'x and y coordinates are required');
    }

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_hit_test');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }
    payload.x = args.x;
    payload.y = args.y;

    const result = await peekHttpPostWithRetry(hostUrl + '/hit-test', payload, timeoutMs);
    if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_hit_test failed: ${result.error}`);
    if (result.data && result.data.error) return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);

    const hitData = result.data || {};
    const lines = [
      '## Hit-Test Result',
      `**Host:** ${hostName}`,
      `**Coordinates:** (${args.x}, ${args.y})`,
      `**Element:** ${hitData.name || '(unnamed)'} (${hitData.type || '?'})`,
    ];
    if (hitData.automation_id) lines.push(`**Automation ID:** ${hitData.automation_id}`);
    if (hitData.bounds) lines.push(`**Bounds:** x=${hitData.bounds.x} y=${hitData.bounds.y} w=${hitData.bounds.w} h=${hitData.bounds.h}`);
    if (hitData.center) lines.push(`**Center:** (${hitData.center.x}, ${hitData.center.y})`);
    if (hitData.path && Array.isArray(hitData.path)) lines.push(`**Path:** ${hitData.path.join(' > ')}`);
    if (hitData.value !== undefined) lines.push(`**Value:** ${hitData.value}`);
    if (hitData.state && Array.isArray(hitData.state)) lines.push(`**State:** ${hitData.state.join(', ')}`);
    lines.push(`**Enabled:** ${hitData.enabled !== false}`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekColor(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_color');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    if (args.element) payload.element = args.element;
    else if (args.points) payload.points = args.points;
    else return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'peek_color requires element or points');

    const result = await peekHttpPostWithRetry(hostUrl + '/color', payload, timeoutMs);
    if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_color failed: ${result.error}`);
    if (result.data && result.data.error) return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);

    const colorData = result.data || {};
    const lines = ['## Color Samples', `**Host:** ${hostName}`];

    if (colorData.element_bounds) {
      const bounds = colorData.element_bounds;
      lines.push(`**Element bounds:** x=${bounds.x} y=${bounds.y} w=${bounds.w} h=${bounds.h}`);
      if (colorData.samples && typeof colorData.samples === 'object') {
        lines.push('');
        for (const [position, sample] of Object.entries(colorData.samples)) {
          if (sample.error) {
            lines.push(`- **${position}:** (${sample.x}, ${sample.y}) — ${sample.error}`);
          } else {
            lines.push(`- **${position}:** (${sample.x}, ${sample.y}) → ${sample.hex} (R=${sample.r} G=${sample.g} B=${sample.b})`);
          }
        }
      }
    } else if (colorData.samples && Array.isArray(colorData.samples)) {
      lines.push(`**Points sampled:** ${colorData.count || colorData.samples.length}`);
      lines.push('');
      for (const sample of colorData.samples) {
        if (sample.error) {
          lines.push(`- (${sample.x}, ${sample.y}) — ${sample.error}`);
        } else {
          lines.push(`- (${sample.x}, ${sample.y}) → ${sample.hex} (R=${sample.r} G=${sample.g} B=${sample.b})`);
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekTable(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_table');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    if (args.table_name) payload.table_name = args.table_name;
    if (args.table_automation_id) payload.table_automation_id = args.table_automation_id;
    if (args.table_type) payload.table_type = args.table_type;
    if (args.depth) payload.depth = args.depth;

    const result = await peekHttpPostWithRetry(hostUrl + '/table', payload, timeoutMs);
    if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_table failed: ${result.error}`);
    if (result.data && result.data.error) return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);

    const tableData = result.data || {};
    const lines = [
      `## Table: ${tableData.name || '(unnamed)'}`,
      `**Host:** ${hostName}`,
      `**Type:** ${tableData.type || '?'}`,
      `**Rows:** ${tableData.row_count || 0} | **Columns:** ${tableData.column_count || 0}`,
    ];

    if (tableData.columns && tableData.columns.length > 0) {
      lines.push(`**Headers:** ${tableData.columns.join(' | ')}`);
    }

    if (tableData.selected_rows && tableData.selected_rows.length > 0) {
      lines.push(`**Selected rows:** ${tableData.selected_rows.join(', ')}`);
    }

    if (tableData.rows && tableData.rows.length > 0) {
      lines.push('');
      if (tableData.columns && tableData.columns.length > 0) {
        lines.push('| ' + tableData.columns.join(' | ') + ' |');
        lines.push('| ' + tableData.columns.map(() => '---').join(' | ') + ' |');
        for (const row of tableData.rows.slice(0, 50)) {
          const cells = row.cells || [row.name || ''];
          const paddedCells = tableData.columns.map((_, index) => cells[index] || '');
          lines.push('| ' + paddedCells.join(' | ') + ' |');
        }
        if (tableData.rows.length > 50) {
          lines.push(`... and ${tableData.rows.length - 50} more rows`);
        }
      } else {
        for (const row of tableData.rows.slice(0, 50)) {
          const display = row.cells ? row.cells.join(' | ') : (row.name || '');
          lines.push(`- ${display}`);
        }
        if (tableData.rows.length > 50) {
          lines.push(`... and ${tableData.rows.length - 50} more rows`);
        }
      }
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekSummary(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_summary');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    if (args.depth) payload.depth = args.depth;

    const result = await peekHttpPostWithRetry(hostUrl + '/summary', payload, timeoutMs);
    if (result.error) return makeError(ErrorCodes.OPERATION_FAILED, `peek_summary failed: ${result.error}`);
    if (result.data && result.data.error) return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);

    const summaryData = result.data || {};
    const lines = [
      '## Scene Summary',
      `**Host:** ${hostName}`,
      `**Window:** ${summaryData.window || '(unknown)'}`,
      `**Size:** ${summaryData.size || 'unknown'}`,
      `**Elements:** ${summaryData.element_count || 0}`,
      '',
    ];

    if (summaryData.buttons && summaryData.buttons.length > 0) {
      lines.push(`**Buttons:** ${summaryData.buttons.join(', ')}`);
    }
    if (summaryData.input_fields && summaryData.input_fields.length > 0) {
      const inputLines = summaryData.input_fields.map((field) => `  - ${field.label || '(unnamed)'}: "${field.value || ''}"`);
      lines.push('**Inputs:**');
      lines.push(...inputLines);
    }
    if (summaryData.tabs && summaryData.tabs.length > 0) {
      lines.push(`**Tabs:** ${summaryData.tabs.join(', ')}`);
    }
    if (summaryData.lists && summaryData.lists.length > 0) {
      const listLines = summaryData.lists.map((list) => `  - ${list.name || '(unnamed)'}: ${list.item_count} items`);
      lines.push('**Lists:**');
      lines.push(...listLines);
    }
    if (summaryData.visible_text && summaryData.visible_text.length > 0) {
      lines.push('');
      lines.push('**Visible Text (reading order):**');
      for (const text of summaryData.visible_text) {
        lines.push(`  - ${text}`);
      }
    }
    if (summaryData.summary) {
      lines.push('');
      lines.push(`**Summary:** ${summaryData.summary}`);
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekCdp(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 15) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const payload = {
      action: args.action || 'status',
      port: args.port || 9222,
      url: args.url || '',
      title: args.title || '',
      expression: args.expression || '',
      timeout: Math.min((args.timeout_seconds || 15), 30),
      depth: args.depth || 3,
    };

    const result = await peekHttpPostWithRetry(hostUrl + '/cdp', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `CDP failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `CDP error: ${result.data.error}`);
    }

    const lines = [`## peek_cdp — ${payload.action}`, `**Host:** ${hostName}`];
    const cdpData = result.data || {};

    if (payload.action === 'status') {
      lines.push(`**CDP Available:** ${cdpData.cdp_available ? 'Yes' : 'No'}`);
      lines.push(`**Port:** ${cdpData.port}`);
      if (cdpData.targets && cdpData.targets.length > 0) {
        lines.push(`**Open Tabs:** ${cdpData.targets.length}`);
        for (const target of cdpData.targets) {
          lines.push(`- ${target.title || '(untitled)'} — ${target.url || ''}`);
        }
      }
    } else if (payload.action === 'targets') {
      const targets = cdpData.targets || [];
      lines.push(`**Targets:** ${targets.length}`);
      for (const target of targets) {
        lines.push(`- [${target.type}] ${target.title || '(untitled)'} — ${target.url || ''}`);
      }
    } else if (payload.action === 'navigate') {
      lines.push(`**Navigated to:** ${cdpData.url || args.url}`);
    } else if (payload.action === 'evaluate') {
      lines.push(`**Expression:** \`${args.expression}\``);
      lines.push(`**Type:** ${cdpData.type || 'unknown'}`);
      lines.push(`**Value:** ${JSON.stringify(cdpData.value, null, 2)}`);
    } else if (payload.action === 'console') {
      const messages = cdpData.messages || [];
      lines.push(`**Console Messages:** ${messages.length}`);
      for (const message of messages) {
        lines.push(`- [${message.level}] ${message.text}`);
      }
    } else if (payload.action === 'dom') {
      lines.push('```json');
      lines.push(JSON.stringify(cdpData, null, 2).substring(0, 3000));
      lines.push('```');
    } else {
      lines.push('```json');
      lines.push(JSON.stringify(cdpData, null, 2));
      lines.push('```');
    }

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekRegression(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 60) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    const action = args.action || 'compare';
    const regressionRoot = path.join(os.homedir(), '.peek-ui', 'regression');

    if (action === 'list') {
      if (!fs.existsSync(regressionRoot)) {
        return { content: [{ type: 'text', text: '## peek_regression\n\nNo snapshots found.' }] };
      }
      const dirs = fs.readdirSync(regressionRoot).filter((dir) =>
        fs.statSync(path.join(regressionRoot, dir)).isDirectory()
      ).sort().reverse();

      if (dirs.length === 0) {
        return { content: [{ type: 'text', text: '## peek_regression\n\nNo snapshots found.' }] };
      }

      const lines = ['## peek_regression: snapshots', '', '| Snapshot | Windows |', '|---------|---------|'];
      for (const dir of dirs.slice(0, 20)) {
        const metaPath = path.join(regressionRoot, dir, 'metadata.json');
        let windowCount = '?';
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            windowCount = String(meta.windows?.length || 0);
          } catch (err) {
            logger.debug(`[peek_ui] Failed to read meta: ${err.message}`);
          }
        }
        lines.push(`| ${dir} | ${windowCount} |`);
      }
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    const listResult = await peekHttpGetWithRetry(hostUrl + '/list', 5000);
    if (listResult.error) {
      return makeError(ErrorCodes.INTERNAL_ERROR, `Failed to list windows: ${listResult.error}`);
    }

    let windows = listResult.data?.windows || [];
    if (args.process) {
      const needle = args.process.toLowerCase();
      windows = windows.filter((window) =>
        (window.process || '').toLowerCase().includes(needle)
      );
    }

    if (windows.length === 0) {
      return makeError(ErrorCodes.INVALID_PARAM, `No windows found${args.process ? ` for process: ${args.process}` : ''}`);
    }

    if (action === 'snapshot') {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const snapshotDir = path.join(regressionRoot, timestamp);
      fs.mkdirSync(snapshotDir, { recursive: true });

      const metadata = { timestamp, host: hostName, windows: [] };
      let captured = 0;

      for (const window of windows) {
        const processName = (window.process || 'unknown').replace(/\.exe$/i, '');
        const safeTitle = sanitizePeekTargetKey(window.title, 'untitled');
        const key = `${sanitizePeekTargetKey(processName, 'proc')}-${safeTitle}`;

        const params = new URLSearchParams({
          mode: 'process',
          name: processName,
          format: 'png',
          max_width: '99999',
        });

        const captureResult = await peekHttpGetWithRetry(
          hostUrl + '/peek?' + params.toString(),
          timeoutMs,
        );

        if (captureResult.error || !captureResult.data?.image) continue;

        const imageBuffer = Buffer.from(captureResult.data.image, 'base64');
        const filePath = path.join(snapshotDir, `${key}.png`);
        fs.writeFileSync(filePath, imageBuffer);

        metadata.windows.push({
          key,
          process: processName,
          title: window.title,
          hwnd: window.hwnd,
          width: captureResult.data.width,
          height: captureResult.data.height,
          file: `${key}.png`,
        });
        captured++;
      }

      fs.writeFileSync(
        path.join(snapshotDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2),
      );

      const lines = [
        '## peek_regression: snapshot',
        `**Host:** ${hostName}`,
        `**Snapshot:** ${timestamp}`,
        `**Windows Captured:** ${captured}/${windows.length}`,
        `**Saved to:** ${snapshotDir}`,
        '',
        '| Window | Size |',
        '|--------|------|',
      ];

      for (const window of metadata.windows) {
        lines.push(`| ${window.process} — ${window.title} | ${window.width}x${window.height} |`);
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    if (action === 'compare') {
      let snapshotDir;
      if (args.snapshot_id) {
        const resolved = path.resolve(regressionRoot, args.snapshot_id);
        if (!resolved.startsWith(path.resolve(regressionRoot) + path.sep)) {
          return makeError(ErrorCodes.INVALID_PARAM, 'Invalid snapshot_id');
        }
        snapshotDir = path.join(regressionRoot, args.snapshot_id);
      } else {
        if (!fs.existsSync(regressionRoot)) {
          return makeError(ErrorCodes.INVALID_PARAM, 'No snapshots found. Run peek_regression with action "snapshot" first.');
        }
        const dirs = fs.readdirSync(regressionRoot).filter((dir) =>
          fs.statSync(path.join(regressionRoot, dir)).isDirectory()
        ).sort().reverse();
        if (dirs.length === 0) {
          return makeError(ErrorCodes.INVALID_PARAM, 'No snapshots found. Run peek_regression with action "snapshot" first.');
        }
        snapshotDir = path.join(regressionRoot, dirs[0]);
      }

      const metaPath = path.join(snapshotDir, 'metadata.json');
      if (!fs.existsSync(metaPath)) {
        return makeError(ErrorCodes.INVALID_PARAM, `Snapshot metadata not found: ${metaPath}`);
      }

      const metadata = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const threshold = args.diff_threshold ?? 0.01;
      const ignoreRegions = args.ignore_regions || null;

      const results = [];
      const content = [];

      for (const baselineWindow of metadata.windows) {
        const baselinePath = path.join(snapshotDir, baselineWindow.file);
        if (!fs.existsSync(baselinePath)) continue;

        const params = new URLSearchParams({
          mode: 'process',
          name: baselineWindow.process,
          format: 'png',
          max_width: '99999',
        });

        const captureResult = await peekHttpGetWithRetry(
          hostUrl + '/peek?' + params.toString(),
          timeoutMs,
        );

        if (captureResult.error || !captureResult.data?.image) {
          results.push({
            window: `${baselineWindow.process} — ${baselineWindow.title}`,
            status: 'CAPTURE_FAILED',
            error: captureResult.error || 'No image data',
          });
          continue;
        }

        const baselineB64 = fs.readFileSync(baselinePath).toString('base64');
        const compareResult = await postCompareWithRetry(
          hostUrl,
          baselineB64,
          captureResult.data.image,
          threshold,
          timeoutMs,
          2,
          ignoreRegions,
        );

        if (compareResult.error) {
          results.push({
            window: `${baselineWindow.process} — ${baselineWindow.title}`,
            status: 'COMPARE_FAILED',
            error: compareResult.error,
          });
          continue;
        }

        const compareData = compareResult.data;
        const diffPercent = compareData.diff_percent ?? 0;
        const changedPixels = compareData.changed_pixels ?? 0;
        const hasDiff = compareData.has_differences ?? diffPercent > 0;

        results.push({
          window: `${baselineWindow.process} — ${baselineWindow.title}`,
          status: hasDiff ? 'CHANGED' : 'UNCHANGED',
          diff_percent: diffPercent,
          changed_pixels: changedPixels,
        });

        if (hasDiff) {
          const diffImage = getCompareImage(compareData);
          if (diffImage) {
            content.push({
              type: 'text',
              text: `### Diff: ${baselineWindow.process} — ${baselineWindow.title}`,
            });
            content.push({
              type: 'image',
              data: diffImage.data,
              mimeType: diffImage.mimeType,
            });
          }
        }
      }

      const summaryLines = [
        '## peek_regression: compare',
        `**Host:** ${hostName}`,
        `**Baseline:** ${metadata.timestamp}`,
        `**Threshold:** ${(threshold * 100).toFixed(2)}%`,
        '',
        '| Window | Status | Diff % | Changed Pixels |',
        '|--------|--------|--------|----------------|',
      ];

      for (const result of results) {
        if (result.error) {
          summaryLines.push(`| ${result.window} | ${result.status} | - | ${result.error} |`);
        } else {
          summaryLines.push(
            `| ${result.window} | ${result.status} | ${(result.diff_percent * 100).toFixed(2)}% | ${result.changed_pixels.toLocaleString()} |`,
          );
        }
      }

      const changed = results.filter((result) => result.status === 'CHANGED').length;
      const unchanged = results.filter((result) => result.status === 'UNCHANGED').length;
      const failed = results.filter((result) => result.status.includes('FAILED')).length;

      summaryLines.push('');
      summaryLines.push(`**Summary:** ${changed} changed, ${unchanged} unchanged, ${failed} failed`);

      content.unshift({ type: 'text', text: summaryLines.join('\n') });

      return { content };
    }

    return makeError(ErrorCodes.INVALID_PARAM, `Unknown action: ${action}. Use snapshot, compare, or list.`);
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekDiagnose(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 30) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;
    const taskContext = resolvePeekTaskContext(args);

    let payload;
    try {
      payload = buildPeekDiagnosePayload(args);
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }
    payload.persist = true;
    const persistOutputDir = buildPeekPersistOutputDir(taskContext, args);
    if (persistOutputDir) {
      payload.output_dir = persistOutputDir;
    }

    const result = await peekHttpPostWithRetry(hostUrl + '/diagnose', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_diagnose failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const diagnoseData = result.data || {};
    if (!diagnoseData.bundle || typeof diagnoseData.bundle !== 'object') {
      return makeError(ErrorCodes.OPERATION_FAILED, 'peek_diagnose returned malformed response: bundle is required');
    }

    const bundleValidationErrors = validatePeekInvestigationBundleEnvelope(diagnoseData.bundle);
    if (bundleValidationErrors.length > 0) {
      return makeError(
        ErrorCodes.OPERATION_FAILED,
        `peek_diagnose returned malformed bundle: ${bundleValidationErrors.join('; ')}`,
      );
    }

    const evidenceSufficiency = classifyEvidenceSufficiency(diagnoseData.bundle);
    const evidenceState = evidenceSufficiency.sufficient ? 'complete' : 'insufficient';
    const missingEvidenceFields = evidenceSufficiency.sufficient ? [] : evidenceSufficiency.missing;
    applyEvidenceStateToBundle(diagnoseData.bundle, evidenceSufficiency);
    ensurePeekBundlePersistence(diagnoseData.bundle, persistOutputDir, args);
    const bundleSummary = getPeekBundleContractSummary(diagnoseData.bundle);
    const bundleRefs = buildPeekBundleArtifactReferences(diagnoseData.bundle, {
      host: hostName,
      target: args.process || args.title || null,
      task_id: taskContext.taskId,
      workflow_id: taskContext.workflowId,
      task_label: taskContext.taskLabel,
    });
    const storedRefs = persistPeekResultReferences(taskContext, bundleRefs);
    const displayRefs = storedRefs.length > 0 ? storedRefs : bundleRefs;
    const screenshotB64 = diagnoseData.screenshot
      || diagnoseData.bundle?.capture_data?.image_base64
      || diagnoseData.bundle?.evidence?.screenshot?.data
      || null;
    const annotatedB64 = diagnoseData.annotated_screenshot || diagnoseData.bundle?.evidence?.annotated_screenshot?.data || null;
    const ext = diagnoseData.format || args.format || 'jpeg';
    const content = [];

    if (screenshotB64) {
      content.push({
        type: 'image',
        data: screenshotB64,
        mimeType: `image/${ext}`,
      });
    }

    if (payload.annotate && annotatedB64) {
      content.push({
        type: 'image',
        data: annotatedB64,
        mimeType: `image/${ext}`,
      });
    }

    const lines = [
      '## Diagnostic Bundle',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
      `**Evidence State:** ${evidenceState}`,
      missingEvidenceFields.length > 0 ? `**Missing Evidence:** ${missingEvidenceFields.join(', ')}` : null,
      bundleSummary ? `**Bundle Contract:** ${bundleSummary.name} v${bundleSummary.version}` : null,
      bundleSummary && bundleSummary.slice ? `**Bundle Slice:** ${bundleSummary.slice}` : null,
      bundleSummary && bundleSummary.created_at ? `**Bundle Created:** ${bundleSummary.created_at}` : null,
      bundleSummary && bundleSummary.persisted != null
        ? `**Artifacts Persisted:** ${bundleSummary.persisted ? 'Yes' : 'No'}`
        : null,
      bundleSummary && bundleSummary.signed != null
        ? `**Bundle Signed:** ${bundleSummary.signed ? 'Yes' : 'No'}`
        : null,
    ];

    const measurements = diagnoseData.measurements || {};
    if (measurements.window_size) {
      lines.push(`**Window Size:** ${measurements.window_size.w}x${measurements.window_size.h}`);
    }

    const elementsRaw = diagnoseData.elements || {};
    const elementTree = Array.isArray(elementsRaw) ? elementsRaw : (elementsRaw.tree || []);
    const elementCount = Array.isArray(elementsRaw) ? elementsRaw.length : (elementsRaw.count || elementTree.length);

    if (elementTree.length > 0) {
      lines.push('', `### Element Tree (${elementCount} elements)`);
      renderDiagnoseElementTree(lines, elementTree, '');
    }

    const focusedElement = diagnoseData.elements && diagnoseData.elements.focused_element;
    if (focusedElement) {
      const bounds = focusedElement.bounds || {};
      lines.push('', '### Focused Element');
      lines.push(`**${focusedElement.name || '(unnamed)'}** \`${focusedElement.type || '?'}\` at (${bounds.x || 0},${bounds.y || 0} ${bounds.w || 0}x${bounds.h || 0})`);
    }

    const textContent = diagnoseData.text_content || {};
    lines.push('', '### Text Content');
    if (textContent.summary) lines.push(`*${textContent.summary}*`);

    if (textContent.inputs && textContent.inputs.length) {
      lines.push('', '**Inputs:**');
      for (const input of textContent.inputs.slice(0, 20)) {
        const automationId = input.automation_id ? ` [${input.automation_id}]` : '';
        lines.push(`- ${input.name || '(unnamed)'}${automationId} = "${input.value || ''}"`);
      }
      if (textContent.inputs.length > 20) lines.push(`- ... +${textContent.inputs.length - 20} more`);
    }

    if (textContent.labels_and_values && textContent.labels_and_values.length) {
      lines.push('', '**Label-Value Pairs:**');
      for (const labelValue of textContent.labels_and_values.slice(0, 15)) {
        lines.push(`- ${labelValue.label} "${labelValue.value || ''}"`);
      }
    }

    if (textContent.by_type && Object.keys(textContent.by_type).length) {
      lines.push('', '**Text by Type:**');
      for (const [type, values] of Object.entries(textContent.by_type)) {
        if (!Array.isArray(values) || !values.length) continue;
        const display = values
          .slice(0, 10)
          .map((value) => (typeof value === 'object' ? `${value.name || '?'}="${value.value || ''}"` : String(value)));
        const suffix = values.length > 10 ? ` (+${values.length - 10} more)` : '';
        lines.push(`- **${type}:** ${display.join(', ')}${suffix}`);
      }
    }

    if (!textContent.summary && textContent.buttons) {
      if (textContent.buttons.length) lines.push(`**Buttons:** ${textContent.buttons.join(', ')}`);
      if (textContent.labels && textContent.labels.length) lines.push(`**Labels:** ${textContent.labels.join(', ')}`);
    }

    if (measurements.spacing && measurements.spacing.length > 0) {
      lines.push('', '### Layout Measurements');
      for (const spacing of measurements.spacing.slice(0, 20)) {
        lines.push(`- **${spacing.a}** ↔ **${spacing.b}**: gap_x=${spacing.gap_x}px, gap_y=${spacing.gap_y}px (${spacing.alignment})`);
      }
      if (measurements.spacing.length > 20) {
        lines.push(`- ... +${measurements.spacing.length - 20} more`);
      }
    }

    if (measurements.element_summary && measurements.element_summary.length > 0) {
      lines.push('', '### Element Summary');
      for (const element of measurements.element_summary.slice(0, 15)) {
        const bounds = element.bounds || {};
        lines.push(`- **${element.name || '?'}** \`${element.type || '?'}\` at (${bounds.x || 0},${bounds.y || 0}) ${bounds.w || 0}x${bounds.h || 0}`);
      }
    }

    const annotationIndex = diagnoseData.annotation_index || [];
    if (annotationIndex.length > 0) {
      lines.push('', '### Annotation Legend');
      for (const entry of annotationIndex.slice(0, 40)) {
        const bounds = entry.bounds || {};
        const automationId = entry.automation_id ? ` [${entry.automation_id}]` : '';
        lines.push(`- **${entry.number}** — ${entry.name || '(unnamed)'} \`${entry.type}\`${automationId} (${bounds.x || 0},${bounds.y || 0} ${bounds.w || 0}x${bounds.h || 0})`);
      }
      if (annotationIndex.length > 40) {
        lines.push(`- ... +${annotationIndex.length - 40} more`);
      }
    }

    const artifactSection = formatPeekArtifactReferenceSection(displayRefs);
    if (artifactSection) {
      lines.push('', ...artifactSection.trim().split('\n'));
    }

    content.push({ type: 'text', text: lines.filter(Boolean).join('\n') });

    return {
      content,
      evidence_state: evidenceState,
      evidence_sufficiency: evidenceSufficiency,
      missing_evidence_fields: missingEvidenceFields,
      peek_bundle_artifacts: displayRefs,
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekSemanticDiff(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 30) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.baseline_elements || !Array.isArray(args.baseline_elements)) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'baseline_elements is required and must be an array of element tree nodes');
    }

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_semantic_diff');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    payload.baseline_elements = args.baseline_elements;
    if (args.depth != null) payload.depth = args.depth;
    if (args.match_strategy) payload.match_strategy = args.match_strategy;
    if (args.include_screenshot) payload.include_screenshot = true;
    if (args.format) payload.format = args.format;
    if (args.quality != null) payload.quality = args.quality;
    if (args.max_width != null) payload.max_width = args.max_width;

    const result = await peekHttpPostWithRetry(hostUrl + '/semantic-diff', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_semantic_diff failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const diffData = result.data || {};
    const content = [];

    if (args.include_screenshot && diffData.screenshot) {
      const ext = args.format || 'jpeg';
      content.push({
        type: 'image',
        data: diffData.screenshot,
        mimeType: `image/${ext}`,
      });
    }

    const lines = [
      '## Semantic Diff',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
      `**Match Strategy:** ${args.match_strategy || 'name+type'}`,
      `**Summary:** ${diffData.summary || 'no changes'}`,
      `**Matched:** ${diffData.matched_count || 0} elements`,
      `**Unmatched Baseline:** ${diffData.unmatched_baseline || 0}`,
      `**Unmatched Current:** ${diffData.unmatched_current || 0}`,
    ];

    const changes = diffData.changes || [];
    if (changes.length > 0) {
      lines.push('', '### Changes');
      for (const change of changes.slice(0, 30)) {
        const element = change.element || {};
        const name = element.name || element.automation_id || '(unnamed)';
        const type = element.type || '?';

        if (change.type === 'added') {
          lines.push(`- **+ ADDED** \`${name}\` (${type})`);
        } else if (change.type === 'removed') {
          lines.push(`- **- REMOVED** \`${name}\` (${type})`);
        } else if (change.type === 'moved') {
          const from = change.from || {};
          const to = change.to || {};
          const delta = change.delta || {};
          lines.push(`- **↔ MOVED** \`${name}\` (${type}) from (${from.x},${from.y}) to (${to.x},${to.y}) [Δ${delta.x},Δ${delta.y}]`);
        } else if (change.type === 'resized') {
          const from = change.from || {};
          const to = change.to || {};
          lines.push(`- **⇔ RESIZED** \`${name}\` (${type}) from ${from.w}x${from.h} to ${to.w}x${to.h}`);
        } else if (change.type === 'text_changed') {
          lines.push(`- **✎ TEXT** \`${name}\` (${type}): "${change.from_value || ''}" → "${change.to_value || ''}"`);
        }
      }
      if (changes.length > 30) {
        lines.push(`- ... +${changes.length - 30} more changes`);
      }
    } else {
      lines.push('', 'No structural changes detected.');
    }

    content.push({ type: 'text', text: lines.join('\n') });
    return { content };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekActionSequence(args) {
  try {
    const timeoutMs = ((args.timeout_seconds || 60) * 1000);
    const resolvedHost = resolvePeekHost(args);
    if (resolvedHost.error) return resolvedHost.error;
    const { hostName, hostUrl } = resolvedHost;

    if (!args.steps || !Array.isArray(args.steps) || args.steps.length === 0) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'steps is required and must be a non-empty array');
    }

    let payload;
    try {
      payload = resolvePeekWindowTarget(args, 'peek_action_sequence');
    } catch (err) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, err.message || String(err));
    }

    payload.steps = args.steps;

    const result = await peekHttpPostWithRetry(hostUrl + '/action-sequence', payload, timeoutMs);
    if (result.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, `peek_action_sequence failed: ${result.error}`);
    }
    if (result.data && result.data.error) {
      return makeError(ErrorCodes.OPERATION_FAILED, result.data.error);
    }

    const sequenceData = result.data || {};
    const content = [];
    const stepResults = sequenceData.step_results || [];

    for (const stepResult of stepResults) {
      if (stepResult.action === 'capture' && stepResult.success && stepResult.image) {
        const ext = stepResult.format || 'jpeg';
        content.push({
          type: 'image',
          data: stepResult.image,
          mimeType: `image/${ext}`,
        });
      }
    }

    const lines = [
      '## Action Sequence',
      `**Host:** ${hostName}`,
      `**Target:** ${args.process || args.title}`,
      `**Success:** ${sequenceData.success ? 'Yes' : 'No'}`,
      `**Steps:** ${sequenceData.steps_completed || 0}/${sequenceData.steps_total || 0}`,
      `**Elapsed:** ${(sequenceData.elapsed_seconds || 0).toFixed(2)}s`,
    ];

    if (stepResults.length > 0) {
      lines.push('', '### Step Results');
      for (const stepResult of stepResults) {
        const icon = stepResult.success ? '✓' : '✗';
        let detail = stepResult.detail || '';
        if (stepResult.action === 'capture' && stepResult.success) {
          detail = `${stepResult.width}x${stepResult.height} ${stepResult.format || 'jpeg'}`;
        } else if (stepResult.action === 'wait' && stepResult.success) {
          detail = `waited ${(stepResult.elapsed || 0).toFixed(2)}s`;
        } else if (stepResult.action === 'sleep') {
          detail = `${stepResult.seconds || 0}s`;
        }
        lines.push(`- ${icon} **Step ${stepResult.step}** \`${stepResult.action}\` ${detail}`);
      }
    }

    content.push({ type: 'text', text: lines.join('\n') });
    return { content };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

async function handlePeekPreAnalyze(args) {
  try {
    const { analyzeElementTree } = require('./pre-analyze');
    const fs = require('fs');

    if (!args.capture_path) {
      return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'capture_path is required');
    }

    let bundle;
    try {
      const raw = fs.readFileSync(args.capture_path, 'utf-8');
      bundle = JSON.parse(raw);
    } catch (err) {
      return makeError(ErrorCodes.INVALID_PARAM, `Cannot read capture bundle: ${err.message}`);
    }

    const elementsRaw = bundle.evidence?.elements || bundle.elements || bundle.bundle?.elements || {};
    const elements = Array.isArray(elementsRaw) ? elementsRaw : (elementsRaw.tree || []);
    if (!Array.isArray(elements) || elements.length === 0) {
      return {
        content: [{ type: 'text', text: JSON.stringify({
          findings: [],
          flagged_elements: [],
          stats: { total_elements: 0, interactive: 0, checks_run: 5, findings: 0 }
        }) }]
      };
    }

    const sectionId = args.section_id || 'unknown';
    const result = analyzeElementTree(elements, sectionId);

    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
    };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }
}

module.exports = {
  handlePeekElements,
  handlePeekWait,
  handlePeekOcr,
  handlePeekAssert,
  handlePeekHitTest,
  handlePeekColor,
  handlePeekTable,
  handlePeekSummary,
  handlePeekCdp,
  handlePeekRegression,
  handlePeekDiagnose,
  handlePeekSemanticDiff,
  handlePeekActionSequence,
  handlePeekPreAnalyze,
};
