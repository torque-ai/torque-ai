const useColor = !process.env.NO_COLOR
  && process.argv.indexOf('--no-color') === -1
  && (process.stdout.isTTY || process.env.FORCE_COLOR === '1');

const ANSI = useColor
  ? {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[90m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    cyan: '\x1b[36m',
  }
  : {
    reset: '',
    bold: '',
    dim: '',
    red: '',
    green: '',
    yellow: '',
    cyan: '',
  };

function cleanValue(value) {
  return String(value ?? '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function extractTextPayload(raw) {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw.result === 'string') return raw.result;
  if (raw?.content?.[0]?.text) return raw.content[0].text;
  return '';
}

function colorizeStatus(status, text = status) {
  const normalized = String(status || '').toLowerCase();
  const padded = String(text);

  if (['completed', 'healthy', 'ready', 'ok'].includes(normalized)) {
    return `${ANSI.green}${padded}${ANSI.reset}`;
  }
  if (['failed', 'error', 'unhealthy'].includes(normalized)) {
    return `${ANSI.red}${padded}${ANSI.reset}`;
  }
  if (['running', 'queued', 'degraded', 'timeout'].includes(normalized)) {
    return `${ANSI.yellow}${padded}${ANSI.reset}`;
  }
  if (['pending', 'blocked', 'cancelled', 'canceled', 'skipped', 'unknown'].includes(normalized)) {
    return `${ANSI.dim}${padded}${ANSI.reset}`;
  }

  return padded;
}

function padRight(value, width) {
  const text = String(value ?? '');
  return text + ' '.repeat(Math.max(0, width - text.length));
}

function renderTable(rows, columns) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return '';
  }

  const widths = columns.map((column) => {
    const cellWidths = rows.map((row) => String(column.value(row)).length);
    return Math.max(column.label.length, column.minWidth || 0, ...cellWidths);
  });

  const header = columns.map((column, index) => padRight(column.label, widths[index])).join('  ');
  const separator = columns.map((_, index) => '-'.repeat(widths[index])).join('  ');
  const body = rows.map((row) => columns.map((column, index) => {
    const rawValue = String(column.value(row));
    const padded = padRight(rawValue, widths[index]);
    return typeof column.render === 'function' ? column.render(rawValue, padded, row) : padded;
  }).join('  ')).join('\n');

  return `${header}\n${separator}\n${body}`;
}

function parseMarkdownTable(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'));

  if (lines.length < 3) {
    return null;
  }

  const parseCells = (line) => line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cleanValue(cell));

  const headers = parseCells(lines[0]);
  const rows = lines
    .slice(2)
    .filter((line) => /\|/.test(line))
    .map((line) => {
      const cells = parseCells(line);
      return headers.reduce((acc, header, index) => {
        acc[header] = cells[index] || '';
        return acc;
      }, {});
    });

  return { headers, rows };
}

function parseFieldMap(text) {
  const fields = {};
  const pattern = /^\*\*(.+?):\*\*\s*(.+)$/gm;
  let match;

  while ((match = pattern.exec(String(text || '')))) {
    fields[cleanValue(match[1])] = cleanValue(match[2]);
  }

  return fields;
}

function parseCodeSection(text, heading) {
  const pattern = new RegExp(`###\\s+${heading}\\s*\\r?\\n\`\`\`\\r?\\n([\\s\\S]*?)\\r?\\n\`\`\``, 'i');
  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : '';
}

function renderFallbackText(text) {
  return String(text || '')
    .replace(/^##\s+/gm, '')
    .replace(/^###\s+/gm, '')
    .replace(/\*\*(.*?)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
}

function formatHealthSummary(health, includeHeading = true) {
  const lines = [];

  if (includeHeading) {
    lines.push(`${ANSI.bold}Server Health${ANSI.reset}`);
  }

  lines.push(`Status: ${colorizeStatus(health.status)}`);
  lines.push(`Database: ${health.database}`);
  lines.push(`Ollama: ${colorizeStatus(health.ollama)}`);
  lines.push(`Queue Depth: ${health.queue_depth ?? 'n/a'}`);
  lines.push(`Running Tasks: ${health.running_tasks ?? 'n/a'}`);
  lines.push(`Uptime: ${health.uptime_seconds ?? 'n/a'}s`);

  if (health.database_reason) {
    lines.push(`Database Reason: ${health.database_reason}`);
  }

  return lines.join('\n');
}

function formatTaskList(raw) {
  const text = extractTextPayload(raw);
  const parsed = parseMarkdownTable(text);

  if (!parsed || parsed.rows.length === 0) {
    return renderFallbackText(text);
  }

  return renderTable(parsed.rows, [
    { label: 'ID', value: (row) => row.ID || '' },
    {
      label: 'STATUS',
      value: (row) => row.Status || '',
      render: (value, padded) => colorizeStatus(value, padded),
    },
    { label: 'MODEL', value: (row) => row.Model || '-' },
    { label: 'HOST', value: (row) => row.Host || '-' },
    { label: 'CREATED', value: (row) => row.Created || '-' },
    { label: 'DESCRIPTION', value: (row) => row.Description || '' },
  ]);
}

function formatTaskResult(raw) {
  const text = extractTextPayload(raw);
  const fields = parseFieldMap(text);
  const taskIdMatch = text.match(/^##\s+Task Result:\s+(.+)$/m);
  const output = parseCodeSection(text, 'Output');
  const errors = parseCodeSection(text, 'Errors');

  if (!taskIdMatch) {
    return renderFallbackText(text);
  }

  const lines = [
    `${ANSI.bold}Task ${cleanValue(taskIdMatch[1])}${ANSI.reset}`,
  ];

  if (fields.Status) lines.push(`Status: ${colorizeStatus(fields.Status)}`);
  if (fields.Provider) lines.push(`Provider: ${fields.Provider}`);
  if (fields.Model) lines.push(`Model: ${fields.Model}`);
  if (fields['Requested Model']) lines.push(`Requested Model: ${fields['Requested Model']}`);
  if (fields['Exit Code']) lines.push(`Exit Code: ${fields['Exit Code']}`);
  if (fields.Duration) lines.push(`Duration: ${fields.Duration}`);
  if (fields.Host) lines.push(`Host: ${fields.Host}`);
  if (fields['Files Modified']) lines.push(`Files Modified: ${fields['Files Modified']}`);

  if (output) {
    lines.push('');
    lines.push(`${ANSI.bold}Output Preview${ANSI.reset}`);
    lines.push(output.length > 1200 ? `${output.slice(0, 1200)}...` : output);
  }

  if (errors) {
    lines.push('');
    lines.push(`${ANSI.bold}Errors${ANSI.reset}`);
    lines.push(errors.length > 1200 ? `${errors.slice(0, 1200)}...` : errors);
  }

  return lines.join('\n');
}

function formatSubmission(raw) {
  const text = extractTextPayload(raw);
  const table = parseMarkdownTable(text);

  if (!table || table.rows.length === 0) {
    return renderFallbackText(text);
  }

  const fields = {};
  for (const row of table.rows) {
    fields[row.Field] = row.Value;
  }

  const lines = [`${ANSI.bold}Task Submitted${ANSI.reset}`];
  if (fields['Task ID']) lines.push(`ID: ${fields['Task ID']}`);
  if (fields.Status) lines.push(`Status: ${colorizeStatus(fields.Status)}`);
  if (fields.Provider) lines.push(`Provider: ${fields.Provider}`);
  if (fields.Model) lines.push(`Model: ${fields.Model}`);
  if (fields.Complexity) lines.push(`Complexity: ${fields.Complexity}`);
  if (fields['Routing Rule']) lines.push(`Routing Rule: ${fields['Routing Rule']}`);

  const routingSection = text.match(/### Routing Decision\s*([\s\S]+)$/);
  if (routingSection?.[1]) {
    lines.push('');
    lines.push(renderFallbackText(routingSection[1]));
  }

  return lines.join('\n').trim();
}

function formatStatus(raw) {
  const parts = [formatHealthSummary(raw.health)];
  const taskText = formatTaskList(raw.runningTasks);

  if (taskText) {
    parts.push('');
    parts.push(`${ANSI.bold}Running Tasks${ANSI.reset}`);
    parts.push(taskText);
  }

  return parts.join('\n');
}

function formatDryRun(raw) {
  const text = extractTextPayload(raw);
  const fields = parseFieldMap(text);

  const lines = [`${ANSI.bold}Dry Run — Routing Preview${ANSI.reset}`];
  if (fields.Provider) lines.push(`  Provider:   ${fields.Provider}`);
  if (fields.Model) lines.push(`  Model:      ${fields.Model}`);
  if (fields.Complexity) lines.push(`  Complexity: ${fields.Complexity}`);
  if (fields.Cost) lines.push(`  Est. Cost:  ${fields.Cost}`);
  if (fields['Routing Rule']) lines.push(`  Rule:       ${fields['Routing Rule']}`);
  if (fields.Host) lines.push(`  Host:       ${fields.Host}`);
  if (fields.Tier) lines.push(`  Tier:       ${fields.Tier}`);

  // If no structured fields found, fall back to raw text
  if (lines.length === 1) {
    lines.push(renderFallbackText(text));
  }

  lines.push('');
  lines.push(`${ANSI.dim}No task was submitted. Remove --dry-run to submit.${ANSI.reset}`);
  return lines.join('\n');
}

function formatWorkflow(raw) {
  return renderFallbackText(extractTextPayload(raw));
}

function formatHealth(raw) {
  return formatHealthSummary(raw);
}

function formatCommandResult(result, options = {}) {
  if (options.json) {
    return JSON.stringify(result.raw, null, 2);
  }

  switch (result.command) {
    case 'status':
      return formatStatus(result.raw);
    case 'submit':
      return formatSubmission(result.raw);
    case 'dry_run':
      return formatDryRun(result.raw);
    case 'list':
      return formatTaskList(result.raw);
    case 'result':
      return formatTaskResult(result.raw);
    case 'cancel':
      return renderFallbackText(extractTextPayload(result.raw));
    case 'workflow_create':
    case 'workflow_run':
    case 'workflow_status':
    case 'decompose':
    case 'diagnose':
    case 'review':
    case 'benchmark':
      return formatWorkflow(result.raw);
    case 'health':
      return formatHealth(result.raw);
    default:
      return renderFallbackText(extractTextPayload(result.raw));
  }
}

module.exports = {
  ANSI,
  colorizeStatus,
  extractTextPayload,
  formatCommandResult,
  formatDryRun,
  formatTaskList,
  formatTaskResult,
  formatSubmission,
  parseFieldMap,
  parseMarkdownTable,
  renderTable,
};
