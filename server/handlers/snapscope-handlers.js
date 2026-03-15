/**
 * SnapScope handlers — screenshot capture via SnapScope CLI
 *
 * Handlers: handleCaptureScreenshots, handleCaptureView, handleCaptureViews, handleValidateManifest
 *
 * Requires: .NET 8 SDK + SnapScope project at SNAPSCOPE_CLI_PROJECT path.
 * Pre-builds the exe on first use; subsequent calls invoke the binary directly.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { exec, execFile } = require('child_process');
const { TASK_TIMEOUTS } = require('../constants');
const { ErrorCodes, makeError } = require('./shared');
const logger = require('../logger').child({ component: 'snapscope-handlers' });

const SNAPSCOPE_CLI_PROJECT = process.env.SNAPSCOPE_CLI_PROJECT || '';
const SNAPSCOPE_EXE = path.join(SNAPSCOPE_CLI_PROJECT,
  'bin/Debug/net8.0-windows10.0.22621.0/SnapScope.Cli.exe');

// ─── Pre-build logic ─────────────────────────────────────────────────────────

let _buildPromise = null;

function ensureBuilt() {
  if (!_buildPromise) {
    _buildPromise = new Promise((resolve, reject) => {
      exec(`dotnet build "${SNAPSCOPE_CLI_PROJECT}" -c Debug --nologo -v q`,
        { timeout: 60000 }, (err) => {
          if (err) { _buildPromise = null; reject(err); }
          else resolve(SNAPSCOPE_EXE);
        });
    });
  }
  return _buildPromise;
}

// Kick off build eagerly on module load
ensureBuilt().catch((err) => {
  logger.debug('[snapscope-handlers] prebuild failed:', err.message || err);
});

// ─── CLI execution helper ────────────────────────────────────────────────────

function runSnapScopeCli(exePath, cliArgs, timeoutMs) {
  // SECURITY: Use execFile instead of exec to avoid shell injection.
  // execFile passes args directly to the process without shell interpretation.
  return new Promise((resolve) => {
    execFile(exePath, cliArgs, {
      timeout: timeoutMs,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true
    }, (err, stdout, stderr) => {
      resolve({
        stdout: stdout || '',
        stderr: stderr || (err ? err.message : ''),
        exitCode: err ? (typeof err.code === 'number' ? err.code : (err.status || 1)) : 0
      });
    });
  });
}

// ─── capture_screenshots ─────────────────────────────────────────────────────

async function handleCaptureScreenshots(args) {
  try {
  
  const manifestPath = args.manifest_path;
  if (!manifestPath || typeof manifestPath !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'manifest_path is required');
  }
  

  if (!fs.existsSync(manifestPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Manifest file not found: ${manifestPath}`);
  }

  if (args.timeout_seconds !== undefined) {
    const val = Number(args.timeout_seconds);
    if (!Number.isFinite(val) || val < 1 || val > 600) {
      return makeError(ErrorCodes.INVALID_PARAM, 'timeout_seconds must be between 1 and 600');
    }
  }

  const exePath = await ensureBuilt();

  // Build CLI args
  const cliArgs = ['--manifest', manifestPath];

  if (args.output_dir) cliArgs.push('--output', args.output_dir);
  if (args.filter_tag) cliArgs.push('--filter', args.filter_tag);
  if (args.view_name) cliArgs.push('--view', args.view_name);
  if (args.validate) cliArgs.push('--validate');
  if (args.resume) {
    // resume is boolean in tool def — auto-resolve the report.json path
    let resumePath = null;
    const resolvedOutputDir = args.output_dir || (() => {
      try {
        const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        return path.resolve(path.dirname(manifestPath), m.outputDir || 'screenshots');
      } catch { return null; }
    })();
    if (resolvedOutputDir) {
      const candidatePath = path.join(resolvedOutputDir, 'report.json');
      if (fs.existsSync(candidatePath)) resumePath = candidatePath;
    }
    if (resumePath) {
      cliArgs.push('--resume', resumePath);
    }
  }
  if (args.compare_dir) cliArgs.push('--compare', args.compare_dir);
  if (args.compare_baseline) cliArgs.push('--compare-baseline');
  if (args.save_baseline) cliArgs.push('--save-baseline');
  if (args.concurrency) cliArgs.push('--concurrency', String(args.concurrency));
  if (Array.isArray(args.exclude_names)) {
    for (const name of args.exclude_names) cliArgs.push('--exclude', name);
  }
  if (Array.isArray(args.exclude_tags)) {
    for (const tag of args.exclude_tags) cliArgs.push('--exclude-tag', tag);
  }
  if (args.format) cliArgs.push('--format', args.format);
  if (args.quality != null) cliArgs.push('--quality', String(args.quality));
  if (args.html_report) cliArgs.push('--html-report');
  if (args.quiet) cliArgs.push('--quiet');
  if (args.verbose) cliArgs.push('--verbose');
  if (args.dry_run) cliArgs.push('--dry-run');
  const timeoutMs = ((args.timeout_seconds || 300) * 1000) || TASK_TIMEOUTS.SNAPSCOPE_CAPTURE;
  const { stdout, stderr, exitCode } = await runSnapScopeCli(exePath, cliArgs, timeoutMs);

  // Determine output directory: explicit arg > manifest's outputDir > default
  let outputDir = args.output_dir;
  if (!outputDir) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const manifestDir = path.dirname(manifestPath);
      outputDir = path.resolve(manifestDir, manifest.outputDir || 'screenshots');
    } catch {
      outputDir = null;
    }
  }

  // Try to read report.json if it exists
  let report = null;
  if (outputDir) {
    const reportPath = path.join(outputDir, 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      logger.debug('[snapscope-handlers] non-critical error reading cached report:', err.message || err);
    }
    }
  }

  // Build response
  let output = '## SnapScope Capture Results\n\n';

  if (args.dry_run) output += '**Mode:** Dry run (no captures executed)\n\n';
  if (args.validate) output += '**Validation:** enabled\n';
  if (args.resume) output += '**Mode:** Resume (re-running failed views only)\n';
  if (args.view_name) output += `**View:** ${args.view_name}\n`;
  if (args.filter_tag) output += `**Filter:** tag = "${args.filter_tag}"\n`;

  output += `**Exit code:** ${exitCode}\n\n`;

  if (report) {
    // Use camelCase field names (matching [JsonPropertyName] attributes)
    const succeeded = report.succeeded || 0;
    const failed = report.failed || 0;
    const total = succeeded + failed;
    output += `### Summary\n\n`;
    output += `- **Succeeded:** ${succeeded}\n`;
    output += `- **Failed:** ${failed}\n`;
    output += `- **Total:** ${total}\n`;

    if (report.resumedFrom) {
      output += `- **Resumed from:** ${report.resumedFrom}\n`;
    }

    output += '\n';

    if (report.results && report.results.length > 0) {
      output += '### Captures\n\n';
      output += '| View | Status | Attempts | File | Size |\n|------|--------|----------|------|------|\n';
      for (const cap of report.results) {
        const status = cap.success ? 'OK' : 'FAILED';
        const attempts = cap.attemptCount || 1;
        const file = cap.filePath ? path.basename(cap.filePath) : '-';
        const size = cap.fileSizeBytes ? formatBytes(cap.fileSizeBytes) : '-';
        const failedStep = !cap.success && cap.failedStep ? ` (${cap.failedStep})` : '';
        output += `| ${cap.viewName || '-'} | ${status}${failedStep} | ${attempts} | ${file} | ${size} |\n`;
      }
      output += '\n';
    }

    // Comparison results
    if (report.comparisonResults && report.comparisonResults.length > 0) {
      const diffs = report.comparisonResults.filter(c => c.hasDifferences);
      output += `### Visual Comparison\n\n`;
      output += `- **Compared:** ${report.comparisonResults.length} views\n`;
      output += `- **Differences found:** ${diffs.length}\n\n`;

      if (diffs.length > 0) {
        output += '| View | Diff % | Changed Pixels | Diff Image |\n|------|--------|----------------|------------|\n';
        for (const comp of diffs) {
          const viewName = path.basename(comp.currentPath || '', '.png');
          const pct = (comp.diffPercent * 100).toFixed(2) + '%';
          const diffFile = comp.diffPath ? path.basename(comp.diffPath) : '-';
          output += `| ${viewName} | ${pct} | ${comp.changedPixels} | ${diffFile} |\n`;
        }
        output += '\n';
      }
    }

    if (outputDir) {
      output += `**Output directory:** ${outputDir}\n`;
    }
  } else {
    // No report.json — parse summary from stdout
    const summaryMatch = stdout.match(/Succeeded:\s*(\d+).*Failed:\s*(\d+)/i);
    if (summaryMatch) {
      output += `### Summary\n\n`;
      output += `- **Succeeded:** ${summaryMatch[1]}\n`;
      output += `- **Failed:** ${summaryMatch[2]}\n\n`;
    }

    if (stdout.trim()) {
      output += '### CLI Output\n\n```\n' + stdout.trim() + '\n```\n\n';
    }
  }

  if (exitCode !== 0) {
    return makeError(ErrorCodes.OPERATION_FAILED, `SnapScope CLI failed (exit code ${exitCode}): ${stderr || stdout || 'unknown error'}`);
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── capture_view ────────────────────────────────────────────────────────────

async function handleCaptureView(args) {
  try {
  
  const manifestPath = args.manifest_path;
  const viewName = args.view_name;

  if (!manifestPath || typeof manifestPath !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'manifest_path is required');
  }
  
  if (!viewName || typeof viewName !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'view_name is required');
  }
  if (!fs.existsSync(manifestPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Manifest file not found: ${manifestPath}`);
  }

  if (args.timeout_seconds !== undefined) {
    const val = Number(args.timeout_seconds);
    if (!Number.isFinite(val) || val < 1 || val > 600) {
      return makeError(ErrorCodes.INVALID_PARAM, 'timeout_seconds must be between 1 and 600');
    }
  }

  // Read manifest to verify view exists
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to parse manifest: ${err.message}`);
  }

  const views = manifest.views || [];
  const targetView = views.find(v => v.name === viewName);

  if (!targetView) {
    const availableNames = views.map(v => v.name).join('\n  - ');
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `View "${viewName}" not found in manifest.\n\nAvailable views:\n  - ${availableNames}`
    );
  }

  const exePath = await ensureBuilt();

  // Use --view flag instead of temp manifest
  const cliArgs = ['--manifest', manifestPath, '--view', viewName];
  if (args.output_dir) cliArgs.push('--output', args.output_dir);

  const timeoutMs = (args.timeout_seconds || 60) * 1000;
  const { stdout, stderr, exitCode } = await runSnapScopeCli(exePath, cliArgs, timeoutMs);

  // Determine output directory
  let outputDir = args.output_dir;
  if (!outputDir) {
    const manifestDir = path.dirname(manifestPath);
    outputDir = path.resolve(manifestDir, manifest.outputDir || 'screenshots');
  }

  // Try to read report.json
  let report = null;
  const reportPath = path.join(outputDir, 'report.json');
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      logger.debug('[snapscope-handlers] non-critical error reading report for single view:', err.message || err);
    }
  }

  // Build response
  let output = `## SnapScope: ${viewName}\n\n`;
  output += `**Exit code:** ${exitCode}\n`;

  if (report && report.results && report.results.length > 0) {
    const cap = report.results[0];
    const success = cap.success !== false;
    output += `**Status:** ${success ? 'Captured' : 'Failed'}\n`;

    if (cap.filePath) {
      output += `**File:** ${cap.filePath}\n`;
      if (cap.fileSizeBytes) {
        output += `**Size:** ${formatBytes(cap.fileSizeBytes)}\n`;
      }
    }

    if (!success && cap.failedStep) {
      output += `**Failed at:** ${cap.failedStep}\n`;
    }

    if (!success && cap.errorMessage) {
      output += `**Error:** ${cap.errorMessage}\n`;
    }

    if (cap.attemptCount > 1) {
      output += `**Attempts:** ${cap.attemptCount}\n`;
    }
  } else {
    output += '\n### CLI Output\n\n```\n' + (stdout.trim() || '(no output)') + '\n```\n';
  }

  if (exitCode !== 0) {
    return makeError(ErrorCodes.OPERATION_FAILED, `SnapScope CLI failed (exit code ${exitCode}): ${stderr || stdout || 'unknown error'}`);
  }

  if (outputDir) {
    output += `\n**Output directory:** ${outputDir}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── capture_views (batch) ───────────────────────────────────────────────────

async function handleCaptureViews(args) {
  try {
  
  const manifestPath = args.manifest_path;
  const viewNames = args.view_names;

  if (!manifestPath || typeof manifestPath !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'manifest_path is required');
  }
  
  if (!Array.isArray(viewNames) || viewNames.length === 0) {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'view_names must be a non-empty array of strings');
  }
  if (!fs.existsSync(manifestPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Manifest file not found: ${manifestPath}`);
  }

  if (args.timeout_seconds !== undefined) {
    const val = Number(args.timeout_seconds);
    if (!Number.isFinite(val) || val < 1 || val > 600) {
      return makeError(ErrorCodes.INVALID_PARAM, 'timeout_seconds must be between 1 and 600');
    }
  }

  // Read manifest and match views
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    return makeError(ErrorCodes.OPERATION_FAILED, `Failed to parse manifest: ${err.message}`);
  }

  const allViews = manifest.views || [];
  const allViewNames = allViews.map(v => v.name);

  const matched = [];
  const unmatched = [];

  for (const name of viewNames) {
    const view = allViews.find(v => v.name === name);
    if (view) {
      matched.push(view);
    } else {
      unmatched.push(name);
    }
  }

  if (unmatched.length > 0) {
    return makeError(
      ErrorCodes.INVALID_PARAM,
      `View(s) not found in manifest: ${unmatched.map(n => `"${n}"`).join(', ')}\n\nAvailable views:\n  - ${allViewNames.join('\n  - ')}`
    );
  }

  const exePath = await ensureBuilt();

  // Write temp manifest with only the matched views
  const tempManifest = {
    ...manifest,
    views: matched
  };

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snapscope-batch-'));
  const tempManifestPath = path.join(tempDir, 'batch-manifest.json');
  fs.writeFileSync(tempManifestPath, JSON.stringify(tempManifest, null, 2), 'utf8');

  const cliArgs = ['--manifest', tempManifestPath];
  if (args.output_dir) {
    cliArgs.push('--output', args.output_dir);
  }

  const timeoutMs = (args.timeout_seconds || 120) * 1000;
  const { stdout, stderr, exitCode } = await runSnapScopeCli(exePath, cliArgs, timeoutMs);

  // Clean up temp files
  try {
    fs.unlinkSync(tempManifestPath);
    fs.rmdirSync(tempDir);
  } catch (err) {
    logger.debug('[snapscope-handlers] non-critical error cleaning temporary manifest files:', err.message || err);
  }

  // Determine output directory
  let outputDir = args.output_dir;
  if (!outputDir) {
    const manifestDir = path.dirname(manifestPath);
    outputDir = path.resolve(manifestDir, manifest.outputDir || 'screenshots');
  }

  // Try to read report.json
  let report = null;
  if (outputDir) {
    const reportPath = path.join(outputDir, 'report.json');
    if (fs.existsSync(reportPath)) {
      try {
        report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (err) {
      logger.debug('[snapscope-handlers] non-critical error reading batch report:', err.message || err);
    }
    }
  }

  // Build response
  let output = `## SnapScope Batch: ${matched.length} views\n\n`;
  output += `**Exit code:** ${exitCode}\n`;

  if (report) {
    const succeeded = report.succeeded || 0;
    const failed = report.failed || 0;
    output += `\n### Summary\n\n`;
    output += `- **Succeeded:** ${succeeded}\n`;
    output += `- **Failed:** ${failed}\n`;
    output += `- **Total:** ${succeeded + failed}\n\n`;

    if (report.results && report.results.length > 0) {
      output += '### Captures\n\n';
      output += '| View | Status | File | Size |\n|------|--------|------|------|\n';
      for (const cap of report.results) {
        const status = cap.success ? 'OK' : 'FAILED';
        const file = cap.filePath ? path.basename(cap.filePath) : '-';
        const size = cap.fileSizeBytes ? formatBytes(cap.fileSizeBytes) : '-';
        output += `| ${cap.viewName || '-'} | ${status} | ${file} | ${size} |\n`;
      }
      output += '\n';
    }
  } else {
    if (stdout.trim()) {
      output += '\n### CLI Output\n\n```\n' + stdout.trim() + '\n```\n\n';
    }
  }

  if (exitCode !== 0) {
    return makeError(ErrorCodes.OPERATION_FAILED, `SnapScope CLI failed (exit code ${exitCode}): ${stderr || stdout || 'unknown error'}`);
  }

  if (outputDir) {
    output += `**Output directory:** ${outputDir}\n`;
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── validate_manifest ───────────────────────────────────────────────────────

async function handleValidateManifest(args) {
  try {
  
  const manifestPath = args.manifest_path;
  if (!manifestPath || typeof manifestPath !== 'string') {
    return makeError(ErrorCodes.MISSING_REQUIRED_PARAM, 'manifest_path is required');
  }
  

  if (!fs.existsSync(manifestPath)) {
    return makeError(ErrorCodes.INVALID_PARAM, `Manifest file not found: ${manifestPath}`);
  }

  const exePath = await ensureBuilt();

  // Run CLI with --validate --dry-run to validate without capturing
  const cliArgs = ['--manifest', manifestPath, '--validate', '--dry-run'];
  const { stdout, stderr, exitCode } = await runSnapScopeCli(exePath, cliArgs, 30000);

  let output = `## Manifest Validation: ${path.basename(manifestPath)}\n\n`;

  if (exitCode === 0) {
    output += '**Result:** Valid\n\n';

    // Parse view count from dry-run output
    const viewMatch = stdout.match(/(\d+)\s+view\(s\)\s+selected/i);
    if (viewMatch) {
      output += `**Views:** ${viewMatch[1]}\n\n`;
    }

    // Include dry-run view list
    const viewLines = stdout.split('\n')
      .filter(l => l.trim().startsWith('- '))
      .map(l => l.trim());

    if (viewLines.length > 0) {
      output += '### Views\n\n';
      for (const line of viewLines) {
        output += `${line}\n`;
      }
    }
  } else {
    output += '**Result:** Invalid\n\n';

    if (stderr.trim()) {
      output += '### Errors\n\n';
      const lines = stderr.split('\n').filter(l => l.trim());
      for (const line of lines) {
        output += `- ${line.trim()}\n`;
      }
    }
  }

  return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    return makeError(ErrorCodes.INTERNAL_ERROR, err.message || String(err));
  }}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let _sharpModule = null;
function getSharpModule() {
  if (!_sharpModule) {
    try { _sharpModule = require('sharp'); }
    catch { throw new Error('sharp is not installed. Install it with: npm install sharp'); }
  }
  return _sharpModule;
}

async function applyAnnotations(imageBuffer, annotations) {
  if (!annotations || annotations.length === 0) return imageBuffer;

  const sharp = getSharpModule();
  const metadata = await sharp(imageBuffer).metadata();
  const { width, height } = metadata;
  const COLORS = {
    red: 'rgba(255,0,0,0.8)',
    yellow: 'rgba(255,255,0,0.8)',
    green: 'rgba(0,255,0,0.8)',
    blue: 'rgba(0,100,255,0.8)'
  };

  const svgParts = [];

  for (const ann of annotations) {
    const color = COLORS[ann.color] || COLORS.red;

    if (ann.type === 'rect') {
      svgParts.push(
        `<rect x="${ann.x}" y="${ann.y}" width="${ann.w}" height="${ann.h}" fill="none" stroke="${color}" stroke-width="3"/>`
      );
      if (ann.label) {
        svgParts.push(
          `<text x="${ann.x}" y="${ann.y - 5}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    } else if (ann.type === 'circle') {
      svgParts.push(
        `<circle cx="${ann.x}" cy="${ann.y}" r="${ann.r}" fill="none" stroke="${color}" stroke-width="3"/>`
      );
      if (ann.label) {
        svgParts.push(
          `<text x="${ann.x + ann.r + 5}" y="${ann.y}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    } else if (ann.type === 'arrow' && ann.from && ann.to) {
      const [x1, y1] = ann.from;
      const [x2, y2] = ann.to;
      svgParts.push(
        `<defs><marker id="ah" markerWidth="10" markerHeight="7" refX="10" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="${color}"/></marker></defs>`
      );
      svgParts.push(
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="3" marker-end="url(#ah)"/>`
      );
      if (ann.label) {
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2 - 10;
        svgParts.push(
          `<text x="${mx}" y="${my}" fill="${color}" font-size="16" font-family="sans-serif" font-weight="bold">${escapeXml(ann.label)}</text>`
        );
      }
    }
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${svgParts.join('')}</svg>`;
  return sharp(imageBuffer)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .toBuffer();
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  handleCaptureScreenshots,
  handleCaptureView,
  handleCaptureViews,
  handleValidateManifest,
};
