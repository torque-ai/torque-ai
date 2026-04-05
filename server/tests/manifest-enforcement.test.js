'use strict';

describe('manifest-enforcement hook', () => {
  let manifestEnforcement;
  let mockPatterns;

  beforeEach(() => {
    vi.resetModules();

    mockPatterns = {
      detectVisualSurfaces: vi.fn().mockReturnValue([]),
      loadManifest: vi.fn().mockReturnValue(null),
      findUnregistered: vi.fn().mockReturnValue([]),
      suggestManifestEntry: vi.fn().mockReturnValue({ id: 'test', label: 'Test' })
    };

    vi.doMock('../hooks/manifest-patterns', () => mockPatterns);
    manifestEnforcement = require('../hooks/manifest-enforcement');
  });

  it('exports a createHook factory', () => {
    expect(typeof manifestEnforcement.createHook).toBe('function');
  });

  it('hook returns null when task has no changed_files', async () => {
    const hook = manifestEnforcement.createHook();
    const result = await hook({ taskId: '1', task: { working_directory: '/proj' } });
    expect(result).toBeNull();
  });

  it('hook returns null when no manifest exists', async () => {
    mockPatterns.loadManifest.mockReturnValue(null);
    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: '1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });
    expect(result).toBeNull();
  });

  it('hook detects unregistered surfaces and returns approval gate info', async () => {
    const manifest = { framework: 'wpf', sections: [] };
    mockPatterns.loadManifest.mockReturnValue(manifest);
    mockPatterns.detectVisualSurfaces.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockPatterns.findUnregistered.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);

    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toEqual({
      gate: 'manifest_update',
      task_id: 'task-1',
      unregistered: [{ file: 'src/Views/New.xaml', type: 'Window', id: 'New' }],
      suggested_entries: [{ id: 'test', label: 'Test' }],
      message: expect.stringContaining('New visual surface')
    });
  });

  it('hook returns null when all surfaces are registered', async () => {
    const manifest = { framework: 'wpf', sections: [{ id: 'new' }] };
    mockPatterns.loadManifest.mockReturnValue(manifest);
    mockPatterns.detectVisualSurfaces.mockReturnValue([
      { file: 'src/Views/New.xaml', type: 'Window', id: 'New' }
    ]);
    mockPatterns.findUnregistered.mockReturnValue([]);

    const hook = manifestEnforcement.createHook();
    const result = await hook({
      taskId: 'task-1',
      task: { working_directory: '/proj' },
      changed_files: ['src/Views/New.xaml']
    });

    expect(result).toBeNull();
  });
});
