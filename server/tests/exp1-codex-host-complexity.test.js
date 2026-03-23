'use strict';

const hostComplexity = require('../db/host-complexity');
const { DEFAULT_FALLBACK_MODEL } = require('../constants');

function createMockDb() {
  return {
    getConfig() {
      return null;
    },
    prepare() {
      return {
        get() {
          return null;
        }
      };
    }
  };
}

describe('host-complexity determineTaskComplexity', () => {
  it.each([
    'write a guide for setting up the task router',
    'write a README for the server package',
  ])('returns simple for documentation tasks: %s', (taskDescription) => {
    expect(hostComplexity.determineTaskComplexity(taskDescription, ['docs.md'])).toBe('simple');
  });

  it('returns normal for test writing tasks', () => {
    expect(hostComplexity.determineTaskComplexity('write xunit tests for host selection')).toBe('normal');
  });

  it('returns normal for stub fill tasks', () => {
    expect(hostComplexity.determineTaskComplexity('fill in method bodies for the cache helpers')).toBe('normal');
  });

  it.each([
    'create a notification service and wire it to dependency injection',
    'implement the provider and connect it to the scheduler',
  ])('returns complex for multi-step tasks: %s', (taskDescription) => {
    expect(hostComplexity.determineTaskComplexity(taskDescription, ['a.js', 'b.js'])).toBe('complex');
  });

  it('returns complex when the description has 5 or more bullet points', () => {
    const taskDescription = [
      '- gather inputs',
      '- normalize values',
      '- validate dependencies',
      '- update handlers',
      '- record outcomes',
    ].join('\n');

    expect(hostComplexity.determineTaskComplexity(taskDescription, ['a.js', 'b.js'])).toBe('complex');
  });

  it('returns normal for simple code generation', () => {
    expect(hostComplexity.determineTaskComplexity('create a class named TaskRouter')).toBe('normal');
  });

  it('returns normal when no pattern matches', () => {
    const taskDescription = 'adjust the module so naming stays consistent with current conventions';

    expect(hostComplexity.determineTaskComplexity(taskDescription, ['a.js', 'b.js'])).toBe('normal');
  });
});

describe('host-complexity getModelTierForComplexity', () => {
  beforeEach(() => {
    hostComplexity.setDb(createMockDb());
  });

  it.each([
    ['simple', 'fast', DEFAULT_FALLBACK_MODEL],
    ['normal', 'balanced', DEFAULT_FALLBACK_MODEL],
    ['complex', 'quality', DEFAULT_FALLBACK_MODEL],
  ])('returns the expected tier config for %s complexity', (complexity, tier, modelConfig) => {
    expect(hostComplexity.getModelTierForComplexity(complexity)).toMatchObject({
      tier,
      modelConfig,
    });
  });
});

describe('host-complexity decomposeTask', () => {
  it('returns null when no decomposition pattern matches', () => {
    expect(hostComplexity.decomposeTask('rename the provider for clarity', 'src/services')).toBeNull();
  });

  it('returns subtasks when a decomposition pattern matches', () => {
    expect(
      hostComplexity.decomposeTask('create a notification service and wire it', 'src/services')
    ).toEqual([
      'Create file src/services/INotification.cs with interface INotification defining the contract',
      'Create file src/services/Notification.cs implementing INotification with core methods',
      'Register Notification in dependency injection container (find startup/DI config in src/services)',
    ]);
  });
});
