'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');

const pExecFile = promisify(execFile);

function requireString(name, value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new Error(`${name} is required`);
  }
  return normalized;
}

function resolveModelPath(modelsDir, baseModel) {
  const modelFile = `${requireString('baseModel', baseModel)}.gguf`;
  if (path.isAbsolute(modelFile) || modelFile.split(/[\\/]+/).includes('..')) {
    throw new Error('baseModel must be a model name, not a path');
  }
  return path.join(modelsDir, modelFile);
}

// Requires llama.cpp's finetune binary plus a base GGUF model. Paths are
// configured with TORQUE_LLAMACPP_BIN and TORQUE_LLAMACPP_MODELS_DIR.
async function train({ datasetPath, baseModel, jobId, onProgress } = {}) {
  const bin = process.env.TORQUE_LLAMACPP_BIN || '/usr/local/bin/llama-finetune';
  const modelsDir = process.env.TORQUE_LLAMACPP_MODELS_DIR || '/var/torque/models';
  const resolvedDatasetPath = requireString('datasetPath', datasetPath);
  const resolvedJobId = requireString('jobId', jobId);
  const basePath = resolveModelPath(modelsDir, baseModel);
  const adaptersDir = path.join(modelsDir, 'adapters');
  const adapterPath = path.join(adaptersDir, `${resolvedJobId}.lora.gguf`);

  await fs.promises.mkdir(adaptersDir, { recursive: true });

  const args = [
    '--model-base', basePath,
    '--train-data', resolvedDatasetPath,
    '--lora-out', adapterPath,
    '--sample-start', 'plain',
    '--epochs', '1',
  ];

  try {
    await pExecFile(bin, args, { timeout: 60 * 60 * 1000 });
    if (typeof onProgress === 'function') onProgress(1.0);
    return { adapterPath };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    throw new Error(`llama-finetune failed: ${message}`);
  }
}

module.exports = { train };
