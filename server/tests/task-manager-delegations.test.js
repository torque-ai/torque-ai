'use strict';

// All sub-module mocks — keyed by the require path used in task-manager-delegations.js
const mockModules = {
  '../utils/hashline-parser': {
    computeLineHash: vi.fn(() => 'ab'),
    lineSimilarity: vi.fn(() => 0.5),
    parseHashlineLiteEdits: vi.fn(() => []),
    findSearchMatch: vi.fn(() => null),
    applyHashlineLiteEdits: vi.fn(() => 'edited'),
    parseHashlineEdits: vi.fn(() => []),
    applyHashlineEdits: vi.fn(() => 'edited'),
  },
  '../utils/file-resolution': {
    isShellSafe: vi.fn(() => true),
    extractTargetFilesFromDescription: vi.fn(() => []),
    buildFileIndex: vi.fn(() => ({})),
    extractFileReferencesExpanded: vi.fn(() => []),
    resolveFileReferences: vi.fn(() => []),
    isValidFilePath: vi.fn(() => true),
    extractModifiedFiles: vi.fn(() => []),
  },
  '../utils/host-monitoring': {
    isModelLoadedOnHost: vi.fn(() => false),
    getHostActivity: vi.fn(() => ({})),
    pollHostActivity: vi.fn(async () => ({})),
    probeLocalGpuMetrics: vi.fn(async () => ({})),
    probeRemoteGpuMetrics: vi.fn(async () => ({})),
  },
  '../utils/activity-monitoring': {
    getTaskActivity: vi.fn(() => null),
    getAllTaskActivity: vi.fn(() => []),
    canAcceptTask: vi.fn(() => true),
  },
  '../coordination/instance-manager': {
    registerInstance: vi.fn(),
    startInstanceHeartbeat: vi.fn(),
    stopInstanceHeartbeat: vi.fn(),
    unregisterInstance: vi.fn(),
    updateInstanceInfo: vi.fn(),
    isInstanceAlive: vi.fn(() => true),
    getMcpInstanceId: vi.fn(() => 'test-id'),
  },
  '../validation/post-task': {
    cleanupJunkFiles: vi.fn(),
    getFileChangesForValidation: vi.fn(() => []),
    findPlaceholderArtifacts: vi.fn(() => []),
    checkFileQuality: vi.fn(() => ({ passed: true })),
    checkDuplicateFiles: vi.fn(() => ({ passed: true })),
    checkSyntax: vi.fn(() => ({ passed: true })),
    runLLMSafeguards: vi.fn(() => ({ passed: true })),
    runBuildVerification: vi.fn(() => ({ passed: true })),
    runTestVerification: vi.fn(() => ({ passed: true })),
    runStyleCheck: vi.fn(() => ({ passed: true })),
    rollbackTaskChanges: vi.fn(),
    revertScopedFiles: vi.fn(),
    scopedRollback: vi.fn(),
  },
  '../providers/prompts': {
    detectTaskTypes: vi.fn(() => []),
    getInstructionTemplate: vi.fn(() => ''),
    wrapWithInstructions: vi.fn(() => 'wrapped'),
  },
  '../providers/execution': {
    executeApiProvider: vi.fn(async () => ({ output: 'ok' })),
    executeOllamaTask: vi.fn(async () => ({ output: 'ok' })),
    executeHashlineOllamaTask: vi.fn(async () => ({ output: 'ok' })),
  },
  '../execution/fallback-retry': {
    tryOllamaCloudFallback: vi.fn(() => null),
    tryLocalFirstFallback: vi.fn(() => null),
    classifyError: vi.fn(() => 'unknown'),
    findNextHashlineModel: vi.fn(() => null),
    tryHashlineTieredFallback: vi.fn(() => null),
    selectHashlineFormat: vi.fn(() => 'standard'),
  },
  '../execution/workflow-runtime': {
    handlePipelineStepCompletion: vi.fn(),
    handleWorkflowTermination: vi.fn(),
    evaluateWorkflowDependencies: vi.fn(() => []),
    unblockTask: vi.fn(),
    applyFailureAction: vi.fn(),
    cancelDependentTasks: vi.fn(),
    checkWorkflowCompletion: vi.fn(() => false),
  },
  '../validation/output-safeguards': {
    runOutputSafeguards: vi.fn(async () => ({ passed: true })),
  },
  '../execution/sandbox-revert-detection': {
    detectSandboxReverts: vi.fn(() => []),
  },
  '../validation/close-phases': {
    handleAutoValidation: vi.fn(),
    handleBuildTestStyleCommit: vi.fn(),
    handleProviderFailover: vi.fn(),
  },
  '../execution/completion-pipeline': {
    recordModelOutcome: vi.fn(),
    recordProviderHealth: vi.fn(),
    fireTerminalTaskHook: vi.fn(),
    handlePostCompletion: vi.fn(),
  },
  '../execution/task-finalizer': {
    finalizeTask: vi.fn(),
  },
  '../providers/aider-command': {
    buildAiderCommand: vi.fn(() => 'aider'),
    configureAiderHost: vi.fn(),
  },
  '../execution/queue-scheduler': {
    categorizeQueuedTasks: vi.fn(() => ({ ready: [], blocked: [] })),
    processQueueInternal: vi.fn(),
  },
  '../validation/hashline-verify': {
    verifyHashlineReferences: vi.fn(() => ({ valid: true })),
    attemptFuzzySearchRepair: vi.fn(() => null),
  },
  '../maintenance/orphan-cleanup': {
    cleanupOrphanedHostTasks: vi.fn(),
    getStallThreshold: vi.fn(() => 180),
  },
};

// Inject mocks into require.cache before requiring the delegations module
function installMock(modulePath, mockObj) {
  const resolved = require.resolve(modulePath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports: mockObj,
  };
}

// Install all mocks
for (const [modPath, mock] of Object.entries(mockModules)) {
  // Convert from test-relative path to delegations-relative path
  // Test is in server/tests/, delegations is in server/
  // '../utils/x' from test = './utils/x' from delegations = same resolved path
  installMock(modPath, mock);
}

// Now require the module — it will pick up cached mocks
const delegations = require('../task-manager-delegations');

describe('task-manager-delegations', () => {
  beforeEach(() => {
    // Clear call counts but keep mock implementations
    for (const mock of Object.values(mockModules)) {
      for (const fn of Object.values(mock)) {
        if (typeof fn === 'function' && fn.mockClear) {
          fn.mockClear();
        }
      }
    }
  });

  it('exports all expected delegation functions', () => {
    const expected = [
      'computeLineHash', 'lineSimilarity', 'parseHashlineLiteEdits',
      'findSearchMatch', 'applyHashlineLiteEdits', 'parseHashlineEdits', 'applyHashlineEdits',
      'verifyHashlineReferences', 'attemptFuzzySearchRepair',
      'isShellSafe', 'extractTargetFilesFromDescription', 'buildFileIndex',
      'extractFileReferencesExpanded', 'resolveFileReferences', 'isValidFilePath', 'extractModifiedFiles',
      'isModelLoadedOnHost', 'getHostActivity', 'pollHostActivity',
      'probeLocalGpuMetrics', 'probeRemoteGpuMetrics',
      'getTaskActivity', 'getAllTaskActivity', 'canAcceptTask',
      'registerInstance', 'startInstanceHeartbeat', 'stopInstanceHeartbeat',
      'unregisterInstance', 'updateInstanceInfo', 'isInstanceAlive', 'getMcpInstanceId',
      'cleanupJunkFiles', 'getFileChangesForValidation', 'findPlaceholderArtifacts',
      'checkFileQuality', 'checkDuplicateFiles', 'checkSyntax', 'runLLMSafeguards',
      'runBuildVerification', 'runTestVerification', 'runStyleCheck',
      'rollbackTaskChanges', 'revertScopedFiles', 'scopedRollback',
      'detectTaskTypes', 'getInstructionTemplate', 'wrapWithInstructions',
      'executeApiProvider', 'executeOllamaTask',
      'executeHashlineOllamaTask',
      'tryOllamaCloudFallback', 'tryLocalFirstFallback', 'classifyError',
      'findNextHashlineModel', 'tryHashlineTieredFallback', 'selectHashlineFormat',
      'handlePipelineStepCompletion', 'handleWorkflowTermination',
      'evaluateWorkflowDependencies', 'unblockTask', 'applyFailureAction',
      'cancelDependentTasks', 'checkWorkflowCompletion',
      'runOutputSafeguards',
      'handleSandboxRevertDetection',
      'handleAutoValidation', 'handleBuildTestStyleCommit', 'handleProviderFailover',
      'recordModelOutcome', 'recordProviderHealth',
      'fireTerminalTaskHook', 'handlePostCompletion',
      'finalizeTask',
      'buildAiderCommand', 'configureAiderHost',
      'categorizeQueuedTasks', 'processQueueInternal',
      'cleanupOrphanedHostTasks', 'getStallThreshold',
    ];
    expect(Object.keys(delegations)).toEqual(expect.arrayContaining(expected));
  });

  it('exports only functions', () => {
    for (const value of Object.values(delegations)) {
      expect(typeof value).toBe('function');
    }
  });

  // Sync delegation specs: [exportName, mockModulePath, targetMethodName]
  const syncSpecs = [
    // hashline-parser
    ['computeLineHash', '../utils/hashline-parser'],
    ['lineSimilarity', '../utils/hashline-parser'],
    ['parseHashlineLiteEdits', '../utils/hashline-parser'],
    ['findSearchMatch', '../utils/hashline-parser'],
    ['applyHashlineLiteEdits', '../utils/hashline-parser'],
    ['parseHashlineEdits', '../utils/hashline-parser'],
    ['applyHashlineEdits', '../utils/hashline-parser'],
    // hashline-verify
    ['verifyHashlineReferences', '../validation/hashline-verify'],
    ['attemptFuzzySearchRepair', '../validation/hashline-verify'],
    // file-resolution
    ['isShellSafe', '../utils/file-resolution'],
    ['extractTargetFilesFromDescription', '../utils/file-resolution'],
    ['buildFileIndex', '../utils/file-resolution'],
    ['extractFileReferencesExpanded', '../utils/file-resolution'],
    ['resolveFileReferences', '../utils/file-resolution'],
    ['isValidFilePath', '../utils/file-resolution'],
    ['extractModifiedFiles', '../utils/file-resolution'],
    // host-monitoring (sync subset)
    ['isModelLoadedOnHost', '../utils/host-monitoring'],
    ['getHostActivity', '../utils/host-monitoring'],
    // activity-monitoring
    ['getTaskActivity', '../utils/activity-monitoring'],
    ['getAllTaskActivity', '../utils/activity-monitoring'],
    ['canAcceptTask', '../utils/activity-monitoring'],
    // instance-manager
    ['registerInstance', '../coordination/instance-manager'],
    ['startInstanceHeartbeat', '../coordination/instance-manager'],
    ['stopInstanceHeartbeat', '../coordination/instance-manager'],
    ['unregisterInstance', '../coordination/instance-manager'],
    ['updateInstanceInfo', '../coordination/instance-manager'],
    ['isInstanceAlive', '../coordination/instance-manager'],
    ['getMcpInstanceId', '../coordination/instance-manager'],
    // post-task
    ['cleanupJunkFiles', '../validation/post-task'],
    ['getFileChangesForValidation', '../validation/post-task'],
    ['findPlaceholderArtifacts', '../validation/post-task'],
    ['checkFileQuality', '../validation/post-task'],
    ['checkDuplicateFiles', '../validation/post-task'],
    ['checkSyntax', '../validation/post-task'],
    ['runLLMSafeguards', '../validation/post-task'],
    ['runBuildVerification', '../validation/post-task'],
    ['runTestVerification', '../validation/post-task'],
    ['runStyleCheck', '../validation/post-task'],
    ['rollbackTaskChanges', '../validation/post-task'],
    ['revertScopedFiles', '../validation/post-task'],
    ['scopedRollback', '../validation/post-task'],
    // prompts
    ['detectTaskTypes', '../providers/prompts'],
    ['getInstructionTemplate', '../providers/prompts'],
    ['wrapWithInstructions', '../providers/prompts'],
    // fallback-retry
    ['tryOllamaCloudFallback', '../execution/fallback-retry'],
    ['tryLocalFirstFallback', '../execution/fallback-retry'],
    ['classifyError', '../execution/fallback-retry'],
    ['findNextHashlineModel', '../execution/fallback-retry'],
    ['tryHashlineTieredFallback', '../execution/fallback-retry'],
    ['selectHashlineFormat', '../execution/fallback-retry'],
    // workflow-runtime
    ['handlePipelineStepCompletion', '../execution/workflow-runtime'],
    ['handleWorkflowTermination', '../execution/workflow-runtime'],
    ['evaluateWorkflowDependencies', '../execution/workflow-runtime'],
    ['unblockTask', '../execution/workflow-runtime'],
    ['applyFailureAction', '../execution/workflow-runtime'],
    ['cancelDependentTasks', '../execution/workflow-runtime'],
    ['checkWorkflowCompletion', '../execution/workflow-runtime'],
    // sandbox-revert-detection (renamed export)
    ['handleSandboxRevertDetection', '../execution/sandbox-revert-detection', 'detectSandboxReverts'],
    // close-phases
    ['handleAutoValidation', '../validation/close-phases'],
    ['handleBuildTestStyleCommit', '../validation/close-phases'],
    ['handleProviderFailover', '../validation/close-phases'],
    // completion-pipeline
    ['recordModelOutcome', '../execution/completion-pipeline'],
    ['recordProviderHealth', '../execution/completion-pipeline'],
    ['fireTerminalTaskHook', '../execution/completion-pipeline'],
    ['handlePostCompletion', '../execution/completion-pipeline'],
    // task-finalizer
    ['finalizeTask', '../execution/task-finalizer'],
    // aider-command
    ['buildAiderCommand', '../providers/aider-command'],
    ['configureAiderHost', '../providers/aider-command'],
    // queue-scheduler
    ['categorizeQueuedTasks', '../execution/queue-scheduler'],
    ['processQueueInternal', '../execution/queue-scheduler'],
    // orphan-cleanup
    ['cleanupOrphanedHostTasks', '../maintenance/orphan-cleanup'],
    ['getStallThreshold', '../maintenance/orphan-cleanup'],
  ];

  // Functions declared with no ...args — they discard arguments
  const noArgFns = new Set([
    'getHostActivity', 'getAllTaskActivity', 'canAcceptTask',
    'registerInstance', 'startInstanceHeartbeat', 'stopInstanceHeartbeat',
    'unregisterInstance', 'getMcpInstanceId',
  ]);

  describe.each(syncSpecs)('%s', (exportName, modPath, targetMethod) => {
    const method = targetMethod || exportName;

    it('delegates to underlying module', () => {
      if (noArgFns.has(exportName)) {
        delegations[exportName]();
        expect(mockModules[modPath][method]).toHaveBeenCalled();
      } else {
        delegations[exportName]('a', 'b', 'c');
        expect(mockModules[modPath][method]).toHaveBeenCalledWith('a', 'b', 'c');
      }
    });

    it('returns the value from the underlying module', () => {
      mockModules[modPath][method].mockReturnValue('test-result');
      expect(delegations[exportName]()).toBe('test-result');
    });
  });

  // Async delegation specs
  const asyncSpecs = [
    ['pollHostActivity', '../utils/host-monitoring'],
    ['probeLocalGpuMetrics', '../utils/host-monitoring'],
    ['probeRemoteGpuMetrics', '../utils/host-monitoring'],
    ['executeApiProvider', '../providers/execution'],
    ['executeOllamaTask', '../providers/execution'],
    ['executeHashlineOllamaTask', '../providers/execution'],
    ['runOutputSafeguards', '../validation/output-safeguards'],
  ];

  const asyncNoArgFns = new Set(['pollHostActivity']);

  describe.each(asyncSpecs)('%s (async)', (exportName, modPath) => {
    it('returns a promise', () => {
      const result = delegations[exportName]('arg');
      expect(result).toBeInstanceOf(Promise);
    });

    it('resolves with the value from the underlying module', async () => {
      mockModules[modPath][exportName].mockResolvedValue('async-result');
      if (asyncNoArgFns.has(exportName)) {
        const result = await delegations[exportName]();
        expect(result).toBe('async-result');
        expect(mockModules[modPath][exportName]).toHaveBeenCalled();
      } else {
        const result = await delegations[exportName]('arg');
        expect(result).toBe('async-result');
        expect(mockModules[modPath][exportName]).toHaveBeenCalledWith('arg');
      }
    });
  });
});
