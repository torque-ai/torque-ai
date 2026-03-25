/**
 * TORQUE Structured Logger
 *
 * JSON-lines logging with levels, rotation, and context.
 * Outputs to both file (torque.log) and stderr.
 */

const fs = require('fs');
const path = require('path');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_NAMES = Object.keys(LEVELS);
// Patterns that match common secret formats in log output
const REDACT_PATTERNS = [
  // API keys (various providers)
  /(?:api[_-]?key|apikey|authorization|bearer|token|secret|password|credential)[\s]*[=:]\s*["']?([a-zA-Z0-9_.-]{8,})["']?/gi,
  // Environment variable assignments with secret-looking values
  /(?:ANTHROPIC_API_KEY|OPENAI_API_KEY|DEEPINFRA_API_KEY|HYPERBOLIC_API_KEY|GROQ_API_KEY|TORQUE_API_KEY|API_KEY|SECRET_KEY|AUTH_TOKEN)=([^\s&"']+)/gi,
  // Bearer tokens in headers
  /Bearer\s+([a-zA-Z0-9_.-]{20,})/g,
  // sk- prefixed keys (OpenAI style)
  /\b(sk-[a-zA-Z0-9]{20,})\b/g,
  // Key-like hex/base64 strings after common prefixes
  /(?:key|secret|token|password)["']?\s*:\s*["']([a-zA-Z0-9+/=_-]{16,})["']/gi,
  { regex: /https?:\/\/[^:]+:[^@]+@/gi, replacement: 'https://***:***@' },
  { regex: /Basic\s+[A-Za-z0-9+/=]{8,}/gi, replacement: 'Basic [REDACTED]' },
  { regex: /whsec_[A-Za-z0-9_-]+/gi, replacement: '[REDACTED]' },
  { regex: /"secret"\s*:\s*"[^"]+"/gi, replacement: '"secret": "[REDACTED]"' },
  // Google AI API keys
  /AIza[0-9A-Za-z_-]{35}/g,
  // AWS access keys
  /AKIA[0-9A-Z]{16}/g,
  // GitHub tokens
  /gh[ps]_[A-Za-z0-9_]{36,}/g,
  /github_pat_[A-Za-z0-9_]{22,}/g,
];

const REDACTION_MARKER = '[REDACTED]';

class Logger {
  constructor(options = {}) {
    this.level = LEVELS[options.level || 'info'] || LEVELS.info;
    this.logDir = options.logDir || require('./data-dir').getDataDir();
    this.logFile = options.logFile || 'torque.log';
    this.maxSize = options.maxSize || 10 * 1024 * 1024; // 10MB
    this.maxFiles = options.maxFiles || 5;
    this.context = options.context || {};
    this._stream = null;
    this._currentSize = 0;
    this._rotating = false;
    this._pendingWrites = [];
  }

  _getStream() {
    if (!this._stream) {
      const filePath = path.join(this.logDir, this.logFile);
      try {
        fs.mkdirSync(this.logDir, { recursive: true });
      } catch {
        return null;
      }
      // SECURITY: check for symlink attack before opening
      try {
        const lstat = fs.lstatSync(filePath);
        if (lstat.isSymbolicLink()) {
          process.stderr.write(`[TORQUE Logger] SECURITY: log file is a symlink, refusing to write: ${filePath}\n`);
          return null;
        }
        this._currentSize = lstat.size;
      } catch {
        this._currentSize = 0;
      }
      // Also check log directory for symlinks
      try {
        const dirStat = fs.lstatSync(this.logDir);
        if (dirStat.isSymbolicLink()) {
          process.stderr.write(`[TORQUE Logger] SECURITY: log directory is a symlink, refusing to write: ${this.logDir}\n`);
          return null;
        }
      } catch { /* directory doesn't exist yet, will be created */ }
      this._stream = fs.createWriteStream(filePath, { flags: 'a' });
      this._stream.on('error', () => {
        this._stream = null;
      });
    }
    return this._stream;
  }

  _rotate() {
    if (this._rotating) return;

    this._rotating = true;
    const rotatedSize = this._currentSize;
    process.stderr.write(`[TORQUE Logger] Log rotation triggered (size: ${(rotatedSize / 1024 / 1024).toFixed(1)}MB, max: ${(this.maxSize / 1024 / 1024).toFixed(1)}MB)\n`);
    try {
      if (this._stream) {
        // Use destroy() instead of end() for synchronous fd release.
        // end() is async — the fd may still be open when renameSync runs,
        // causing a race where writes land in the renamed file.
        this._stream.destroy();
        this._stream = null;
      }

      const basePath = path.join(this.logDir, this.logFile);

      // Shift existing rotated files
      // Note: when maxFiles is 1, the current file is renamed to .1 with no rotation
      for (let i = this.maxFiles - 1; i >= 1; i--) {
        const from = `${basePath}.${i}`;
        const to = `${basePath}.${i + 1}`;
        try {
          const lstat = fs.lstatSync(from);
          if (lstat.isSymbolicLink()) {
            process.stderr.write(`[TORQUE Logger] SECURITY: refusing to rotate symlink: ${from}\n`);
            continue;
          }
          fs.renameSync(from, to);
        } catch { /* ignore — file may not exist */ }
      }

      // Rotate current file
      try {
        const lstat = fs.lstatSync(basePath);
        if (lstat.isSymbolicLink()) {
          process.stderr.write(`[TORQUE Logger] SECURITY: refusing to rotate symlink: ${basePath}\n`);
        } else {
          fs.renameSync(basePath, `${basePath}.1`);
        }
      } catch { /* ignore */ }

      this._currentSize = 0;
    } finally {
      this._rotating = false;
      this._flushPendingWrites();
    }
  }

  _writeLine(line) {
    if (this._rotating) {
      this._pendingWrites.push(line);
      return;
    }
    const stream = this._getStream();
    if (!stream) {
      // Stream unavailable (e.g., symlink detected) — drop the line silently
      return;
    }
    stream.write(line);
    this._currentSize += Buffer.byteLength(line);
  }

  _flushPendingWrites() {
    while (this._pendingWrites.length > 0) {
      this._writeLine(this._pendingWrites.shift());
    }
  }

  _redact(line) {
    let result = line;
    for (const pattern of REDACT_PATTERNS) {
      const regex = pattern.regex || pattern;
      // Reset lastIndex for global regexes
      regex.lastIndex = 0;
      if (pattern.replacement) {
        result = result.replace(regex, pattern.replacement);
        continue;
      }
      result = result.replace(regex, (match, captured) => {
        return match.replace(captured, REDACTION_MARKER);
      });
    }
    return result;
  }

  _write(level, message, data = {}) {
    if (LEVELS[level] < this.level) return;

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...this.context,
      ...data,
    };

    const line = this._redact(JSON.stringify(entry)) + '\n';

    // Write to file (not stderr — MCP servers must not write to stderr
    // as it renders directly in the parent Claude Code terminal)
    try {
      if (this._rotating) {
        this._pendingWrites.push(line);
        return;
      }

      if (this._currentSize > this.maxSize) {
        this._rotate();
      }

      this._writeLine(line);
    } catch {
      // Fallback: just stderr
    }
  }

  debug(message, data) { this._write('debug', message, data); }
  info(message, data) { this._write('info', message, data); }
  warn(message, data) { this._write('warn', message, data); }
  error(message, data) { this._write('error', message, data); }

  /**
   * Create a child logger with additional context
   */
  child(context) {
    const child = new Logger({
      level: LEVEL_NAMES[this.level],
      logDir: this.logDir,
      logFile: this.logFile,
      maxSize: this.maxSize,
      maxFiles: this.maxFiles,
      context: { ...this.context, ...context },
    });
    child._stream = this._stream; // Share file handle
    child._currentSize = this._currentSize;
    return child;
  }

  /**
   * Close the logger
   */
  close() {
    if (this._stream) {
      this._stream.end();
      this._stream = null;
    }
  }
}

// Default singleton instance
const logger = new Logger();

module.exports = logger;
module.exports.Logger = Logger;
