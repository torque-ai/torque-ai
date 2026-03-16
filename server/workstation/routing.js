'use strict';

const model = require('./model');

const TEST_RUNNER_KEYWORDS = [
  'vitest',
  'jest',
  'pytest',
  'cargo test',
  'go test',
  'dotnet test',
  'mocha',
];

const BUILD_TOOL_KEYWORDS = [
  'npm run build',
  'dotnet build',
  'cargo build',
  'go build',
  'gradle',
  'maven',
  'make',
];

const OLLAMA_PROVIDERS = ['ollama', 'hashline-ollama', 'aider-ollama'];

function setDb(dbInstance) {
  model.setDb(dbInstance);
}

function isWorkstationAvailable(ws) {
  if (!ws) return false;
  if (ws.status === 'down') return false;
  return (ws.running_tasks || 0) < (ws.max_concurrent || 0);
}

function hasKeywordMatch(verifyCommand, keywords) {
  const normalizedCommand = (verifyCommand || '').toLowerCase();
  return keywords.some((keyword) => normalizedCommand.includes(keyword));
}

function selectByModel(workstations, requestedModel) {
  if (!requestedModel) return null;

  const lowerModel = String(requestedModel).toLowerCase();
  return workstations.find((ws) => Array.isArray(ws.models) && ws.models.some(
    (entry) => String(entry || '').toLowerCase() === lowerModel
  ));
}

function findWorkstationForTask(taskArgs = {}) {
  const workstations = model.listWorkstations({ enabled: true })
    .filter(isWorkstationAvailable);

  if (workstations.length === 0) return null;

  const verifyCommand = taskArgs.verify_command || '';
  const provider = String(taskArgs.provider || '').toLowerCase();
  const tool = taskArgs.tool || '';

  // Signal 1: verification command test runners
  if (hasKeywordMatch(verifyCommand, TEST_RUNNER_KEYWORDS)) {
    return workstations.find((ws) => model.hasCapability(ws, 'test_runners')) || null;
  }

  // Signal 2: verification command build tools
  if (hasKeywordMatch(verifyCommand, BUILD_TOOL_KEYWORDS)) {
    return workstations.find((ws) => model.hasCapability(ws, 'build_tools')) || null;
  }

  // Signal 3: provider requires Ollama workstation
  if (OLLAMA_PROVIDERS.includes(provider)) {
    const ollamaWorkers = workstations.filter((ws) => model.hasCapability(ws, 'ollama'));
    if (ollamaWorkers.length > 0) {
      const modelMatch = selectByModel(ollamaWorkers, taskArgs.model);
      return modelMatch || ollamaWorkers[0];
    }
  }

  // Signal 4: UI capture task
  if (tool === 'peek_ui') {
    return workstations.find((ws) => model.hasCapability(ws, 'ui_capture')) || null;
  }

  // Signal 5: fallback default workstation
  const defaultWs = model.getDefaultWorkstation();
  if (defaultWs && isWorkstationAvailable(defaultWs)) {
    return defaultWs;
  }

  return null;
}

module.exports = {
  setDb,
  findWorkstationForTask,
};
