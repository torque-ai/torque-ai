'use strict';

const fs = require('fs');
const { detectVisualSurfaces, loadManifest, findUnregistered, suggestManifestEntry } = require('./manifest-patterns');
const logger = require('../logger').child({ component: 'manifest-enforcement' });

function createHook() {
  return async function checkManifest(context) {
    const { taskId, task, changed_files } = context;
    if (!changed_files || changed_files.length === 0) return null;

    const workDir = task && task.working_directory;
    if (!workDir) return null;

    const manifest = loadManifest(workDir);
    if (!manifest || !manifest.framework) return null;

    const contents = {};
    for (const file of changed_files) {
      try {
        const fullPath = require('path').resolve(workDir, file);
        contents[file] = fs.readFileSync(fullPath, 'utf-8');
      } catch {
        // file may have been deleted
      }
    }

    const surfaces = detectVisualSurfaces(changed_files, contents, manifest.framework);
    if (surfaces.length === 0) return null;

    const unregistered = findUnregistered(surfaces, manifest);
    if (unregistered.length === 0) return null;

    const suggested = unregistered.map(s => suggestManifestEntry(s));
    const fileList = unregistered.map(s => `${s.file} (${s.type}: ${s.id})`).join(', ');

    logger.info(`[ManifestEnforcement] Task ${taskId}: ${unregistered.length} unregistered visual surface(s): ${fileList}`);

    return {
      gate: 'manifest_update',
      task_id: taskId,
      unregistered,
      suggested_entries: suggested,
      message: `New visual surface(s) detected but not in peek-manifest.json: ${fileList}. Add to manifest?`
    };
  };
}

module.exports = { createHook };
