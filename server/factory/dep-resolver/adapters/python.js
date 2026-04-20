'use strict';

const PYTHON_MISS_PATTERNS = [
  { re: /ModuleNotFoundError: No module named ['"]([\w.]+)['"]/, signal: 'ModuleNotFoundError' },
  { re: /ImportError: cannot import name ['"]([\w.]+)['"] from ['"]([\w.]+)['"]/, signal: 'ImportError', groupIndex: 2 },
  { re: /ImportError: No module named ([\w.]+)/, signal: 'ImportError' },
];

function detect(errorOutput) {
  if (typeof errorOutput !== 'string' || errorOutput.length === 0) {
    return { detected: false };
  }
  for (const { re, signal, groupIndex } of PYTHON_MISS_PATTERNS) {
    const m = errorOutput.match(re);
    if (m) {
      const moduleName = m[groupIndex || 1];
      return {
        detected: true,
        manager: 'python',
        module_name: moduleName,
        signals: [signal],
      };
    }
  }
  return { detected: false };
}

const MAP_LLM_TIMEOUT_MS = 60_000;

async function mapModuleToPackage({ module_name, error_output, manifest_excerpt, project, workItem, timeoutMs = MAP_LLM_TIMEOUT_MS }) {
  const { submitFactoryInternalTask } = require('../../internal-task-submit');
  const { handleAwaitTask } = require('../../../handlers/workflow/await');
  const taskCore = require('../../../db/task-core');

  const prompt = buildMappingPrompt({ module_name, error_output, manifest_excerpt });
  let taskId;
  try {
    const submission = await submitFactoryInternalTask({
      task: prompt,
      working_directory: project?.path || process.cwd(),
      kind: 'reasoning',
      project_id: project?.id,
      work_item_id: workItem?.id,
      timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)),
    });
    taskId = submission?.task_id || null;
  } catch (_e) {
    return { package_name: null, confidence: 'low' };
  }
  if (!taskId) return { package_name: null, confidence: 'low' };

  try {
    await handleAwaitTask({ task_id: taskId, timeout_minutes: Math.max(1, Math.floor(timeoutMs / 60_000)), heartbeat_minutes: 0 });
  } catch (_e) {
    return { package_name: null, confidence: 'low' };
  }
  const task = taskCore.getTask(taskId);
  if (!task || task.status !== 'completed') return { package_name: null, confidence: 'low' };

  const raw = String(task.output || '').trim();
  if (!raw) return { package_name: null, confidence: 'low' };
  try {
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    const parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(raw);
    const pkg = typeof parsed.package_name === 'string' && parsed.package_name.trim().length > 0
      ? parsed.package_name.trim()
      : null;
    const conf = parsed.confidence === 'high' || parsed.confidence === 'medium' ? parsed.confidence : 'low';
    if (!pkg) return { package_name: null, confidence: 'low' };
    return { package_name: pkg, confidence: conf };
  } catch (_e) {
    void _e;
    return { package_name: null, confidence: 'low' };
  }
}

function buildMappingPrompt({ module_name, error_output, manifest_excerpt }) {
  return `You are helping a software factory recover from a missing-dependency verify failure in a Python project.

The verify step failed because the following module could not be imported: \`${module_name}\`.

Relevant error output:
${(error_output || '').slice(0, 4000)}

Relevant manifest excerpt (truncated):
${(manifest_excerpt || '(none)').slice(0, 4000)}

Return ONLY valid JSON matching this shape:
{"package_name":"<PyPI package name or null>","confidence":"high"|"medium"|"low"}

- "high"   — you are confident which PyPI package installs this module (e.g. \`cv2\` → \`opencv-python\`).
- "medium" — best guess but not certain.
- "low"    — unclear; the factory should treat this as unresolvable.
`;
}

function createPythonAdapter() {
  return {
    manager: 'python',
    detect,
    mapModuleToPackage,
    buildResolverPrompt(_opts) { return ''; },
    validateManifestUpdate(_worktreePath, _expectedPackage) { return { valid: false, reason: 'stub' }; },
  };
}

module.exports = { createPythonAdapter, PYTHON_MISS_PATTERNS, MAP_LLM_TIMEOUT_MS };
