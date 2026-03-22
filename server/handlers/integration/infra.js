/**
 * Integration infrastructure, workflow config, notifications, and project scan handlers.
 */

const path = require('path');
const fs = require('fs');
const database = require('../../database');
const hostManagement = require('../../db/host-management');
const providerRoutingCore = require('../../db/provider-routing-core');
const serverConfig = require('../../config');
const { CODE_EXTENSIONS, SOURCE_EXTENSIONS, UI_EXTENSIONS } = require('../../constants');
const { PROVIDER_CONTEXT_BUDGETS } = require('../../utils/context-stuffing');
const { COST_FREE_PROVIDERS } = require('../../execution/queue-scheduler');
const { ErrorCodes, makeError } = require('../error-codes');
const logger = require('../../logger').child({ component: 'integration-infra' });

/**
 * Configure an external integration
 */
function handleConfigureIntegration(args) {
  const { integration_type, config, enabled = true } = args;

  // Input validation
  if (!integration_type || !['slack', 'discord', 's3', 'prometheus'].includes(integration_type)) {
    return makeError(ErrorCodes.INVALID_PARAM, 'integration_type must be "slack", "discord", "s3", or "prometheus"');
  }
  if (!config || typeof config !== 'object') {
    return makeError(ErrorCodes.INVALID_PARAM, 'config must be an object');
  }

  // Validate required config fields
  if (integration_type === 'slack' && !config.webhook_url) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Slack integration requires webhook_url in config');
  }
  if (integration_type === 'discord' && !config.webhook_url) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Discord integration requires webhook_url in config');
  }

  // Validate webhook URLs if present
  if (config.webhook_url) {
    try {
      const url = new URL(config.webhook_url);
      if (url.protocol !== 'https:') {
        return makeError(ErrorCodes.INVALID_URL, 'Webhook URL must use HTTPS');
      }
    } catch (e) {
      return makeError(ErrorCodes.INVALID_URL, `Invalid webhook URL: ${e.message}`);
    }
  }

  providerRoutingCore.saveIntegrationConfig({
    id: `${integration_type}_config`,
    integration_type,
    config,
    enabled
  });

  let output = `## Integration Configured\n\n`;
  output += `**Type:** ${integration_type}\n`;
  output += `**Enabled:** ${enabled}\n`;
  output += `**Config Keys:** ${Object.keys(config).join(', ')}\n`;

  return { content: [{ type: 'text', text: output }] };
}



/**
 * Set host priority
 */
function handleSetHostPriority(args) {
  if (!args.host_id || typeof args.host_id !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'host_id must be a non-empty string');
  }
  if (typeof args.priority !== 'number' || args.priority < 1) {
    return makeError(ErrorCodes.INVALID_PARAM, 'priority must be a positive number');
  }

  // Before setting priority, verify host exists
  const hosts = hostManagement.listOllamaHosts();
  const host = hosts.find(h => h.name === args.host_id || h.id === args.host_id);
  if (!host) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Host not found: ${args.host_id}`);
  }

  hostManagement.setHostPriority(args.host_id, args.priority);

  return {
    content: [{ type: 'text', text: `## Host Priority Updated\n\nHost ${args.host_id} priority set to **${args.priority}**.\n\nLower numbers = higher priority.` }]
  };
}


/**
 * Configure review workflow
 */
function handleConfigureReviewWorkflow(args) {
  if (args.review_interval_minutes !== undefined) {
    database.setConfig('review_interval_minutes', String(args.review_interval_minutes));
  }
  if (args.auto_approve_simple !== undefined) {
    database.setConfig('auto_approve_simple', args.auto_approve_simple ? '1' : '0');
  }
  if (args.require_review_for_complex !== undefined) {
    database.setConfig('require_review_for_complex', args.require_review_for_complex ? '1' : '0');
  }

  const config = {
    review_interval_minutes: serverConfig.getInt('review_interval_minutes', 5),
    auto_approve_simple: serverConfig.isOptIn('auto_approve_simple'),
    require_review_for_complex: serverConfig.getBool('require_review_for_complex')
  };

  let output = `## Review Workflow Configuration Updated\n\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Review Interval | ${config.review_interval_minutes} minutes |\n`;
  output += `| Auto-approve Simple | ${config.auto_approve_simple ? 'Yes' : 'No'} |\n`;
  output += `| Require Review for Complex | ${config.require_review_for_complex ? 'Yes' : 'No'} |\n`;

  return {
    content: [{ type: 'text', text: output }]
  };
}


/**
 * Get review workflow configuration
 */
function handleGetReviewWorkflowConfig(_args) {
  const config = {
    review_interval_minutes: serverConfig.getInt('review_interval_minutes', 5),
    auto_approve_simple: serverConfig.isOptIn('auto_approve_simple'),
    require_review_for_complex: serverConfig.getBool('require_review_for_complex')
  };

  // Get host priorities
  const hosts = hostManagement.listOllamaHosts ? hostManagement.listOllamaHosts() : [];

  let output = `## Review Workflow Configuration\n\n`;
  output += `### Review Settings\n`;
  output += `| Setting | Value |\n`;
  output += `|---------|-------|\n`;
  output += `| Review Interval | ${config.review_interval_minutes} minutes |\n`;
  output += `| Auto-approve Simple | ${config.auto_approve_simple ? 'Yes' : 'No'} |\n`;
  output += `| Require Review for Complex | ${config.require_review_for_complex ? 'Yes' : 'No'} |\n\n`;

  output += `### Host Priorities\n`;
  output += `| Host | Priority | Status |\n`;
  output += `|------|----------|--------|\n`;
  for (const host of hosts) {
    output += `| ${host.name || host.id} | ${host.priority || 10} | ${host.enabled ? 'Enabled' : 'Disabled'} |\n`;
  }

  output += `\n### Complexity Routing\n`;
  output += `| Complexity | Destination |\n`;
  output += `|------------|-------------|\n`;
  for (const level of ['simple', 'normal', 'complex']) {
    const routing = hostManagement.routeTask(level);
    if (routing && routing.provider) {
      output += `| ${level} | ${routing.provider}${routing.hostId ? ' (' + routing.hostId + ')' : ''} |\n`;
    } else {
      output += `| ${level} | Not configured |\n`;
    }
  }

  return {
    content: [{ type: 'text', text: output }]
  };
}

function handleBackupDatabase(args) {
  const os = require('os');
  const destPath = args.dest_path || path.join(
    process.env.TORQUE_DATA_DIR || path.join(os.homedir(), '.torque'),
    'backups',
    `torque-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`
  );

  try {
    const result = database.backupDatabase(destPath);
    let output = `## Database Backup Created\n\n`;
    output += `**Path:** ${result.path}\n`;
    output += `**Size:** ${(result.size / 1024).toFixed(1)} KB\n`;
    output += `**Created:** ${result.created_at}\n`;
    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Backup failed: ${err.message}`);
  }
}

async function handleRestoreDatabase(args) {
  try {
  
  if (!args.src_path) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'Source path is required');
  }
  
  if (args.confirm !== true) {
    return makeError(ErrorCodes.INVALID_PARAM, 'Destructive operation requires confirm: true (boolean)');
  }
  try {
    const result = await database.restoreDatabase(args.src_path, args.confirm);
    let output = `## Database Restored\n\n`;
    output += `**From:** ${result.restored_from}\n`;
    output += `**At:** ${result.restored_at}\n`;
    output += `\n> **Warning:** Server restart recommended after restore.\n`;
    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Restore failed: ${err.message}`);
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

function handleListDatabaseBackups(args) {
  try {
    const backups = database.listBackups(args.directory);
    if (backups.length === 0) {
      return { content: [{ type: 'text', text: '## Database Backups\n\nNo backups found.' }] };
    }
    let output = `## Database Backups (${backups.length})\n\n`;
    output += '| Name | Size | Created |\n|------|------|--------|\n';
    for (const b of backups) {
      output += `| ${b.name} | ${(b.size / 1024).toFixed(1)} KB | ${b.created_at} |\n`;
    }
    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `List backups failed: ${err.message}`);
  }
}

// ============================================================
// Email Notification Handlers
// ============================================================

/**
 * Send an email notification.
 * If SMTP is not configured, records as 'pending' and returns advisory.
 */
async function handleSendEmailNotification(args) {
  try {
  
  const { recipient, subject, body, task_id } = args;
  

  if (!recipient || !subject || !body) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'recipient, subject, and body are required');
  }

  // Basic email format validation
  const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!EMAIL_REGEX.test(recipient)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Invalid email address: ${recipient}`);
  }

  const crypto = require('crypto');
  const notificationId = crypto.randomUUID();
  const now = new Date().toISOString();

  // Check SMTP configuration from environment
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || '587';
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM;

  if (!smtpHost || !smtpUser || !smtpPass || !smtpFrom) {
    // SMTP not configured — record as pending
    database.recordEmailNotification({
      id: notificationId,
      task_id: task_id || null,
      recipient,
      subject,
      status: 'pending',
      error: null,
      sent_at: now
    });

    let output = `## Email Notification (Pending)\n\n`;
    output += `- **ID:** ${notificationId}\n`;
    output += `- **To:** ${recipient}\n`;
    output += `- **Subject:** ${subject}\n`;
    output += `- **Status:** pending\n\n`;
    output += `SMTP is not configured. Set SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM environment variables to enable email sending.\n`;
    output += `The notification has been recorded and can be sent later when SMTP is configured.\n`;

    return { content: [{ type: 'text', text: output }] };
  }

  // Try to send via nodemailer (optional dependency)
  let nodemailer;
  try {
    nodemailer = require('nodemailer');
  } catch {
    // nodemailer not installed — record as pending
    database.recordEmailNotification({
      id: notificationId,
      task_id: task_id || null,
      recipient,
      subject,
      status: 'pending',
      error: 'nodemailer not installed',
      sent_at: now
    });

    let output = `## Email Notification (Pending)\n\n`;
    output += `- **ID:** ${notificationId}\n`;
    output += `- **To:** ${recipient}\n`;
    output += `- **Subject:** ${subject}\n`;
    output += `- **Status:** pending\n\n`;
    output += `nodemailer is not installed. Install it with \`npm install nodemailer\` to enable email sending.\n`;
    output += `The notification has been recorded and can be sent later.\n`;

    return { content: [{ type: 'text', text: output }] };
  }

  // Send the email
  try {
    const transporter = nodemailer.createTransport({
      host: smtpHost,
      port: parseInt(smtpPort, 10),
      secure: parseInt(smtpPort, 10) === 465,
      auth: {
        user: smtpUser,
        pass: smtpPass
      }
    });

    await transporter.sendMail({
      from: smtpFrom,
      to: recipient,
      subject: subject,
      text: body
    });

    database.recordEmailNotification({
      id: notificationId,
      task_id: task_id || null,
      recipient,
      subject,
      status: 'sent',
      error: null,
      sent_at: now
    });

    let output = `## Email Notification Sent\n\n`;
    output += `- **ID:** ${notificationId}\n`;
    output += `- **To:** ${recipient}\n`;
    output += `- **Subject:** ${subject}\n`;
    output += `- **Status:** sent\n`;

    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    database.recordEmailNotification({
      id: notificationId,
      task_id: task_id || null,
      recipient,
      subject,
      status: 'failed',
      error: err.message,
      sent_at: now
    });

    let output = `## Email Notification Failed\n\n`;
    output += `- **ID:** ${notificationId}\n`;
    output += `- **To:** ${recipient}\n`;
    output += `- **Subject:** ${subject}\n`;
    output += `- **Status:** failed\n`;
    output += `- **Error:** ${err.message}\n`;

    return { content: [{ type: 'text', text: output }] };
  }
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

/**
 * List email notifications with optional filters
 */
function handleListEmailNotifications(args) {
  const options = {
    status: args.status,
    task_id: args.task_id,
    limit: args.limit || 100
  };

  const notifications = database.listEmailNotifications(options);

  let output = `## Email Notifications\n\n`;

  if (notifications.length === 0) {
    output += `No email notifications found.\n`;
    return { content: [{ type: 'text', text: output }] };
  }

  output += `**Count:** ${notifications.length}\n\n`;
  output += `| ID | Recipient | Subject | Status | Sent At |\n`;
  output += `|----|-----------|---------|--------|--------|\n`;

  for (const n of notifications) {
    const nId = (n.id || '').substring(0, 8);
    const subject = n.subject || '(no subject)';
    const shortSubject = subject.length > 30 ? subject.substring(0, 30) + '...' : subject;
    output += `| ${nId} | ${n.recipient} | ${shortSubject} | ${n.status} | ${n.sent_at} |\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Get a single email notification by ID
 */
function handleGetEmailNotification(args) {
  const { id } = args;

  if (!id) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'id is required');
  }

  const notification = database.getEmailNotification(id);

  if (!notification) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Email notification not found: ${id}`);
  }

  let output = `## Email Notification\n\n`;
  output += `- **ID:** ${notification.id}\n`;
  output += `- **Recipient:** ${notification.recipient}\n`;
  output += `- **Subject:** ${notification.subject}\n`;
  output += `- **Status:** ${notification.status}\n`;
  output += `- **Sent At:** ${notification.sent_at}\n`;
  if (notification.task_id) {
    output += `- **Task ID:** ${notification.task_id}\n`;
  }
  if (notification.error) {
    output += `- **Error:** ${notification.error}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
}


function detectProjectType(workingDir) {
  const checks = [
    { file: 'Cargo.toml', type: 'rust', src: ['src'], test: '.rs', testDir: 'tests' },
    { file: 'go.mod', type: 'go', src: ['.'], test: '_test.go', testDir: '' },
    { file: 'pom.xml', type: 'java', src: ['src/main/java'], test: 'Test.java', testDir: 'src/test' },
    { file: 'requirements.txt', type: 'python', src: ['src', '.'], test: 'test_', testDir: 'tests' },
    { file: 'setup.py', type: 'python', src: ['src', '.'], test: 'test_', testDir: 'tests' },
    { file: 'pyproject.toml', type: 'python', src: ['src', '.'], test: 'test_', testDir: 'tests' },
    { file: 'package.json', type: 'node', src: ['src'], test: '.test.', testDir: 'tests' },
  ];
  for (const check of checks) {
    if (fs.existsSync(path.join(workingDir, check.file))) {
      return check;
    }
  }
  return { type: 'unknown', src: ['src', '.'], test: '.test.', testDir: 'tests' };
}

function handleScanProject(args) {
  const projectPath = args.path;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Project path does not exist: ${projectPath}`);
  }

  const detected = detectProjectType(projectPath);
  const checks = args.checks || ['summary', 'missing_tests', 'todos', 'file_sizes', 'data_inventory', 'dependencies'];
  const sourceDirs = args.source_dirs || detected.src;
  const testSuffix = args.test_pattern || detected.test;
  const ignoreDirs = new Set(args.ignore_dirs || ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv']);

  // Recursive file walker
  function walkDir(dir, fileList = []) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (ignoreDirs.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(fullPath, fileList);
        } else if (entry.isFile()) {
          const stat = fs.statSync(fullPath);
          fileList.push({
            path: fullPath,
            relativePath: path.relative(projectPath, fullPath),
            name: entry.name,
            ext: path.extname(entry.name).toLowerCase(),
            size: stat.size,
            lines: null // lazy-loaded
          });
        }
      }
    } catch (err) {
      logger.debug('[integration-infra] non-critical error walking directory tree:', err.message || err);
    }
    return fileList;
  }

  // Count lines in a file
  function countLines(filePath) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return content.split('\n').length;
    } catch { return 0; }
  }

  const allFiles = walkDir(projectPath);
  const report = {};

  // --- SUMMARY ---
  if (checks.includes('summary')) {
    const byDir = {};
    const byExt = {};
    for (const f of allFiles) {
      const topDir = f.relativePath.split(path.sep)[0] || '.';
      byDir[topDir] = (byDir[topDir] || 0) + 1;
      byExt[f.ext || '(no ext)'] = (byExt[f.ext || '(no ext)'] || 0) + 1;
    }
    const sortedDirs = Object.entries(byDir).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    const sortedExts = Object.entries(byExt).sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    });
    report.summary = {
      totalFiles: allFiles.length,
      byDirectory: Object.fromEntries(sortedDirs.slice(0, 30)),
      byExtension: Object.fromEntries(sortedExts.slice(0, 20))
    };
  }

  // --- MISSING TESTS ---
  if (checks.includes('missing_tests')) {
    const sourceFiles = [];
    const testFiles = new Set();

    for (const f of allFiles) {
      if (f.name.endsWith(testSuffix)) {
        const baseName = f.name.replace(testSuffix, '');
        testFiles.add(baseName);
        continue;
      }
      const relParts = f.relativePath.split(path.sep);
      const inSourceDir = sourceDirs.some(sd => relParts[0] === sd);
      const inTestDir = relParts.some(p => p === '__tests__' || p === 'tests' || p === 'test' || p === '__test__');
      const isSourceExt = SOURCE_EXTENSIONS.has(f.ext);

      if (inSourceDir && !inTestDir && isSourceExt) {
        if (f.name === 'index.ts' || f.name === 'index.js' || f.name.startsWith('index.')) continue;
        if (f.name.endsWith('.d.ts')) continue;
        sourceFiles.push(f);
      }
    }

    const missing = [];
    const covered = [];
    for (const f of sourceFiles) {
      const baseName = path.basename(f.name, f.ext);
      if (testFiles.has(baseName)) {
        covered.push(f.relativePath);
      } else {
        const lines = countLines(f.path);
        missing.push({ file: f.relativePath, lines });
      }
    }

    report.missingTests = {
      covered: covered.length,
      missing: missing.length,
      total: sourceFiles.length,
      coveragePercent: sourceFiles.length > 0 ? Math.round((covered.length / sourceFiles.length) * 100) : 100,
      missingFiles: missing.sort((a, b) => {
        if (b.lines !== a.lines) return b.lines - a.lines;
        return a.file.localeCompare(b.file);
      })
    };
  }

  // --- TODOS ---
  if (checks.includes('todos')) {
    const todoPattern = /\b(TODO|FIXME|HACK|XXX|TEMP)\b/i;
    const todos = [];
    const codeExts = new Set([...CODE_EXTENSIONS, ...UI_EXTENSIONS]);

    for (const f of allFiles) {
      if (!codeExts.has(f.ext)) continue;
      if (f.size > 500000) continue;
      try {
        const content = fs.readFileSync(f.path, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const match = todoPattern.exec(lines[i]);
          if (match) {
            todos.push({
              file: f.relativePath,
              line: i + 1,
              type: match[1].toUpperCase(),
              text: lines[i].trim().substring(0, 120)
            });
          }
        }
      } catch (err) {
        logger.debug('[integration-infra] non-critical error parsing TODO marker:', err.message || err);
      }
    }
    report.todos = {
      count: todos.length,
      items: todos
        .sort((a, b) => {
          if (a.file !== b.file) return a.file.localeCompare(b.file);
          if (a.line !== b.line) return a.line - b.line;
          return a.type.localeCompare(b.type);
        })
        .slice(0, 50)
    };
  }

  // --- FILE SIZES ---
  if (checks.includes('file_sizes')) {
    const codeExts = new Set([...CODE_EXTENSIONS, ...UI_EXTENSIONS]);
    const codeFiles = allFiles.filter(f => codeExts.has(f.ext));

    const withLines = codeFiles.map(f => ({
      file: f.relativePath,
      bytes: f.size,
      lines: countLines(f.path)
    }));

    withLines.sort((a, b) => {
      if (b.lines !== a.lines) return b.lines - a.lines;
      return a.file.localeCompare(b.file);
    });

    report.fileSizes = {
      totalCodeFiles: codeFiles.length,
      totalBytes: codeFiles.reduce((sum, f) => sum + f.size, 0),
      totalLines: withLines.reduce((sum, f) => sum + f.lines, 0),
      largest: withLines.slice(0, 15),
      smallest: withLines.filter(f => f.lines > 0).sort((a, b) => {
        if (a.lines !== b.lines) return a.lines - b.lines;
        return a.file.localeCompare(b.file);
      }).slice(0, 5)
    };
  }

  // --- DATA INVENTORY ---
  if (checks.includes('data_inventory')) {
    const dataFiles = allFiles.filter(f => {
      const relParts = f.relativePath.split(path.sep);
      return relParts.some(p => p === 'data' || p === 'config' || p === 'constants');
    });

    const inventory = [];
    for (const f of dataFiles) {
      const lines = countLines(f.path);
      let entryCount = null;
      try {
        const content = fs.readFileSync(f.path, 'utf-8');
        const openBraces = (content.match(/^\s*\{$/gm) || []).length;
        const idFields = (content.match(/^\s*id:/gm) || []).length;
        entryCount = Math.max(openBraces, idFields) || null;
      } catch (err) {
        logger.debug('[integration-infra] non-critical error estimating package entries:', err.message || err);
      }

      inventory.push({
        file: f.relativePath,
        lines,
        estimatedEntries: entryCount
      });
    }
    inventory.sort((a, b) => a.file.localeCompare(b.file));
    report.dataInventory = { count: dataFiles.length, files: inventory };
  }

  // --- DEPENDENCIES ---
  if (checks.includes('dependencies')) {
    const pkgPath = path.join(projectPath, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        report.dependencies = {
          name: pkg.name,
          version: pkg.version,
          scripts: pkg.scripts || {},
          dependencies: Object.keys(pkg.dependencies || {}).sort(),
          devDependencies: Object.keys(pkg.devDependencies || {}).sort()
        };
      } catch { report.dependencies = { error: 'Failed to parse package.json' }; }
    } else {
      const pyproject = path.join(projectPath, 'pyproject.toml');
      const csproj = allFiles.find(f => f.ext === '.csproj');
      const goMod = path.join(projectPath, 'go.mod');

      if (fs.existsSync(pyproject)) report.dependencies = { type: 'python', file: 'pyproject.toml' };
      else if (csproj) report.dependencies = { type: 'dotnet', file: csproj.relativePath };
      else if (fs.existsSync(goMod)) report.dependencies = { type: 'go', file: 'go.mod' };
      else report.dependencies = { type: 'unknown', message: 'No recognized project file found' };
    }
  }

  // Format the report as readable text
  let output = `## Project Scan: ${path.basename(projectPath)}\n\n`;

  if (report.summary) {
    output += `### Summary\n`;
    output += `**Total files:** ${report.summary.totalFiles}\n\n`;
    output += `| Directory | Files |\n|-----------|-------|\n`;
    for (const [dir, count] of Object.entries(report.summary.byDirectory)) {
      output += `| ${dir} | ${count} |\n`;
    }
    output += `\n| Extension | Files |\n|-----------|-------|\n`;
    for (const [ext, count] of Object.entries(report.summary.byExtension)) {
      output += `| ${ext} | ${count} |\n`;
    }
    output += '\n';
  }

  if (report.missingTests) {
    const mt = report.missingTests;
    output += `### Test Coverage\n`;
    output += `**${mt.covered}/${mt.total} source files have tests (${mt.coveragePercent}%)**\n\n`;
    if (mt.missingFiles.length > 0) {
      output += `**Missing tests (${mt.missing} files):**\n`;
      for (const f of mt.missingFiles) {
        output += `- ${f.file} (${f.lines} lines)\n`;
      }
      output += '\n';
    }
  }

  if (report.todos) {
    output += `### TODOs/FIXMEs\n`;
    output += `**${report.todos.count} found**\n\n`;
    for (const t of report.todos.items) {
      output += `- **${t.type}** ${t.file}:${t.line} — ${t.text}\n`;
    }
    output += '\n';
  }

  if (report.fileSizes) {
    const fs_ = report.fileSizes;
    output += `### File Sizes\n`;
    output += `**${fs_.totalCodeFiles} code files, ${fs_.totalLines.toLocaleString()} total lines**\n\n`;
    output += `| File | Lines |\n|------|-------|\n`;
    for (const f of fs_.largest) {
      output += `| ${f.file} | ${f.lines.toLocaleString()} |\n`;
    }
    output += '\n';
  }

  if (report.dataInventory) {
    output += `### Data Inventory\n`;
    output += `| File | Lines | Est. Entries |\n|------|-------|--------------|\n`;
    for (const f of report.dataInventory.files) {
      output += `| ${f.file} | ${f.lines} | ${f.estimatedEntries ?? '—'} |\n`;
    }
    output += '\n';
  }

  if (report.dependencies) {
    output += `### Dependencies\n`;
    if (report.dependencies.name) {
      output += `**${report.dependencies.name}** v${report.dependencies.version || '?'}\n\n`;
      if (report.dependencies.scripts) {
        output += `**Scripts:** ${Object.keys(report.dependencies.scripts).join(', ')}\n`;
      }
      output += `**Dependencies (${report.dependencies.dependencies.length}):** ${report.dependencies.dependencies.join(', ')}\n`;
      output += `**Dev dependencies (${report.dependencies.devDependencies.length}):** ${report.dependencies.devDependencies.join(', ')}\n`;
    }
    output += '\n';
  }

  return { content: [{ type: 'text', text: output }] };
}

/**
 * Full project audit — automatically distributes code review tasks across all
 * enabled free and local providers. Each provider gets file groups sized to fit
 * its context budget. Returns task IDs for monitoring.
 */
function handleFullProjectAudit(args) {
  const projectPath = args.path || args.working_directory;
  if (!projectPath || !fs.existsSync(projectPath)) {
    return makeError(ErrorCodes.RESOURCE_NOT_FOUND, `Project path does not exist: ${projectPath}`);
  }

  const sourceDirs = args.source_dirs || ['server'];
  const maxTasksPerProvider = args.max_tasks_per_provider || 5;
  const ignoreDirs = new Set(args.ignore_dirs || ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '__pycache__', '.venv', 'tests', 'docs']);
  const minFileLines = args.min_file_lines || 50;

  // 1. Walk project and collect source files with line counts
  const codeExts = new Set(['.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs']);
  const files = [];
  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (ignoreDirs.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (!codeExts.has(ext)) continue;
        if (entry.name.endsWith('.test.js') || entry.name.endsWith('.test.ts')) continue;
        try {
          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n').length;
          if (lines >= minFileLines) {
            files.push({ path: full, rel: path.relative(projectPath, full).replace(/\\/g, '/'), lines, tokens: Math.ceil(content.length / 4) });
          }
        } catch { /* skip unreadable */ }
      }
    } catch { /* skip inaccessible dirs */ }
  }
  for (const sd of sourceDirs) {
    walk(path.join(projectPath, sd));
  }
  files.sort((a, b) => b.lines - a.lines);

  if (files.length === 0) {
    return { content: [{ type: 'text', text: 'No source files found to audit.' }] };
  }

  // 2. Get enabled providers
  const enabledProviders = [];
  for (const name of COST_FREE_PROVIDERS) {
    try {
      const config = providerRoutingCore.getProvider(name);
      if (config && config.enabled) {
        const isLocal = ['ollama', 'hashline-ollama', 'aider-ollama'].includes(name);
        const budget = isLocal ? Infinity : (PROVIDER_CONTEXT_BUDGETS[name] || 96000);
        enabledProviders.push({ name, budget, isLocal, tasks: [] });
      }
    } catch { /* skip unavailable */ }
  }

  if (enabledProviders.length === 0) {
    return makeError(ErrorCodes.PROVIDER_NOT_AVAILABLE, 'No free/local providers are enabled');
  }

  // Skip cerebras — 6K budget is too small for meaningful file review
  const usableProviders = enabledProviders.filter(p => p.budget > 10000 || p.isLocal);

  // 3. Group files into audit batches sized per provider budget
  const auditPrompt = 'You are auditing a Node.js project for bugs, logic errors, race conditions, security issues, and dead code. Review the following file(s). Report ONLY confirmed bugs with file:line references and severity (CRITICAL/HIGH/MEDIUM). Do NOT report style issues, missing docs, or suggestions.';

  const assignedFiles = new Set();

  // Round-robin distribute files to providers
  let providerIdx = 0;
  for (const file of files) {
    if (assignedFiles.has(file.rel)) continue;

    // Find a provider that can fit this file and hasn't hit max tasks
    let assigned = false;
    for (let i = 0; i < usableProviders.length; i++) {
      const pidx = (providerIdx + i) % usableProviders.length;
      const provider = usableProviders[pidx];
      if (provider.tasks.length >= maxTasksPerProvider) continue;

      // For local providers, assign 1-2 files per task (they read from filesystem)
      if (provider.isLocal) {
        const taskFiles = [file];
        assignedFiles.add(file.rel);
        // Try to add another small file to this task
        for (const f2 of files) {
          if (assignedFiles.has(f2.rel)) continue;
          if (f2.lines <= 500) {
            taskFiles.push(f2);
            assignedFiles.add(f2.rel);
            break;
          }
        }
        provider.tasks.push({
          task: `${auditPrompt}\n\nFiles to review:\n${taskFiles.map(f => `- ${f.rel} (${f.lines} lines)`).join('\n')}`,
          context_stuff: false,
          totalTokens: 0,
        });
        assigned = true;
        providerIdx = (pidx + 1) % usableProviders.length;
        break;
      }

      // For API providers, check token budget and embed file contents
      if (file.tokens <= provider.budget * 0.8) {
        // Try to batch small files together
        const taskFiles = [file];
        let totalTokens = file.tokens;
        assignedFiles.add(file.rel);

        for (const f2 of files) {
          if (assignedFiles.has(f2.rel)) continue;
          if (totalTokens + f2.tokens > provider.budget * 0.7) break;
          taskFiles.push(f2);
          totalTokens += f2.tokens;
          assignedFiles.add(f2.rel);
          if (taskFiles.length >= 3) break;
        }
        // API providers can't read from filesystem — embed file contents inline
        const fileBlocks = taskFiles.map(f => {
          try {
            const content = fs.readFileSync(f.path, 'utf8');
            return `### ${f.rel} (${f.lines} lines)\n\`\`\`js\n${content}\n\`\`\``;
          } catch {
            return `### ${f.rel} (${f.lines} lines)\n[Could not read file]`;
          }
        });
        provider.tasks.push({
          task: `${auditPrompt}\n\n${fileBlocks.join('\n\n')}`,
          context_stuff: false,
          totalTokens,
        });
        assigned = true;
        providerIdx = (pidx + 1) % usableProviders.length;
        break;
      }
    }

    if (!assigned) assignedFiles.add(file.rel); // Skip files too large for any provider
  }

  // 4. Submit tasks via handleSubmitTask with eligible_providers for slot-pull late binding
  //    Each task knows which providers can handle it (based on budget analysis).
  //    The slot-pull scheduler picks the best available provider, respecting max_concurrent.
  const { handleSubmitTask } = require('../task/core');
  const submittedTasks = [];
  for (const provider of usableProviders) {
    for (const taskDef of provider.tasks) {
      try {
        // Build eligible provider list: primary provider + any others with sufficient budget
        const eligible = [provider.name];
        for (const other of usableProviders) {
          if (other.name !== provider.name && !eligible.includes(other.name)) {
            // Only include providers whose budget can handle this task's file tokens
            if (other.isLocal || taskDef.totalTokens <= other.budget * 0.8) {
              eligible.push(other.name);
            }
          }
        }
        const result = handleSubmitTask({
          task: taskDef.task,
          working_directory: projectPath,
          eligible_providers: eligible,
          timeout_minutes: 5,
          auto_route: false,
          context_stuff: taskDef.context_stuff,
        });
        const text = result?.content?.[0]?.text || result?.result || '';
        const idMatch = text.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        const taskId = idMatch ? idMatch[1].slice(0, 8) : '?';
        submittedTasks.push({ id: taskId, eligible: eligible.join(', ') });
      } catch (err) {
        logger.info(`[full-project-audit] Failed to submit task for ${provider.name}: ${err.message}`);
      }
    }
  }

  // 5. Return summary
  const coveredFiles = assignedFiles.size;
  const totalFiles = files.length;
  const providerSummary = usableProviders
    .filter(p => p.tasks.length > 0)
    .map(p => `${p.name}: ${p.tasks.length} tasks`)
    .join(', ');

  let output = `## Full Project Audit\n\n`;
  output += `**Project:** ${projectPath}\n`;
  output += `**Source files scanned:** ${totalFiles} (≥${minFileLines} lines)\n`;
  output += `**Files covered:** ${coveredFiles}/${totalFiles}\n`;
  output += `**Tasks submitted:** ${submittedTasks.length}\n`;
  output += `**Providers:** ${providerSummary}\n\n`;
  output += `### Tasks\n\n`;
  output += `| ID | Eligible Providers |\n|-----|----------|\n`;
  for (const t of submittedTasks) {
    output += `| ${t.id} | ${t.eligible} |\n`;
  }
  output += `\nUse \`check_notifications\` or \`list_tasks\` to monitor progress.\n`;

  return { content: [{ type: 'text', text: output }] };
}

function createIntegrationInfraHandlers(deps) {
  return {
    handleConfigureIntegration,
    handleSetHostPriority,
    handleConfigureReviewWorkflow,
    handleGetReviewWorkflowConfig,
    handleBackupDatabase,
    handleRestoreDatabase,
    handleListDatabaseBackups,
    handleSendEmailNotification,
    handleListEmailNotifications,
    handleGetEmailNotification,
    handleScanProject,
    handleFullProjectAudit,
  };
}

module.exports = {
  handleConfigureIntegration,
  handleSetHostPriority,
  handleConfigureReviewWorkflow,
  handleGetReviewWorkflowConfig,
  handleBackupDatabase,
  handleRestoreDatabase,
  handleListDatabaseBackups,
  handleSendEmailNotification,
  handleListEmailNotifications,
  handleGetEmailNotification,
  handleScanProject,
  handleFullProjectAudit,
  createIntegrationInfraHandlers,
};
