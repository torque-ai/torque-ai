'use strict';

// Contract every sandbox backend implements. Each method listed here as a reminder;
// backends are plain objects with these function-shaped keys.
//
// create({ image?, cwd?, env?, timeoutMs?, name? }) → { sandboxId, backend }
// runCommand(sandboxId, { cmd, args, cwd?, env?, stdin?, timeoutMs? }) → { stdout, stderr, exitCode }
// fs.read(sandboxId, path) → Buffer
// fs.write(sandboxId, path, content) → { bytes }
// fs.list(sandboxId, path) → [{ name, type, size }]
// destroy(sandboxId) → { destroyed }
// snapshot(sandboxId) → { imageId }
//
// IMPORTANT: runCommand takes cmd + args array separately. No shell interpolation.

module.exports = { /* marker only */ };
