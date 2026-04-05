'use strict';
/* global describe, it, expect */

const mod = require('../execution/task-decomposition');
const {
  PROVIDER_CLASSES,
  GUIDED_FILE_THRESHOLD,
  GUIDED_MIN_FUNCTIONS,
  getProviderClass,
  shouldDecompose,
} = mod;

// ---------------------------------------------------------------------------
// PROVIDER_CLASSES shape
// ---------------------------------------------------------------------------

describe('PROVIDER_CLASSES', () => {
  const ALL_12 = [
    'codex', 'codex-spark', 'claude-cli',
    'ollama',
    'ollama-cloud', 'cerebras', 'groq', 'deepinfra',
    'google-ai', 'openrouter', 'hyperbolic', 'anthropic',
  ];

  it('contains all 12 expected providers', () => {
    for (const p of ALL_12) {
      expect(Object.prototype.hasOwnProperty.call(PROVIDER_CLASSES, p))
        .toBe(true);
    }
  });

  it('classifies codex, codex-spark, claude-cli as agentic', () => {
    expect(PROVIDER_CLASSES['codex']).toBe('agentic');
    expect(PROVIDER_CLASSES['codex-spark']).toBe('agentic');
    expect(PROVIDER_CLASSES['claude-cli']).toBe('agentic');
  });

  it('classifies ollama as guided', () => {
    expect(PROVIDER_CLASSES['ollama']).toBe('guided');
  });

  it('classifies all cloud inference providers as prompt-only', () => {
    const promptOnly = [
      'ollama-cloud', 'cerebras', 'groq', 'deepinfra',
      'google-ai', 'openrouter', 'hyperbolic', 'anthropic',
    ];
    for (const p of promptOnly) {
      expect(PROVIDER_CLASSES[p]).toBe('prompt-only');
    }
  });
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('exported constants', () => {
  it('GUIDED_FILE_THRESHOLD is 1500', () => {
    expect(GUIDED_FILE_THRESHOLD).toBe(1500);
  });

  it('GUIDED_MIN_FUNCTIONS is 3', () => {
    expect(GUIDED_MIN_FUNCTIONS).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getProviderClass
// ---------------------------------------------------------------------------

describe('getProviderClass', () => {
  it('returns agentic for codex', () => {
    expect(getProviderClass('codex')).toBe('agentic');
  });

  it('returns agentic for codex-spark', () => {
    expect(getProviderClass('codex-spark')).toBe('agentic');
  });

  it('returns agentic for claude-cli', () => {
    expect(getProviderClass('claude-cli')).toBe('agentic');
  });

  it('returns guided for ollama', () => {
    expect(getProviderClass('ollama')).toBe('guided');
  });

  it('returns prompt-only for deepinfra', () => {
    expect(getProviderClass('deepinfra')).toBe('prompt-only');
  });

  it('returns prompt-only for cerebras', () => {
    expect(getProviderClass('cerebras')).toBe('prompt-only');
  });

  it('returns prompt-only for groq', () => {
    expect(getProviderClass('groq')).toBe('prompt-only');
  });

  it('returns prompt-only for google-ai', () => {
    expect(getProviderClass('google-ai')).toBe('prompt-only');
  });

  it('returns prompt-only for openrouter', () => {
    expect(getProviderClass('openrouter')).toBe('prompt-only');
  });

  it('returns prompt-only for hyperbolic', () => {
    expect(getProviderClass('hyperbolic')).toBe('prompt-only');
  });

  it('returns prompt-only for anthropic', () => {
    expect(getProviderClass('anthropic')).toBe('prompt-only');
  });

  it('returns prompt-only for ollama-cloud', () => {
    expect(getProviderClass('ollama-cloud')).toBe('prompt-only');
  });

  it('defaults to prompt-only for unknown provider string', () => {
    expect(getProviderClass('totally-unknown-provider')).toBe('prompt-only');
  });

  it('defaults to prompt-only for null', () => {
    expect(getProviderClass(null)).toBe('prompt-only');
  });

  it('defaults to prompt-only for undefined', () => {
    expect(getProviderClass(undefined)).toBe('prompt-only');
  });

  it('defaults to prompt-only for empty string', () => {
    expect(getProviderClass('')).toBe('prompt-only');
  });
});

// ---------------------------------------------------------------------------
// shouldDecompose — helpers
// ---------------------------------------------------------------------------

function makeTask(description, complexity = 'normal') {
  return { task_description: description, complexity };
}

function makeRouting(provider) {
  return { provider };
}

// ---------------------------------------------------------------------------
// shouldDecompose — agentic providers
// ---------------------------------------------------------------------------

describe('shouldDecompose — agentic providers', () => {
  const agenticProviders = ['codex', 'codex-spark', 'claude-cli'];

  for (const provider of agenticProviders) {
    it(`returns decompose:false for ${provider} even on complex C# task`, () => {
      const result = shouldDecompose(
        makeTask('Refactor the entire WPF application written in C#', 'complex'),
        makeRouting(provider)
      );
      expect(result.decompose).toBe(false);
    });

    it(`returns decompose:false for ${provider} even on JS decompose-verb task`, () => {
      const result = shouldDecompose(
        makeTask('Add logging to all route handlers'),
        makeRouting(provider)
      );
      expect(result.decompose).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// shouldDecompose — prompt-only providers
// ---------------------------------------------------------------------------

describe('shouldDecompose — prompt-only providers', () => {
  it('returns decompose:false for deepinfra regardless of description', () => {
    const result = shouldDecompose(
      makeTask('Add jsdoc comments to every exported function', 'complex'),
      makeRouting('deepinfra')
    );
    expect(result.decompose).toBe(false);
  });

  it('returns decompose:false for groq', () => {
    const result = shouldDecompose(
      makeTask('Refactor the payment module', 'complex'),
      makeRouting('groq')
    );
    expect(result.decompose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldDecompose — guided (ollama), no decompose cases
// ---------------------------------------------------------------------------

describe('shouldDecompose — guided, should NOT decompose', () => {
  it('returns decompose:false for simple task with no patterns', () => {
    const result = shouldDecompose(
      makeTask('Fix typo in README', 'normal'),
      makeRouting('ollama')
    );
    expect(result.decompose).toBe(false);
  });

  it('returns decompose:false for complex task with no C# or JS verb patterns', () => {
    const result = shouldDecompose(
      makeTask('Implement a new caching layer for the API', 'complex'),
      makeRouting('ollama')
    );
    expect(result.decompose).toBe(false);
  });

  it('returns decompose:false for C# match on normal (non-complex) task', () => {
    // C# pattern requires complexity === 'complex'
    const result = shouldDecompose(
      makeTask('Update the WPF button color in MainWindow.xaml', 'normal'),
      makeRouting('ollama')
    );
    expect(result.decompose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldDecompose — guided (ollama), C# decompose
// ---------------------------------------------------------------------------

describe('shouldDecompose — guided + complex C# task', () => {
  const csharpDescriptions = [
    'Refactor the data access layer in the .csproj project',
    'Add error handling to the C# service classes',
    'Update WPF data bindings across the application',
    'Migrate Blazor components to new lifecycle API',
    'Add NuGet package references and update ASP.NET middleware',
    'Refactor WinUI page navigation flow',
    'Add MAUI platform handlers for Android and iOS',
  ];

  for (const desc of csharpDescriptions) {
    it(`detects C# in: "${desc.slice(0, 60)}"`, () => {
      const result = shouldDecompose(
        makeTask(desc, 'complex'),
        makeRouting('ollama')
      );
      expect(result.decompose).toBe(true);
      expect(result.type).toBe('csharp');
    });
  }
});

// ---------------------------------------------------------------------------
// shouldDecompose — guided (ollama), JS decompose-verb patterns
// ---------------------------------------------------------------------------

describe('shouldDecompose — guided + JS decompose-verb patterns', () => {
  const jsVerbDescriptions = [
    'Add jsdoc to all exported functions in utils.js',
    'Add docs for the new API endpoints',
    'Add documentation to the authentication module',
    'Add logging to the request pipeline',
    'Add error handling to all async route handlers',
    'Refactor the database query helpers',
    'Cleanup the unused imports in the components folder',
    'Clean up the test helpers',
    'Add types to the legacy JavaScript files',
    'Add comments to the complex regex patterns',
    'Lint fix the entire src/ directory',
    'Add tests for the utility functions',
  ];

  for (const desc of jsVerbDescriptions) {
    it(`detects JS verb in: "${desc.slice(0, 60)}"`, () => {
      const result = shouldDecompose(
        makeTask(desc, 'normal'), // complexity doesn't matter for JS verbs
        makeRouting('ollama')
      );
      expect(result.decompose).toBe(true);
      expect(result.type).toBe('js');
    });
  }

  it('JS verb triggers decompose even on normal complexity task', () => {
    const result = shouldDecompose(
      makeTask('Refactor the auth middleware', 'normal'),
      makeRouting('ollama')
    );
    expect(result.decompose).toBe(true);
    expect(result.type).toBe('js');
  });
});

// ---------------------------------------------------------------------------
// shouldDecompose — edge cases
// ---------------------------------------------------------------------------

describe('shouldDecompose — edge cases', () => {
  it('handles null taskInfo gracefully', () => {
    const result = shouldDecompose(null, makeRouting('ollama'));
    expect(result.decompose).toBe(false);
  });

  it('handles null routingResult gracefully', () => {
    const result = shouldDecompose(makeTask('Some task'), null);
    // null provider → prompt-only → no decompose
    expect(result.decompose).toBe(false);
  });

  it('handles missing provider in routingResult gracefully', () => {
    const result = shouldDecompose(makeTask('Add jsdoc to utils.js'), {});
    // undefined provider → prompt-only → no decompose
    expect(result.decompose).toBe(false);
  });

  it('always returns an object with decompose boolean and reason string', () => {
    const result = shouldDecompose(makeTask('simple task'), makeRouting('codex'));
    expect(typeof result.decompose).toBe('boolean');
    expect(typeof result.reason).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// decomposeTask
// ---------------------------------------------------------------------------

describe('decomposeTask', () => {
  it('locks sub-tasks to parent provider', () => {
    const result = mod.decomposeTask(
      { task: 'refactor server/big-file.js', working_directory: '/tmp/test', files: [] },
      { provider: 'ollama', model: 'qwen3-coder:30b' },
      { subtasks: ['Fix function A', 'Fix function B'], version_intent: 'fix', ui_review: false }
    );
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].provider).toBe('ollama');
    expect(result.tasks[0].model).toBe('qwen3-coder:30b');
    expect(result.tasks[0].version_intent).toBe('fix');
    expect(result.tasks[0].metadata.decomposed).toBe(true);
    expect(result.tasks[0].metadata.ui_review).toBe(false);
    expect(result.tasks[1].provider).toBe('ollama');
  });

  it('includes parent reference in sub-task metadata', () => {
    const result = mod.decomposeTask(
      { task: 'refactor', working_directory: '/tmp', files: [] },
      { provider: 'ollama' },
      { subtasks: ['A'], version_intent: 'fix', parent_task_id: 'parent-123', ui_review: false }
    );
    expect(result.tasks[0].metadata.parent_task_id).toBe('parent-123');
  });

  it('returns empty tasks array when no subtasks provided', () => {
    const result = mod.decomposeTask(
      { task: 'small fix', working_directory: '/tmp', files: [] },
      { provider: 'ollama' },
      { subtasks: [], version_intent: 'fix', ui_review: false }
    );
    expect(result.tasks).toHaveLength(0);
  });

  it('sets batch_index sequentially', () => {
    const result = mod.decomposeTask(
      { task: 'refactor', working_directory: '/tmp', files: [] },
      { provider: 'ollama' },
      { subtasks: ['A', 'B', 'C'], version_intent: 'fix', ui_review: false }
    );
    expect(result.tasks[0].metadata.batch_index).toBe(0);
    expect(result.tasks[1].metadata.batch_index).toBe(1);
    expect(result.tasks[2].metadata.batch_index).toBe(2);
  });

  it('defaults model to null when not provided', () => {
    const result = mod.decomposeTask(
      { task: 'fix', working_directory: '/tmp', files: [] },
      { provider: 'ollama' },
      { subtasks: ['A'], version_intent: 'fix', ui_review: false }
    );
    expect(result.tasks[0].model).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// integration: template + decomposition interaction
// ---------------------------------------------------------------------------

describe('integration: template + decomposition interaction', () => {
  it('codex via template → no decomposition even for complex tasks', () => {
    const result = mod.shouldDecompose(
      {
        task: 'refactor server/handlers/integration/routing.js — complex multi-function cleanup',
        complexity: 'complex',
        files: ['server/handlers/integration/routing.js'],
        working_directory: '/tmp/test',
      },
      { provider: 'codex', template: 'Codex Primary' }
    );
    expect(result.decompose).toBe(false);
    expect(result.reason).toContain('agentic');
  });

  it('ollama via template → decomposition possible for huge C# tasks', () => {
    const result = mod.shouldDecompose(
      {
        task: 'implement a full WPF dashboard with MVVM pattern in App.xaml.cs',
        complexity: 'complex',
        files: ['App.xaml.cs'],
        working_directory: '/tmp/test',
      },
      { provider: 'ollama', template: 'All Local' }
    );
    expect(result.decompose).toBe(true);
    expect(result.type).toBe('csharp');
  });

  it('cerebras via template → no decomposition (prompt-only)', () => {
    const result = mod.shouldDecompose(
      {
        task: 'refactor everything in the project',
        complexity: 'complex',
        files: [],
        working_directory: '/tmp/test',
      },
      { provider: 'cerebras', template: 'Cloud Sprint' }
    );
    expect(result.decompose).toBe(false);
    expect(result.reason).toContain('prompt-only');
  });

  it('claude-cli via template → no decomposition (agentic)', () => {
    const result = mod.shouldDecompose(
      {
        task: 'add error handling to all .cs files in the project',
        complexity: 'complex',
        files: ['App.xaml.cs'],
        working_directory: '/tmp/test',
      },
      { provider: 'claude-cli', template: 'Quality First' }
    );
    expect(result.decompose).toBe(false);
    expect(result.reason).toContain('agentic');
  });

  it('codex-spark via template → no decomposition (agentic)', () => {
    const result = mod.shouldDecompose(
      {
        task: 'refactor and add tests for server/big-file.js',
        complexity: 'complex',
        files: ['server/big-file.js'],
      },
      { provider: 'codex-spark' }
    );
    expect(result.decompose).toBe(false);
  });
});
